import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { UIA_SCRIPT } from './uia-script.ts';

export interface DesktopWindow {
  window_id: string;
  title: string;
  process: string;
  pid: number;
  class: string;
  bounds: [number, number, number, number] | null;
}

export interface UiNode {
  element_id: string;
  parent: string | null;
  depth: number;
  type: string;
  name: string;
  automation_id: string;
  class: string;
  enabled: boolean;
  password: boolean;
  focusable: boolean;
  patterns: string[];
  bounds: [number, number, number, number] | null;
}

/** Accès au bureau : UI Automation (sémantique) et Legacy (saisie physique), séparés. */
export interface DesktopDriver {
  windows(signal?: AbortSignal): Promise<DesktopWindow[]>;
  inspect(window: string, options: { parent?: string; depth: number; max: number }, signal?: AbortSignal): Promise<{ nodes: UiNode[]; truncated: boolean }>;
  /** Action UI Automation ; lève UnsupportedError si le contrôle n'expose pas le motif (aucune action effectuée). */
  act(window: string, element: string, action: string, extra: { text?: string; direction?: string }, signal?: AbortSignal): Promise<{ target: string }>;
  /** Saisie physique (curseur, clavier) dans la fenêtre ciblée, mise au premier plan. */
  legacy(window: string, action: string, extra: { element?: string; x?: number; y?: number; text?: string; keys?: string; direction?: string }, signal?: AbortSignal): Promise<{ x?: number; y?: number }>;
  /** Legacy bloqué tant qu'une action UI Automation expirée peut encore s'exécuter. */
  legacyBlockedUntil(): number;
  dispose(): void | Promise<void>;
}

/** Le contrôle n'expose pas la capacité demandée : rien n'a été modifié. */
export class UnsupportedError extends Error {
  constructor(readonly capability: string) {
    super(`Le contrôle n'expose pas la capacité UI Automation « ${capability} ».`);
  }
}

/** Délai dépassé : l'action a pu s'exécuter, l'état est incertain. */
export class DesktopTimeoutError extends Error {}

const DEADLINE_MS = 10_000;
const LEGACY_BLOCK_MS = 30_000;
const IDLE_MS = 5 * 60_000;
/** Démarrage : génération de l'interop (première fois) et compilation de l'assistant. */
const STARTUP_MS = 60_000;

/**
 * Assistant PowerShell (Windows PowerShell 5.1, thread MTA) : une requête à la fois, délai de 10 s.
 * Un dépassement abandonne le processus (l'action a pu avoir lieu) et bloque Legacy 30 s.
 */
