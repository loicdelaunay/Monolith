import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { HarnessError, type Id, type TerminalInfo } from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import { redact } from '../security/redact.ts';

const MAX_BUFFER = 512 * 1024;

interface Session {
  info: TerminalInfo;
  child: ChildProcess;
  output: string;
  /** Position déjà lue par le modèle (read_terminal). */
  readOffset: number;
  done: Promise<void>;
}

/** Shell utilisé pour les commandes : PowerShell sous Windows, bash ailleurs (sh en repli). */
export function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return { file: ps, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`] };
  }
  return { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-lc', command] };
}

/** Variables d'environnement transmises : celles de l'utilisateur, sans les variables internes de l'application. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(MONOLITH_|ELECTRON_)/.test(k)) env[k] = v;
  return env;
}

/**
 * Terminaux asynchrones par conversation (sans pseudo-terminal) : sorties reçues par événements,
 * délai, code de retour, arrêt. Les sorties sont expurgées des secrets connus avant diffusion.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly events: EventBus) {}

  start(conversationId: Id, command: string, cwd: string): Session {
    const { file, args } = shellFor(command);
    const id = randomUUID().slice(0, 8);
    const child = spawn(file, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const info: TerminalInfo = { id, conversationId, command, cwd, status: 'running', exitCode: null, startedAt: new Date().toISOString() };
    const session: Session = { info, child, output: '', readOffset: 0, done: Promise.resolve() };
    const onData = (buf: Buffer) => {
      const chunk = redact(buf.toString('utf8'));
      session.output += chunk;
      if (session.output.length > MAX_BUFFER) {
        const cut = session.output.length - MAX_BUFFER;
        session.output = session.output.slice(cut);
        session.readOffset = Math.max(0, session.readOffset - cut);
      }
      this.events.emit('terminal.output', { terminalId: id, conversationId, chunk });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    session.done = new Promise((resolve) => {
      child.on('error', (e) => {
        session.output += `\n[erreur de lancement : ${e.message}]`;
        if (info.status === 'running') info.status = 'exited';
        this.events.emit('terminal.changed', { terminal: { ...info } });
        resolve();
      });
      child.on('close', (code) => {
        info.exitCode = code;
        if (info.status === 'running') info.status = 'exited';
        this.events.emit('terminal.changed', { terminal: { ...info } });
        resolve();
      });
    });
    this.sessions.set(id, session);
    this.events.emit('terminal.changed', { terminal: { ...info } });
    return session;
  }

  /** Attend la fin ou le délai ; au-delà, la commande continue en arrière-plan (statut `running`). */
  async wait(id: string, timeoutMs: number, signal: AbortSignal): Promise<Session> {
    const s = this.get(id);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      s.done,
      new Promise<void>((r) => (timer = setTimeout(r, timeoutMs))),
      new Promise<void>((r) => {
        onAbort = () => {
          this.kill(id);
          r();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    return s;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new HarnessError('not_found', `Terminal ${id} introuvable`);
    return s;
  }

  /** Nouvelle sortie depuis la dernière lecture. */
  readNew(id: string): string {
    const s = this.get(id);
    const out = s.output.slice(s.readOffset);
    s.readOffset = s.output.length;
    return out;
  }

  kill(id: string): void {
    const s = this.get(id);
    if (s.info.status !== 'running') return;
    s.info.status = 'killed';
    try {
      if (process.platform === 'win32' && s.child.pid) spawn('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true });
      else if (s.child.pid) process.kill(-s.child.pid, 'SIGTERM');
    } catch {
      s.child.kill();
    }
    this.events.emit('terminal.changed', { terminal: { ...s.info } });
  }

  list(conversationId: Id): TerminalInfo[] {
    return [...this.sessions.values()].filter((s) => s.info.conversationId === conversationId).map((s) => ({ ...s.info }));
  }

  output(id: string): string {
    return this.get(id).output;
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.kill(id);
  }
}
