import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, freemem, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { HarnessError, type DownloadState, type GgufMeta, type HardwareInfo, type HfFile, type HfModel, type LocalEngineInfo, type LocalModel, type ModelEstimate, type Settings } from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import type { Logger } from '../log/logger.ts';
import type { SecretStore } from '../security/secrets.ts';
import { readGgufMeta } from './gguf.ts';

interface State {
  models: Record<string, { repo: string | null; sha256: string | null; addedAt: string }>;
  engine: { path: string | null; version: string | null; source: 'download' | 'custom' | null };
}

const QUANT = /(IQ\d_[A-Z]+|Q\d_K_[SML]|Q\d_K|Q\d_\d|Q\d|BF16|F16|F32)(?=[.-])/i;
const SPLIT = /-\d{5}-of-\d{5}\.gguf$/i;
const MB = 1024 * 1024;

export function quantOf(name: string): string | null {
  return QUANT.exec(name)?.[1]?.toUpperCase() ?? null;
}

/** Estimation mémoire : poids (taille du fichier) + cache KV (f16) + marge de calcul ; couches GPU selon la VRAM libre. */
export function estimateModel(sizeBytes: number, meta: GgufMeta | null, contextSize: number, hw: HardwareInfo): ModelEstimate {
  const weightsMb = Math.round(sizeBytes / MB);
  const layers = meta?.blockCount ?? null;
  const headDim = meta?.embeddingLength && meta.headCount ? meta.embeddingLength / meta.headCount : null;
  const kvHeads = meta?.headCountKv ?? meta?.headCount ?? null;
  const ctx = Math.min(contextSize, meta?.contextLength ?? contextSize);
  const kvCacheMb = layers && headDim && kvHeads ? Math.round((2 * layers * ctx * kvHeads * headDim * 2) / MB) : 0;
  const overheadMb = 300 + Math.round(ctx / 32);
  const totalMb = weightsMb + kvCacheMb + overheadMb;
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramFreeMb));
  let gpuLayers = 0;
  let fits: ModelEstimate['fits'];
  if (vram > totalMb) {
    gpuLayers = layers ?? 999;
    fits = 'gpu';
  } else if (vram > overheadMb + kvCacheMb && layers) {
    gpuLayers = Math.max(0, Math.floor(((vram - overheadMb - kvCacheMb) / weightsMb) * layers));
    fits = gpuLayers > 0 ? 'partial' : hw.ramFreeMb > totalMb ? 'cpu' : 'too_large';
  } else fits = hw.ramFreeMb + vram > totalMb || hw.ramTotalMb > totalMb * 1.1 ? 'cpu' : 'too_large';
  const note = !meta ? 'Estimation à partir de la taille du fichier (métadonnées lues après téléchargement).' : !kvCacheMb ? 'Cache de contexte non estimé (métadonnées incomplètes).' : `Contexte ${ctx} tokens.`;
  return { weightsMb, kvCacheMb, overheadMb, totalMb, totalLayers: layers, gpuLayers, fits, note };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const quote = (a: string) => (/^[\w@./:=+\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/**
 * Modèles locaux : fichiers GGUF (catalogue Hugging Face, import), téléchargements reprenables
 * vérifiés par SHA-256, estimation mémoire, moteur llama.cpp (`llama-server`) démarré à la demande
 * sur 127.0.0.1 et arrêté après inactivité.
 */
export class LocalModelService {
  private readonly modelsDir: string;
  private readonly engineDir: string;
  private readonly stateFile: string;
  private readonly metaCache = new Map<string, { mtime: number; meta: GgufMeta | null }>();
  private readonly downloads = new Map<string, { state: DownloadState; controller: AbortController }>();
  private hwCache: { at: number; info: HardwareInfo } | null = null;
  private server: { proc: ChildProcess; model: string; port: number; contextSize: number; gpuLayers: number; ready: Promise<void>; stderr: string } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      dir: string;
      events: EventBus;
      settings: () => Settings;
      secrets: SecretStore;
      logger: Logger;
      hfBase?: string;
      githubApi?: string;
    },
  ) {
    this.modelsDir = join(deps.dir, 'models');
    this.engineDir = join(deps.dir, 'engines');
    this.stateFile = join(deps.dir, 'local.json');
    mkdirSync(this.modelsDir, { recursive: true });
  }

  private get hf() {
    return this.deps.hfBase ?? 'https://huggingface.co';
  }

  private state(): State {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as State;
    } catch {
      return { models: {}, engine: { path: null, version: null, source: null } };
    }
  }

  private save(s: State): void {
    writeFileSync(this.stateFile, JSON.stringify(s, null, 2), 'utf8');
  }

  private changed(): void {
    this.deps.events.emit('local.changed', { models: this.models(), engine: this.engine() });
  }

  // ---------- Matériel ----------

  hardware(): HardwareInfo {
    if (this.hwCache && Date.now() - this.hwCache.at < 30_000) return this.hwCache.info;
    const gpus: HardwareInfo['gpus'] = [];
    try {
      const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      if (r.status === 0) {
        for (const line of r.stdout.split('\n').filter((l) => l.trim())) {
          const [name, total, free] = line.split(',').map((x) => x.trim());
          gpus.push({ name: name ?? 'GPU', vramTotalMb: Number(total) || 0, vramFreeMb: Number(free) || 0, source: 'nvidia-smi' });
        }
      }
    } catch {
      /* pas de GPU NVIDIA détectable */
    }
    const info: HardwareInfo = { ramTotalMb: Math.round(totalmem() / MB), ramFreeMb: Math.round(freemem() / MB), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? '', gpus };
    this.hwCache = { at: Date.now(), info };
    return info;
  }

  // ---------- Modèles installés ----------

  private meta(path: string): GgufMeta | null {
    const mtime = statSync(path).mtimeMs;
    const cached = this.metaCache.get(path);
    if (cached && cached.mtime === mtime) return cached.meta;
    let meta: GgufMeta | null = null;
    try {
      meta = readGgufMeta(path);
    } catch (e) {
      this.deps.logger.warn('local', 'Métadonnées GGUF illisibles', { file: basename(path), error: (e as Error).message });
    }
    this.metaCache.set(path, { mtime, meta });
    return meta;
  }

  models(): LocalModel[] {
    const s = this.state();
    return readdirSync(this.modelsDir)
      .filter((f) => f.toLowerCase().endsWith('.gguf'))
      .map((id) => {
        const path = join(this.modelsDir, id);
        const info = s.models[id];
        return { id, sizeBytes: statSync(path).size, sha256: info?.sha256 ?? null, repo: info?.repo ?? null, quant: quantOf(id), meta: this.meta(path), addedAt: info?.addedAt ?? statSync(path).mtime.toISOString() };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  path(id: string): string {
    if (!/^[\w.\- ]+\.gguf$/i.test(id) || id.includes('..')) throw new HarnessError('invalid_argument', 'Modèle local invalide');
    const p = join(this.modelsDir, id);
    if (!existsSync(p)) throw new HarnessError('not_found', `Modèle local « ${id} » introuvable (Réglages › Modèles locaux).`);
    return p;
  }

  async importFile(source: string): Promise<LocalModel> {
    if (!source.toLowerCase().endsWith('.gguf') || !existsSync(source)) throw new HarnessError('invalid_argument', 'Fichier .gguf introuvable');
    readGgufMeta(source);
    const id = basename(source).replace(/[^\w.\- ]+/g, '_');
    await copyFile(source, join(this.modelsDir, id));
    const s = this.state();
    s.models[id] = { repo: null, sha256: null, addedAt: new Date().toISOString() };
    this.save(s);
    this.changed();
    return this.models().find((m) => m.id === id)!;
  }

  async deleteModel(id: string): Promise<void> {
    const p = this.path(id);
    if (this.server?.model === id) await this.stop();
    unlinkSync(p);
    const s = this.state();
    delete s.models[id];
    this.save(s);
    this.changed();
  }

  estimate(id: string, contextSize?: number): ModelEstimate {
    const p = this.path(id);
    return estimateModel(statSync(p).size, this.meta(p), contextSize ?? this.deps.settings().local.contextSize, this.hardware());
  }

  // ---------- Hugging Face ----------

  private async hfHeaders(): Promise<Record<string, string>> {
    const token = await this.deps.secrets.get('hf:token');
    return { 'user-agent': 'MonolithHarness/3', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  async setHfToken(token: string | null): Promise<{ hasToken: boolean }> {
    if (token && token.trim()) {
      if (!/^hf_[\w]{10,}$/.test(token.trim())) throw new HarnessError('invalid_argument', 'Jeton Hugging Face invalide (hf_…)');
      await this.deps.secrets.set('hf:token', token.trim());
      return { hasToken: true };
    }
    this.deps.secrets.delete('hf:token');
    return { hasToken: false };
  }

  async hfSearch(query: string): Promise<HfModel[]> {
    const q = query.trim();
    const url = `${this.hf}/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=40`;
    const r = await fetch(url, { headers: await this.hfHeaders(), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new HarnessError('provider_bad_request', `Hugging Face : HTTP ${r.status}`);
    const list = (await r.json()) as { id: string; downloads?: number; likes?: number; lastModified?: string; gated?: boolean | string }[];
    return list.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, updatedAt: m.lastModified ?? null, gated: !!m.gated && m.gated !== 'false' }));
  }

  async hfFiles(repo: string, contextSize?: number): Promise<HfFile[]> {
    if (!/^\w[\w.-]*\/\w[\w.-]*$/.test(repo) || repo.includes('..')) throw new HarnessError('invalid_argument', 'Dépôt invalide (organisation/modèle)');
    const r = await fetch(`${this.hf}/api/models/${repo}?blobs=true`, { headers: await this.hfHeaders(), signal: AbortSignal.timeout(20_000) });
    if (r.status === 401 || r.status === 403) throw new HarnessError('provider_auth', 'Modèle protégé : acceptez ses conditions sur Hugging Face et enregistrez un jeton.');
    if (!r.ok) throw new HarnessError('provider_bad_request', `Hugging Face : HTTP ${r.status}`);
    const body = (await r.json()) as { siblings?: { rfilename: string; size?: number; lfs?: { size?: number; sha256?: string; oid?: string } }[] };
    const hw = this.hardware();
    const ctx = contextSize ?? this.deps.settings().local.contextSize;
    return (body.siblings ?? [])
      .filter((f) => f.rfilename.toLowerCase().endsWith('.gguf') && !SPLIT.test(f.rfilename) && !/mmproj/i.test(f.rfilename))
      .map((f) => {
        const size = f.lfs?.size ?? f.size ?? 0;
        return { name: f.rfilename, size, sha256: f.lfs?.sha256 ?? f.lfs?.oid ?? null, quant: quantOf(f.rfilename), estimate: size ? estimateModel(size, null, ctx, hw) : null };
      })
      .sort((a, b) => a.size - b.size);
  }

  listDownloads(): DownloadState[] {
    return [...this.downloads.values()].map((d) => ({ ...d.state }));
  }

  cancelDownload(id: string): void {
    this.downloads.get(id)?.controller.abort();
  }

  /** Téléchargement reprenable (fichier .part), espace disque vérifié, empreinte SHA-256 contrôlée. */
  async download(repo: string, file: string): Promise<DownloadState> {
    const files = await this.hfFiles(repo);
    const target = files.find((f) => f.name === file);
    if (!target) throw new HarnessError('not_found', `Fichier ${file} absent du dépôt ${repo}`);
    const id = basename(file);
    if ([...this.downloads.values()].some((d) => d.state.file === file && d.state.status === 'running')) throw new HarnessError('busy', 'Téléchargement déjà en cours');
    const dest = join(this.modelsDir, id);
    const part = `${dest}.part`;
    const already = existsSync(part) ? statSync(part).size : 0;
    try {
      const free = statfsSync(this.modelsDir);
      if (free.bavail * free.bsize < target.size - already + 512 * MB) throw new HarnessError('invalid_argument', `Espace disque insuffisant : ${Math.round(target.size / MB)} Mo nécessaires.`);
    } catch (e) {
      if (e instanceof HarnessError) throw e;
    }
    const controller = new AbortController();
    const state: DownloadState = { id: randomUUID(), repo, file, total: target.size, received: already, status: 'running', error: null, speedBps: 0 };
    this.downloads.set(state.id, { state, controller });
    const emit = () => this.deps.events.emit('local.download', { ...state });
    emit();
    void (async () => {
      try {
        const headers = { ...(await this.hfHeaders()), ...(already ? { range: `bytes=${already}-` } : {}) };
        const r = await fetch(`${this.hf}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`, { headers, signal: controller.signal, redirect: 'follow' });
        if (!r.ok || !r.body) throw new HarnessError('provider_bad_request', `Téléchargement : HTTP ${r.status}`);
        const resumed = r.status === 206;
        if (!resumed) state.received = 0;
        const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        let lastEmit = Date.now();
        let windowBytes = 0;
        for await (const chunk of r.body) {
          if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
          state.received += chunk.length;
          windowBytes += chunk.length;
          if (Date.now() - lastEmit > 500) {
            state.speedBps = Math.round((windowBytes * 1000) / (Date.now() - lastEmit));
            windowBytes = 0;
            lastEmit = Date.now();
            emit();
          }
        }
        await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
        state.status = 'verifying';
        emit();
        if (target.sha256) {
          const hash = createHash('sha256');
          await new Promise<void>((res, rej) => createReadStream(part).on('data', (d) => hash.update(d)).on('end', res).on('error', rej));
          if (hash.digest('hex') !== target.sha256) {
            unlinkSync(part);
            throw new HarnessError('provider_stream', 'Empreinte SHA-256 incorrecte : fichier supprimé, relancez le téléchargement.');
          }
        }
        await rename(part, dest);
        const s = this.state();
        s.models[id] = { repo, sha256: target.sha256, addedAt: new Date().toISOString() };
        this.save(s);
        state.status = 'done';
        this.changed();
      } catch (e) {
        state.status = controller.signal.aborted ? 'cancelled' : 'error';
        state.error = controller.signal.aborted ? null : (e as Error).message;
      } finally {
        emit();
      }
    })();
    return { ...state };
  }

  // ---------- Moteur llama.cpp ----------

  engine(): LocalEngineInfo {
    const e = this.state().engine;
    const s = this.server;
    return { installed: !!e.path && existsSync(e.path), path: e.path, version: e.version, source: e.source, running: s ? { model: s.model, port: s.port, contextSize: s.contextSize, gpuLayers: s.gpuLayers } : null };
  }

  private version(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const win = process.platform === 'win32';
      execFile(win ? quote(path) : path, ['--version'], { timeout: 15_000, windowsHide: true, shell: win }, (_e, stdout, stderr) => {
        const m = /version:\s*([^\n\r]+)/i.exec(`${stdout}\n${stderr}`);
        resolve(m?.[1]?.trim() ?? null);
      });
    });
  }

  async setEnginePath(path: string | null): Promise<LocalEngineInfo> {
    const s = this.state();
    if (path === null) s.engine = { path: null, version: null, source: null };
    else {
      if (!existsSync(path) || !statSync(path).isFile()) throw new HarnessError('invalid_argument', `Exécutable introuvable : ${path}`);
      const version = await this.version(path);
      if (!version) throw new HarnessError('invalid_argument', 'Ce fichier ne répond pas comme llama-server (--version).');
      s.engine = { path, version, source: 'custom' };
    }
    await this.stop();
    this.save(s);
    this.changed();
    return this.engine();
  }

  /** Installe la dernière version officielle de llama.cpp (GitHub), vérifiée par l'empreinte publiée. */
  async installEngine(backend: 'cpu' | 'cuda' | 'vulkan'): Promise<LocalEngineInfo> {
    const api = this.deps.githubApi ?? 'https://api.github.com';
    const r = await fetch(`${api}/repos/ggml-org/llama.cpp/releases/latest`, { headers: { 'user-agent': 'MonolithHarness/3', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new HarnessError('provider_bad_request', `GitHub : HTTP ${r.status}`);
    const rel = (await r.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; size: number; digest?: string }[] };
    const plat = process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'ubuntu' : null;
    if (!plat || process.arch !== 'x64') throw new HarnessError('unavailable', 'Installation automatique disponible pour Windows et Linux x64 ; indiquez sinon le chemin de llama-server.');
    const want = plat === 'win' ? (backend === 'cuda' ? /bin-win-cuda-12[\d.]*-x64\.zip$/ : backend === 'vulkan' ? /bin-win-vulkan-x64\.zip$/ : /bin-win-cpu-x64\.zip$/) : backend === 'vulkan' ? /bin-ubuntu-vulkan-x64\.zip$/ : /bin-ubuntu-x64\.zip$/;
    const asset = rel.assets.find((a) => want.test(a.name));
    if (!asset) throw new HarnessError('unavailable', `Aucun binaire ${backend} pour cette plateforme dans la version ${rel.tag_name}.`);
    if (!asset.digest?.startsWith('sha256:')) throw new HarnessError('unavailable', 'Empreinte non publiée pour ce binaire : installation refusée (indiquez le chemin d’un llama-server de confiance).');
    const extra = backend === 'cuda' && plat === 'win' ? rel.assets.find((a) => /^cudart-llama-bin-win-cuda-12[\d.]*-x64\.zip$/.test(a.name)) : undefined;
    const dir = join(this.engineDir, `llama.cpp-${rel.tag_name}-${backend}`);
    mkdirSync(dir, { recursive: true });
    for (const a of [asset, extra].filter((x): x is NonNullable<typeof x> => !!x)) {
      const zip = join(dir, a.name);
      const res = await fetch(a.browser_download_url, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new HarnessError('provider_bad_request', `Téléchargement de ${a.name} : HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (a.digest && createHash('sha256').update(buf).digest('hex') !== a.digest.slice(7)) throw new HarnessError('provider_stream', `Empreinte incorrecte pour ${a.name}`);
      writeFileSync(zip, buf);
      const x = process.platform === 'win32' ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], { windowsHide: true }) : spawnSync('unzip', ['-o', zip, '-d', dir]);
      if (x.status !== 0) throw new HarnessError('internal', `Extraction de ${a.name} impossible (${x.stderr?.toString().slice(0, 200) ?? ''})`);
      rmSync(zip, { force: true });
    }
    const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const find = (d: string): string | null => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (n === exe) return p;
        if (statSync(p).isDirectory()) {
          const f = find(p);
          if (f) return f;
        }
      }
      return null;
    };
    const path = find(dir);
    if (!path) throw new HarnessError('internal', 'llama-server introuvable dans l’archive');
    const s = this.state();
    s.engine = { path, version: (await this.version(path)) ?? rel.tag_name, source: 'download' };
    this.save(s);
    this.changed();
    return this.engine();
  }

  /** Serveur prêt pour ce modèle (démarré, ou redémarré avec d'autres paramètres). */
  async ensureRunning(model: string, signal: AbortSignal): Promise<number> {
    const engine = this.state().engine;
    if (!engine.path || !existsSync(engine.path)) throw new HarnessError('unavailable', 'Moteur llama.cpp non installé : Réglages › Modèles locaux.');
    const settings = this.deps.settings().local;
    const path = this.path(model);
    const meta = this.meta(path);
    const contextSize = Math.min(settings.contextSize, meta?.contextLength ?? settings.contextSize);
    const gpuLayers = settings.gpuLayers >= 0 ? settings.gpuLayers : estimateModel(statSync(path).size, meta, contextSize, this.hardware()).gpuLayers;
    const s = this.server;
    if (s && s.model === model && s.contextSize === contextSize && s.gpuLayers === gpuLayers && s.proc.exitCode === null) {
      await s.ready;
      this.touch();
      return s.port;
    }
    await this.stop();
    const port = await freePort();
    const args = ['-m', path, '--host', '127.0.0.1', '--port', String(port), '-c', String(contextSize), '-ngl', String(gpuLayers), '--jinja', ...(settings.threads > 0 ? ['-t', String(settings.threads)] : [])];
    const win = process.platform === 'win32';
    const proc = win ? spawn([engine.path, ...args].map(quote).join(' '), [], { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(engine.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const server = { proc, model, port, contextSize, gpuLayers, stderr: '', ready: Promise.resolve() };
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => (server.stderr = (server.stderr + d).slice(-4000)));
    proc.stdout?.on('data', () => undefined);
    server.ready = (async () => {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new HarnessError('cancelled', 'Chargement annulé');
        if (proc.exitCode !== null) throw new HarnessError('provider_unreachable', `llama-server s’est arrêté (code ${proc.exitCode}) : ${server.stderr.trim().split('\n').slice(-3).join(' ')}`);
        const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
        if (ok) return;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new HarnessError('provider_timeout', 'Le modèle local n’a pas fini de se charger.');
    })();
    this.server = server;
    this.changed();
    try {
      await server.ready;
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.deps.logger.info('local', 'Modèle local chargé', { model, contextSize, gpuLayers });
    this.touch();
    this.changed();
    return port;
  }

  /** Arrêt après inactivité. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = this.deps.settings().local.idleUnloadMin;
    if (minutes > 0) {
      this.idleTimer = setTimeout(() => void this.stop(), minutes * 60_000);
      this.idleTimer.unref?.();
    }
  }

  async stop(): Promise<LocalEngineInfo> {
    const s = this.server;
    this.server = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (s && s.proc.exitCode === null) {
      const done = new Promise<void>((r) => {
        const timer = setTimeout(r, 5000);
        s.proc.once('exit', () => (clearTimeout(timer), r()));
      });
      if (process.platform === 'win32' && s.proc.pid) spawnSync('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else s.proc.kill();
      await done;
      this.changed();
    }
    return this.engine();
  }

  async dispose(): Promise<void> {
    for (const d of this.downloads.values()) d.controller.abort();
    await this.stop();
  }
}