export class UiaDriver implements DesktopDriver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<ChildProcessWithoutNullStreams> | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private blockedUntil = 0;
  private readonly script: string;

  constructor(
    dir: string,
    private readonly blockedPids: number[],
    private readonly exe = 'powershell.exe',
    /** Délai par action (10 s ; allongé seulement par les tests sous forte charge). */
    private readonly deadlineMs = DEADLINE_MS,
  ) {
    mkdirSync(dir, { recursive: true });
    this.script = join(dir, 'uia-helper.ps1');
    // BOM : Windows PowerShell 5.1 lit sinon le script en ANSI.
    writeFileSync(this.script, `\uFEFF${UIA_SCRIPT}`, 'utf8');
  }

  legacyBlockedUntil(): number {
    return this.blockedUntil;
  }

  windows(signal?: AbortSignal): Promise<DesktopWindow[]> {
    return this.send<DesktopWindow[]>({ cmd: 'windows' }, signal).then((r) => (Array.isArray(r) ? r : r ? [r] : []));
  }

  inspect(window: string, options: { parent?: string; depth: number; max: number }, signal?: AbortSignal) {
    return this.send<{ nodes: UiNode[] | UiNode; truncated: boolean }>({ cmd: 'inspect', window, parent: options.parent ?? null, depth: options.depth, max: options.max }, signal).then((r) => ({
      nodes: Array.isArray(r.nodes) ? r.nodes : r.nodes ? [r.nodes] : [],
      truncated: r.truncated,
    }));
  }

  async act(window: string, element: string, action: string, extra: { text?: string; direction?: string }, signal?: AbortSignal) {
    const r = await this.send<{ target: string }>({ cmd: 'act', window, element, action, ...extra }, signal);
    this.blockedUntil = 0;
    return r;
  }

  legacy(window: string, action: string, extra: { element?: string; x?: number; y?: number; text?: string; keys?: string; direction?: string }, signal?: AbortSignal) {
    if (Date.now() < this.blockedUntil) return Promise.reject(new Error('Legacy bloqué : une action UI Automation expirée peut encore s’exécuter. Inspectez la fenêtre avant de réessayer.'));
    return this.send<{ x?: number; y?: number }>({ cmd: 'legacy', window, action, ...extra }, signal);
  }

  /** Arrête l'assistant et attend la fin du processus (fichiers libérés). */
  async dispose(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const proc = this.proc;
    this.kill(new Error('Assistant UI Automation arrêté.'));
    if (proc && proc.exitCode === null && proc.signalCode === null) await new Promise<void>((r) => proc.once('exit', () => r()));
  }

  private send<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // Une requête à la fois : l'assistant est séquentiel et chaque action doit finir avant la suivante.
    const run = this.chain.then(() => this.request<T>(payload, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async request<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const proc = await this.ensure();
    // Annulation : une action pas encore commencée n'est jamais envoyée.
    if (signal?.aborted) throw new Error('Annulé avant l’action.');
    const id = ++this.seq;
    if (this.idle) clearTimeout(this.idle);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.blockedUntil = Date.now() + LEGACY_BLOCK_MS;
        // Le fournisseur natif ne peut pas être interrompu : l'assistant est abandonné.
        this.kill(new DesktopTimeoutError('Délai dépassé'));
        reject(new DesktopTimeoutError(`Délai de ${this.deadlineMs / 1000} s dépassé : l’action a pu s’exécuter. Inspectez l’état avant toute nouvelle tentative (aucune relance automatique).`));
      }, this.deadlineMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          this.armIdle();
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.armIdle();
          reject(e);
        },
      });
      proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(new Error('Assistant UI Automation arrêté (inactivité).')), IDLE_MS);
    this.idle.unref();
  }

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.ready) return this.ready;
    const proc = spawn(this.exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
      windowsHide: true,
      env: { ...process.env, MH_BLOCKED_PIDS: this.blockedPids.join(',') },
    });
    this.proc = proc;
    let started!: { resolve: (p: ChildProcessWithoutNullStreams) => void; reject: (e: Error) => void };
    const ready = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => (started = { resolve, reject }));
    // Un échec de démarrage est rendu à l'appelant ; évite une promesse rejetée non observée.
    ready.catch(() => undefined);
    this.ready = ready;
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg: { id: number; ok: boolean; result?: unknown; error?: string };
      try {
        msg = JSON.parse(line.replace(/^\uFEFF/, ''));
      } catch {
        return;
      }
      if (msg.id === 0 && msg.ok) {
        clearTimeout(startTimer);
        return started.resolve(proc);
      }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else if (msg.error?.startsWith('UNSUPPORTED:')) w.reject(new UnsupportedError(msg.error.slice('UNSUPPORTED:'.length)));
      else w.reject(new Error(msg.error ?? 'Erreur UI Automation'));
    });
    const fail = (e: Error) => {
      clearTimeout(startTimer);
      started.reject(e);
      if (this.proc === proc) this.kill(e);
    };
    proc.on('error', (e) => fail(new Error(`PowerShell indisponible : ${e.message}`)));
    proc.on('exit', () => fail(new Error(`Assistant UI Automation terminé.${stderr ? ` ${stderr.trim().split('\n').at(-1)}` : ''}`)));
    const startTimer = setTimeout(() => fail(new Error('Démarrage de l’assistant UI Automation trop long.')), STARTUP_MS);
    return ready;
  }

  private kill(reason: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    for (const w of this.waiting.values()) w.reject(reason);
    this.waiting.clear();
    if (proc && proc.exitCode === null) proc.kill();
  }
}
