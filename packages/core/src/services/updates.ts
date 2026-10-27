import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, UPDATE_REPOSITORY, type Settings, type UpdateRelease, type UpdateState } from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import type { Logger } from '../log/logger.ts';
import { UPDATER_SCRIPT } from '../desktop/updater-script.ts';

const MAX_SIZE = 1024 * 1024 * 1024;
const CHECK_EVERY_MS = 2 * 60 * 60_000;
const OFFICIAL_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** Ordre SemVer (préversions comprises : 3.0.0-alpha.10 > 3.0.0-alpha.9, 3.0.0 > 3.0.0-beta.1). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Paquet attendu pour ce système (archive portable Windows ; AppImage Linux, signalé seulement). */
function assetPattern(platform: NodeJS.Platform): RegExp | null {
  if (platform === 'win32') return /^MonolithHarness-v[0-9A-Za-z.-]+-win-x64\.zip$/;
  if (platform === 'linux') return /^MonolithHarness-v[0-9A-Za-z.-]+-linux-x64\.AppImage$/;
  return null;
}

export interface UpdateJob {
  script: string;
  zip: string;
  sha256: string;
  version: string;
  /** now : redémarrage immédiat ; exit : installation à la fermeture de Monolith. */
  when: 'now' | 'exit';
}

export interface UpdateServiceOptions {
  dir: string;
  current: string;
  events: EventBus;
  logger: Logger;
  settings: () => Settings;
  installable: { ok: boolean; reason: string | null };
  /** Installation confiée à l'hôte (processus détaché, fermeture de l'application). */
  install: (job: UpdateJob) => Promise<void>;
  backup: () => void;
  notify: (title: string, body: string) => void;
  repository?: string;
  apiBase?: string;
  downloadBase?: string;
  platform?: NodeJS.Platform;
}

/**
 * Mises à jour depuis les versions GitHub : vérification, téléchargement vérifié par l'empreinte
 * SHA-256 publiée par GitHub, sauvegarde des données puis installation par l'hôte.
 */
