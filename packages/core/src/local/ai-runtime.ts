import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { HarnessError, type CommandClassification, type LocalAiComponent, type LocalAiProgress, type LocalAiStatus } from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import type { Logger } from '../log/logger.ts';
import { DEPENDENCIES_CHECK, EMBEDDINGS_BRIDGE, LANCET_BRIDGE } from './ai-bridges.ts';
import { LANCET_MANIFEST, MINILM_MANIFEST, PYTHON_DEPENDENCIES, PYTHON_RUNTIME, type ModelManifest } from './ai-manifests.ts';

export interface LocalAiOptions {
  dir: string;
  events: EventBus;
  logger: Logger;
  hfBase?: string;
  githubBase?: string;
  pypiIndex?: string;
  /** Exécutable Python imposé (tests) : le runtime n'est pas téléchargé. */
  python?: string;
  manifests?: Partial<Record<LocalAiComponent, ModelManifest>>;
  /** Archive Python attendue (tests) ; par défaut celle épinglée pour la plateforme. */
  runtime?: { triple: string; sha256: string };
}

const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
/** Présent dans le dossier d'un composant quand son modèle vient du poste et diffère du modèle prévu. */
const CUSTOM_FILE = 'custom.json';
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Processus Python persistant : une requête JSON à la fois, identifiant vérifié, délai par requête. */
class PyWorker {
  private proc: ChildProcess | null = null;
  private readonly waiting = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private stderr = '';

  constructor(
    private readonly python: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(timeoutMs: number): Promise<void> {
    const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.python);
    const proc = win ? spawn([this.python, ...this.args].map(quote).join(' '), [], { shell: true, windowsHide: true, env: this.env }) : spawn(this.python, this.args, { windowsHide: true, env: this.env });
    this.proc = proc;
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-3000)));
    const lines = createInterface({ input: proc.stdout! });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => (this.stop(), reject(new Error('Préparation du modèle trop longue.'))), timeoutMs);
      const fail = () => (clearTimeout(timer), reject(new Error(`Le modèle n’a pas pu démarrer.${this.stderr ? ` ${this.stderr.trim().split('\n').at(-1)}` : ''}`)));
      proc.once('exit', fail);
      proc.once('error', fail);
      lines.once('line', (line) => {
        clearTimeout(timer);
        proc.off('exit', fail);
        try {
          if ((JSON.parse(line) as { ready?: boolean }).ready === true) return resolve();
        } catch {
          /* réponse invalide */
        }
        reject(new Error('Le modèle n’a pas confirmé sa préparation.'));
      });
    });
    lines.on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const w = this.waiting.get(String(msg.request_id));
      if (!w) return;
      this.waiting.delete(String(msg.request_id));
      w.resolve(msg);
    });
    proc.on('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('Le modèle s’est arrêté.'));
      this.waiting.clear();
      if (this.proc === proc) this.proc = null;
    });
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  request(payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const run = this.chain.then(
      () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          if (!this.alive) return reject(new Error('Le modèle n’est pas démarré.'));
          if (signal?.aborted) return reject(new Error('Annulé'));
          const id = randomUUID().replace(/-/g, '');
          const timer = setTimeout(() => {
            this.waiting.delete(id);
            // Une réponse tardive ne doit pas être prise pour la suivante : le processus est relancé.
            this.stop();
            reject(new Error('Délai dépassé'));
          }, timeoutMs);
          this.waiting.set(id, {
            resolve: (v) => (clearTimeout(timer), resolve(v)),
            reject: (e) => (clearTimeout(timer), reject(e)),
          });
          this.proc!.stdin!.write(`${JSON.stringify({ ...payload, request_id: id })}\n`);
        }),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }).on('error', () => undefined);
    else p.kill();
  }
}

/**
 * IA locale auxiliaire : Python autonome (python-build-standalone épinglé), dépendances CPU
 * (roues binaires de PyPI) et modèles téléchargés depuis Hugging Face à une révision figée, chaque
 * fichier vérifié (taille et SHA-256). Les installations passent par un dossier temporaire et ne
 * sont publiées qu'une fois complètes et vérifiées.
 */