export class UpdateService {
  private readonly st: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private notified = new Set<string>();
  private busy: Promise<unknown> | null = null;
  private readonly repo: string;
  private readonly api: string;
  private readonly downloads: string;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly o: UpdateServiceOptions) {
    this.repo = o.repository ?? UPDATE_REPOSITORY;
    this.api = (o.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.downloads = (o.downloadBase ?? 'https://github.com').replace(/\/+$/, '');
    this.platform = o.platform ?? process.platform;
    this.st = { status: 'idle', current: o.current, release: null, progress: null, error: null, checkedAt: null, installable: o.installable.ok, installReason: o.installable.reason, lastResult: this.readResult() };
  }

  state(): UpdateState {
    return structuredClone(this.st);
  }

  /** Vérification au démarrage puis toutes les deux heures, selon le réglage. */
  start(): void {
    const tick = () => {
      if (this.o.settings().updates.mode === 'off') return;
      void this.check().catch(() => undefined);
    };
    this.first = setTimeout(tick, 15_000);
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.first.unref();
    this.timer.unref();
  }

  dispose(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<UpdateState> {
    if (this.st.status === 'downloading' || this.st.status === 'installing') return this.state();
    this.set({ status: 'checking', error: null });
    try {
      const r = await fetch(`${this.api}/repos/${this.repo}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'MonolithHarness/3' }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) throw new Error(`Dépôt ${this.repo} introuvable ou privé.`);
      if (!r.ok) throw new Error(`GitHub : HTTP ${r.status}`);
      const release = this.pick((await r.json()) as unknown[]);
      const keep = this.st.status === 'ready' && this.st.release?.version === release?.version;
      this.set({ status: keep ? 'ready' : release ? 'available' : 'none', release, checkedAt: new Date().toISOString(), progress: keep ? 1 : null });
      if (release && !this.notified.has(release.version)) {
        this.notified.add(release.version);
        const mode = this.o.settings().updates.mode;
        if (mode === 'auto' && this.st.installable && !keep) void this.download().catch(() => undefined);
        else this.o.notify(`Mise à jour disponible : ${release.version}`, this.st.installable ? 'Réglages › À propos pour l’installer.' : `${this.st.installReason ?? ''} Page de la version : ${release.url}`);
      }
    } catch (e) {
      this.set({ status: 'error', error: (e as Error).message, checkedAt: new Date().toISOString() });
    }
    return this.state();
  }

  /** Version publiée la plus récente, plus récente que la version courante, avec un paquet vérifiable. */
  private pick(list: unknown[]): UpdateRelease | null {
    const pattern = assetPattern(this.platform);
    const allowPre = this.o.current.includes('-');
    const prefix = `${this.downloads}/${this.repo}/releases/download/`;
    const found: UpdateRelease[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const rel = raw as { draft?: boolean; prerelease?: boolean; tag_name?: string; html_url?: string; body?: string; published_at?: string; assets?: { name?: string; browser_download_url?: string; digest?: string; size?: number }[] };
      if (rel.draft || !rel.tag_name || (rel.prerelease && !allowPre)) continue;
      const version = rel.tag_name.replace(/^v/, '');
      if (compareVersions(version, this.o.current) <= 0) continue;
      const asset = (rel.assets ?? []).find((a) => pattern?.test(a.name ?? '') && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(prefix) && /^sha256:[0-9a-f]{64}$/i.test(a.digest ?? '') && (a.size ?? 0) > 0 && (a.size ?? 0) <= MAX_SIZE);
      if (!asset) continue;
      found.push({
        version,
        tag: rel.tag_name,
        url: typeof rel.html_url === 'string' && rel.html_url.startsWith(`${this.downloads}/${this.repo}/`) ? rel.html_url : `${this.downloads}/${this.repo}/releases`,
        prerelease: !!rel.prerelease,
        publishedAt: rel.published_at ?? null,
        notes: (rel.body ?? '').slice(0, 4000),
        asset: asset.name!,
        downloadUrl: asset.browser_download_url!,
        sha256: asset.digest!.slice(7).toLowerCase(),
        size: asset.size!,
      });
    }
    return found.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
  }

  async download(): Promise<UpdateState> {
    const release = this.st.release;
    if (!release) throw new HarnessError('invalid_argument', 'Aucune mise à jour disponible : vérifiez d’abord.');
    if (!this.st.installable) throw new HarnessError('unavailable', this.st.installReason ?? 'Installation impossible sur ce poste.');
    if (this.st.status === 'ready') return this.state();
    if (this.busy) throw new HarnessError('busy', 'Téléchargement déjà en cours');
    mkdirSync(this.o.dir, { recursive: true });
    const dest = join(this.o.dir, release.asset);
    const part = `${dest}.part`;
    this.set({ status: 'downloading', progress: 0, error: null });
    const run = (async () => {
      try {
        const res = await this.fetchOfficial(release.downloadUrl);
        const hash = createHash('sha256');
        const out = createWriteStream(part);
        let received = 0;
        let last = 0;
        for await (const chunk of res.body as AsyncIterable<Buffer>) {
          received += chunk.length;
          if (received > release.size) throw new Error('Paquet plus grand qu’annoncé : téléchargement interrompu.');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          if (Date.now() - last > 400) {
            last = Date.now();
            this.set({ progress: received / release.size });
          }
        }
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
        if (received !== release.size) throw new Error(`Paquet incomplet (${received} / ${release.size} octets).`);
        if (hash.digest('hex') !== release.sha256) throw new Error('Empreinte SHA-256 incorrecte : paquet rejeté.');
        renameSync(part, dest);
        this.set({ status: 'ready', progress: 1 });
        this.o.logger.info('app', `Mise à jour ${release.version} téléchargée et vérifiée`);
        if (this.o.settings().updates.mode === 'auto') await this.install('exit');
      } catch (e) {
        rmSync(part, { force: true });
        this.set({ status: 'error', progress: null, error: (e as Error).message });
      } finally {
        this.busy = null;
      }
    })();
    this.busy = run;
    return this.state();
  }

  /** Attend la fin d'un téléchargement en cours (tests). */
  async idle(): Promise<void> {
    await this.busy;
  }

  /** Revérifie le paquet, sauvegarde les données, puis confie l'installation à l'hôte. */
  async install(when: 'now' | 'exit' = 'now'): Promise<UpdateState> {
    const release = this.st.release;
    if (!release || this.st.status !== 'ready') throw new HarnessError('invalid_argument', 'Téléchargez et vérifiez d’abord la mise à jour.');
    const zip = join(this.o.dir, release.asset);
    if (!existsSync(zip) || (await sha256File(zip)) !== release.sha256) {
      this.set({ status: 'error', error: 'Paquet téléchargé modifié ou absent : téléchargez-le de nouveau.' });
      throw new HarnessError('invalid_argument', 'Paquet téléchargé modifié ou absent.');
    }
    this.o.backup();
    const script = join(this.o.dir, 'apply-update.ps1');
    // BOM : Windows PowerShell 5.1 lit sinon le script en ANSI.
    writeFileSync(script, `﻿${UPDATER_SCRIPT}`, 'utf8');
    rmSync(join(this.o.dir, 'update-result.json'), { force: true });
    await this.o.install({ script, zip, sha256: release.sha256, version: release.version, when });
    if (when === 'now') this.set({ status: 'installing' });
    else this.o.notify(`Mise à jour ${release.version} prête`, 'Elle sera installée à la fermeture de Monolith (données sauvegardées).');
    return this.state();
  }

  private async fetchOfficial(url: string): Promise<Response> {
    let current = url;
    const allowed = new Set([...OFFICIAL_HOSTS, new URL(this.downloads).host]);
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(current);
      if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && u.host === new URL(this.downloads).host)) || !allowed.has(u.host)) throw new Error(`Adresse de téléchargement non officielle refusée : ${u.host}`);
      const r = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'MonolithHarness/3', accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30 * 60_000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        current = new URL(r.headers.get('location')!, current).toString();
        continue;
      }
      if (!r.ok || !r.body) throw new Error(`Téléchargement : HTTP ${r.status}`);
      return r;
    }
    throw new Error('Trop de redirections.');
  }

  private readResult(): UpdateState['lastResult'] {
    const file = join(this.o.dir, 'update-result.json');
    try {
      const r = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as { ok?: boolean; message?: string; at?: string };
      rmSync(file, { force: true });
      const result = { ok: r.ok === true, message: String(r.message ?? ''), at: String(r.at ?? '') };
      queueMicrotask(() => this.o.notify(result.ok ? 'Mise à jour installée' : 'Échec de la mise à jour', result.message));
      return result;
    } catch {
      return null;
    }
  }

  private set(patch: Partial<UpdateState>): void {
    Object.assign(this.st, patch);
    this.o.events.emit('updates.changed', this.state());
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