export class LocalAiService {
  private readonly hf: string;
  private readonly github: string;
  private readonly pypi: string;
  private readonly manifests: Record<LocalAiComponent, ModelManifest>;
  private readonly workers = new Map<LocalAiComponent, PyWorker>();
  private readonly idleTimers = new Map<LocalAiComponent, NodeJS.Timeout>();
  private job: { progress: LocalAiProgress; controller: AbortController } | null = null;

  constructor(private readonly o: LocalAiOptions) {
    this.hf = (o.hfBase ?? 'https://huggingface.co').replace(/\/+$/, '');
    this.github = (o.githubBase ?? 'https://github.com').replace(/\/+$/, '');
    this.pypi = o.pypiIndex ?? 'https://pypi.org/simple';
    this.manifests = { lancet: o.manifests?.lancet ?? LANCET_MANIFEST, minilm: o.manifests?.minilm ?? MINILM_MANIFEST };
  }

  // ---------------------------------------------------------------------------
  // Emplacements
  // ---------------------------------------------------------------------------

  private get target() {
    return this.o.runtime ?? PYTHON_RUNTIME.targets[`${process.platform}-${process.arch}`] ?? null;
  }
  private get runtimeDir(): string {
    return join(this.o.dir, `python-${PYTHON_RUNTIME.version}-${PYTHON_RUNTIME.release}-${process.platform}-${process.arch}`);
  }
  private get python(): string {
    if (this.o.python) return this.o.python;
    return join(this.runtimeDir, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  }
  private get siteDir(): string {
    return join(this.o.dir, `site-${createHash('sha256').update(PYTHON_DEPENDENCIES.join(' ')).digest('hex').slice(0, 10)}`);
  }
  private componentDir(id: LocalAiComponent): string {
    return join(this.o.dir, `${id}-${this.manifests[id].revision.slice(0, 10)}`);
  }
  private runtimeReady(): boolean {
    return this.o.python ? true : existsSync(join(this.runtimeDir, '.complete')) && existsSync(this.python);
  }
  private depsReady(): boolean {
    return existsSync(join(this.siteDir, '.ready'));
  }
  installed(id: LocalAiComponent): boolean {
    const ready = join(this.componentDir(id), '.ready');
    return this.runtimeReady() && this.depsReady() && existsSync(ready) && readFileSync(ready, 'utf8') === this.manifests[id].revision;
  }

  private fileUrl(m: ModelManifest, path: string): string {
    return `${this.hf}/${m.repo}/resolve/${m.revision}/${m.prefix}${path}`;
  }
  private customModel(id: LocalAiComponent): { name: string; sha256: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.componentDir(id), CUSTOM_FILE), 'utf8')) as { name: string; sha256: string };
    } catch {
      return null;
    }
  }
  /** Identifiant du modèle du poste s'il remplace MiniLM : en changer réindexe les dossiers (vecteurs incomparables). */
  customEmbeddingId(): string | null {
    const c = this.customModel('minilm');
    return c ? `local:custom-${c.sha256.slice(0, 12)}` : null;
  }

  status(): LocalAiStatus {
    const supported = !!this.target || !!this.o.python;
    return {
      components: (['lancet', 'minilm'] as const).map((id) => {
        const m = this.manifests[id];
        return { id, installed: this.installed(id), version: m.version, bytes: m.files.reduce((n, f) => n + f.size, 0), files: m.files.map((f) => ({ path: f.path, url: this.fileUrl(m, f.path), bytes: f.size })), custom: this.customModel(id)?.name ?? null };
      }),
      runtime: { installed: this.runtimeReady() && this.depsReady(), version: this.o.python ? 'externe' : PYTHON_RUNTIME.version },
      busy: this.job ? { ...this.job.progress } : null,
      supported,
      unsupportedReason: supported ? null : `Plateforme ${process.platform}-${process.arch} non prise en charge.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Installation (après accord explicite de l'utilisateur)
  // ---------------------------------------------------------------------------

  install(id: LocalAiComponent): LocalAiStatus {
    if (!(id in this.manifests)) throw new HarnessError('invalid_argument', `Composant inconnu : ${id}`);
    if (this.job) throw new HarnessError('busy', 'Une installation est déjà en cours');
    if (!this.status().supported) throw new HarnessError('unavailable', this.status().unsupportedReason!);
    return this.start(id, this.manifests[id].files.reduce((n, f) => n + f.size, 0), (signal) => this.run(id, signal));
  }

  /**
   * Modèle d'embeddings pris sur le poste (Hugging Face inaccessible) : le fichier .onnx choisi et son
   * tokenizer.json, sélectionné aussi ou trouvé à côté (dans le dossier parent pour la disposition de
   * Hugging Face, onnx/model.onnx). Fichiers identiques au modèle prévu : installation normale ; sinon
   * modèle du poste, adopté seulement s'il produit un vecteur valide.
   */
  installFrom(id: LocalAiComponent, paths: string[]): LocalAiStatus {
    if (id !== 'minilm') throw new HarnessError('invalid_argument', 'Seul le modèle d’embeddings du RAG peut être choisi sur le poste.');
    if (this.job) throw new HarnessError('busy', 'Une installation est déjà en cours');
    if (!this.status().supported) throw new HarnessError('unavailable', this.status().unsupportedReason!);
    const model = paths.find((p) => /\.onnx$/i.test(p));
    if (!model || !isFile(model)) throw new HarnessError('invalid_argument', 'Sélectionnez le fichier .onnx du modèle.');
    const tokenizer = paths.find((p) => basename(p).toLowerCase() === 'tokenizer.json') ?? [dirname(model), dirname(dirname(model))].map((d) => join(d, 'tokenizer.json')).find(isFile);
    if (!tokenizer || !isFile(tokenizer)) throw new HarnessError('invalid_argument', 'tokenizer.json introuvable à côté du modèle : sélectionnez-le avec le fichier .onnx.');
    return this.start(id, statSync(model).size + statSync(tokenizer).size, (signal) => this.runLocal(id, model, tokenizer, signal));
  }

  private start(id: LocalAiComponent, total: number, work: (signal: AbortSignal) => Promise<void>): LocalAiStatus {
    const controller = new AbortController();
    this.job = { controller, progress: { component: id, stage: 'runtime', received: 0, total, message: null } };
    this.emit();
    void work(controller.signal)
      .then(() => this.progress({ stage: 'ready', received: total, message: null }))
      .catch((e: Error) => {
        this.o.logger.warn('localai', `Installation de ${id} en échec`, { error: e.message });
        this.progress({ stage: 'error', message: controller.signal.aborted ? 'Installation annulée.' : e.message });
      })
      .finally(() => {
        this.job = null;
        this.emit();
      });
    return this.status();
  }

  cancel(): void {
    this.job?.controller.abort();
  }

  /** Attend la fin de l'installation en cours (tests). */
  async idle(): Promise<void> {
    while (this.job) await new Promise((r) => setTimeout(r, 20));
  }

  private progress(patch: Partial<LocalAiProgress>): void {
    if (!this.job) return;
    Object.assign(this.job.progress, patch);
    this.o.events.emit('localai.progress', { ...this.job.progress });
  }

  private emit(): void {
    this.o.events.emit('localai.changed', this.status());
  }

  private async run(id: LocalAiComponent, signal: AbortSignal): Promise<void> {
    mkdirSync(this.o.dir, { recursive: true });
    if (!this.runtimeReady()) await this.installRuntime(signal);
    if (!this.depsReady()) await this.installDependencies(signal);
    const manifest = this.manifests[id];
    const final = this.componentDir(id);
    if (!this.installed(id) || this.customModel(id)) {
      const staging = `${final}.install-${randomUUID().slice(0, 8)}`;
      try {
        this.progress({ stage: 'download', received: 0 });
        let done = 0;
        for (const f of manifest.files) {
          await this.download(this.fileUrl(manifest, f.path), join(staging, f.path), f.size, f.sha256, signal, (n) => this.progress({ received: done + n }));
          done += f.size;
        }
        this.progress({ stage: 'prepare', received: done });
        await this.publish(id, staging);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    // Le modèle doit se charger avant d'être déclaré prêt.
    this.progress({ stage: 'prepare' });
    this.stopWorker(id);
    await this.worker(id);
    writeFileSync(join(final, '.ready'), manifest.revision);
  }

  private async runLocal(id: LocalAiComponent, model: string, tokenizer: string, signal: AbortSignal): Promise<void> {
    mkdirSync(this.o.dir, { recursive: true });
    if (!this.runtimeReady()) await this.installRuntime(signal);
    if (!this.depsReady()) await this.installDependencies(signal);
    const manifest = this.manifests[id];
    const modelFile = manifest.files.find((f) => f.path.endsWith('.onnx'))!;
    const tokenizerFile = manifest.files.find((f) => f.path === 'tokenizer.json')!;
    const final = this.componentDir(id);
    const staging = `${final}.install-${randomUUID().slice(0, 8)}`;
    try {
      this.progress({ stage: 'copy', received: 0 });
      const size = statSync(model).size;
      const modelHash = await this.copyFile(model, join(staging, modelFile.path), signal, (n) => this.progress({ received: n }));
      const tokenizerHash = await this.copyFile(tokenizer, join(staging, tokenizerFile.path), signal, (n) => this.progress({ received: size + n }));
      if (modelHash !== modelFile.sha256 || tokenizerHash !== tokenizerFile.sha256) writeFileSync(join(staging, CUSTOM_FILE), JSON.stringify({ name: basename(model), sha256: modelHash }));
      this.progress({ stage: 'prepare' });
      // Essai sur la copie : un modèle inutilisable ne remplace jamais celui déjà installé.
      await this.tryEmbeddings(staging, signal);
      await this.publish(id, staging);
      writeFileSync(join(final, '.ready'), manifest.revision);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private async tryEmbeddings(folder: string, signal: AbortSignal): Promise<void> {
    const bridge = join(this.o.dir, 'minilm_bridge.py');
    writeFileSync(bridge, EMBEDDINGS_BRIDGE);
    const w = new PyWorker(this.python, ['-I', '-B', '-u', bridge, folder, this.siteDir], this.env());
    try {
      await w.start(120_000);
      const r = await w.request({ texts: ['Monolith Harness'] }, 120_000, signal);
      const vector = (r.vectors as number[][] | undefined)?.[0];
      if (typeof r.error === 'string' || !Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) throw new Error(`Modèle incompatible : ${typeof r.error === 'string' ? r.error : 'pas de vecteur valide en sortie'}`);
    } finally {
      w.stop();
    }
  }

  /** Remplace le composant publié. Windows : un processus arrêté garde ses fichiers ouverts un instant. */
  private async publish(id: LocalAiComponent, staging: string): Promise<void> {
    const final = this.componentDir(id);
    this.stopWorker(id);
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(final, { recursive: true, force: true });
        renameSync(staging, final);
        return;
      } catch (e) {
        if (attempt >= 30) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /** Python autonome : archive vérifiée puis extraite (tar du système) dans un dossier temporaire. */
  async installRuntime(signal: AbortSignal): Promise<void> {
    const t = this.target!;
    this.progress({ stage: 'runtime', message: `Python ${PYTHON_RUNTIME.version}` });
    const archive = join(this.o.dir, `python-${PYTHON_RUNTIME.version}.tar.gz`);
    const url = `${this.github}/astral-sh/python-build-standalone/releases/download/${PYTHON_RUNTIME.release}/cpython-${PYTHON_RUNTIME.version}%2B${PYTHON_RUNTIME.release}-${t.triple}-install_only.tar.gz`;
    await this.download(url, archive, null, t.sha256, signal, () => undefined);
    const staging = `${this.runtimeDir}.extract-${randomUUID().slice(0, 8)}`;
    try {
      mkdirSync(staging, { recursive: true });
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      await this.exec(tar, ['-xzf', archive, '-C', staging], 10 * 60_000, signal);
      const exe = join(staging, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      if (!existsSync(exe)) throw new Error('Archive Python inattendue : exécutable absent.');
      writeFileSync(join(staging, '.complete'), t.sha256);
      rmSync(this.runtimeDir, { recursive: true, force: true });
      renameSync(staging, this.runtimeDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  }

  private async installDependencies(signal: AbortSignal): Promise<void> {
    this.progress({ stage: 'dependencies', message: PYTHON_DEPENDENCIES.join(', ') });
    const staging = `${this.siteDir}.install-${randomUUID().slice(0, 8)}`;
    try {
      await this.exec(this.python, ['-I', '-m', 'pip', 'install', '--isolated', '--only-binary=:all:', '--disable-pip-version-check', '--no-warn-script-location', '--target', staging, '--index-url', this.pypi, ...PYTHON_DEPENDENCIES], 20 * 60_000, signal);
      const check = join(this.o.dir, 'check_dependencies.py');
      writeFileSync(check, DEPENDENCIES_CHECK);
      await this.exec(this.python, ['-I', '-B', check, staging], 120_000, signal);
      writeFileSync(join(staging, '.ready'), PYTHON_DEPENDENCIES.join(' '));
      rmSync(this.siteDir, { recursive: true, force: true });
      renameSync(staging, this.siteDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Téléchargement vérifié : taille annoncée (si connue) et empreinte SHA-256. */
  private async download(url: string, dest: string, size: number | null, sha256: string, signal: AbortSignal, onProgress: (n: number) => void): Promise<void> {
    mkdirSync(dirname(dest), { recursive: true });
    const r = await fetch(url, { headers: { 'user-agent': 'MonolithHarness/3' }, redirect: 'follow', signal }).catch((e: Error) => {
      if (signal.aborted) throw e;
      throw new Error(`${new URL(url).hostname} inaccessible : ${(e.cause as Error | undefined)?.message ?? e.message}`);
    });
    if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (HTTP ${r.status}) : ${url.split('/').slice(-1)[0]}`);
    const hash = createHash('sha256');
    const out = createWriteStream(dest);
    let received = 0;
    try {
      for await (const chunk of r.body as AsyncIterable<Buffer>) {
        received += chunk.length;
        if (size !== null && received > size) throw new Error(`Fichier plus grand qu’attendu : ${dest.split(/[\\/]/).at(-1)}`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
        onProgress(received);
      }
    } finally {
      await new Promise<void>((res) => out.end(() => res()));
    }
    if (size !== null && received !== size) throw new Error(`Fichier incomplet : ${dest.split(/[\\/]/).at(-1)}`);
    if (hash.digest('hex') !== sha256.toLowerCase()) {
      rmSync(dest, { force: true });
      throw new Error(`Empreinte SHA-256 incorrecte : ${dest.split(/[\\/]/).at(-1)}`);
    }
  }

  /** Copie un fichier du poste dans le dossier d'installation et renvoie son empreinte SHA-256. */
  private async copyFile(from: string, dest: string, signal: AbortSignal, onProgress: (n: number) => void): Promise<string> {
    mkdirSync(dirname(dest), { recursive: true });
    const hash = createHash('sha256');
    let copied = 0;
    await pipeline(
      createReadStream(from),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          copied += chunk.length;
          onProgress(copied);
          yield chunk;
        }
      },
      createWriteStream(dest),
      { signal },
    );
    return hash.digest('hex');
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '2', PYTHONIOENCODING: 'utf-8', PIP_NO_INPUT: '1' };
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    return env;
  }

  private exec(cmd: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
      const p = win ? spawn([cmd, ...args].map(quote).join(' '), [], { shell: true, windowsHide: true, env: this.env() }) : spawn(cmd, args, { windowsHide: true, env: this.env() });
      let err = '';
      p.stderr?.setEncoding('utf8');
      p.stderr?.on('data', (d: string) => (err = (err + d).slice(-3000)));
      p.stdout?.on('data', () => undefined);
      const kill = () => (process.platform === 'win32' && p.pid ? spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }).on('error', () => undefined) : p.kill());
      const timer = setTimeout(kill, timeoutMs);
      signal.addEventListener('abort', kill, { once: true });
      p.on('error', (e) => (clearTimeout(timer), reject(e)));
      p.on('exit', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', kill);
        if (signal.aborted) return reject(new Error('Annulé'));
        if (code === 0) return resolve();
        reject(new Error(`${cmd.split(/[\\/]/).at(-1)} : échec (code ${code})${err ? ` — ${err.trim().split('\n').slice(-2).join(' ')}` : ''}`));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Utilisation
  // ---------------------------------------------------------------------------

  private async worker(id: LocalAiComponent): Promise<PyWorker> {
    const existing = this.workers.get(id);
    if (existing?.alive) return this.touch(id, existing);
    const bridge = join(this.o.dir, `${id}_bridge.py`);
    writeFileSync(bridge, id === 'lancet' ? LANCET_BRIDGE : EMBEDDINGS_BRIDGE);
    const w = new PyWorker(this.python, ['-I', '-B', '-u', bridge, this.componentDir(id), this.siteDir], this.env());
    await w.start(120_000);
    this.workers.set(id, w);
    return this.touch(id, w);
  }

  /** Arrêt du processus après 10 minutes sans requête. */
  private touch(id: LocalAiComponent, w: PyWorker): PyWorker {
    clearTimeout(this.idleTimers.get(id));
    const t = setTimeout(() => this.stopWorker(id), 10 * 60_000);
    t.unref();
    this.idleTimers.set(id, t);
    return w;
  }

  private stopWorker(id: LocalAiComponent): void {
    this.workers.get(id)?.stop();
    this.workers.delete(id);
  }

  /** LANCET Nano : seule une réponse `not_flagged` valide permet l'exécution sans accord. */
  async classify(command: string, shell: 'bash' | 'powershell' | 'cmd', signal?: AbortSignal): Promise<CommandClassification> {
    const review = (reason: string): CommandClassification => ({ classification: 'review', score: null, reason });
    if (!command.trim() || command.includes('\0') || Buffer.byteLength(command) > 8192) return review('commande invalide ou trop longue');
    if (!this.installed('lancet')) return review('LANCET Nano non installé');
    try {
      const w = await this.worker('lancet');
      const r = await w.request({ command, shell }, 45_000, signal);
      const c = r.classification;
      const score = typeof r.score === 'number' ? r.score : null;
      if ((c !== 'not_flagged' && c !== 'review' && c !== 'risky') || (score !== null && !Number.isFinite(score))) return review('réponse invalide');
      return { classification: c, score, reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : null };
    } catch (e) {
      return review((e as Error).message === 'Délai dépassé' ? 'délai dépassé' : 'modèle indisponible');
    }
  }

  /** MiniLM multilingue : vecteurs normalisés (384 dimensions), par lots. */
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.installed('minilm')) throw new HarnessError('unavailable', 'MiniLM multilingue non installé (Réglages › Skills › RAG).');
    const w = await this.worker('minilm');
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const r = await w.request({ texts: texts.slice(i, i + 32) }, 120_000, signal);
      if (typeof r.error === 'string') throw new HarnessError('provider_stream', `Embeddings locaux : ${r.error}`);
      const vectors = r.vectors as number[][] | undefined;
      if (!Array.isArray(vectors) || vectors.length !== Math.min(32, texts.length - i)) throw new HarnessError('provider_stream', 'Embeddings locaux : réponse incomplète');
      out.push(...vectors);
    }
    return out;
  }

  dispose(): void {
    this.cancel();
    for (const id of [...this.workers.keys()]) this.stopWorker(id);
    for (const t of this.idleTimers.values()) clearTimeout(t);
  }
}

/** Empreinte d'un fichier (tests et diagnostics). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
