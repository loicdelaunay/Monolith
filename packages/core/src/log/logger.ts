import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactValue } from '../security/redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  time: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

export interface Logger {
  debug(category: string, message: string, data?: unknown): void;
  info(category: string, message: string, data?: unknown): void;
  warn(category: string, message: string, data?: unknown): void;
  error(category: string, message: string, data?: unknown): void;
  /** Dernières entrées en mémoire (diagnostics), déjà expurgées. */
  recent(limit?: number): LogEntry[];
}

export interface FileLoggerOptions {
  dir: string | null;
  level?: LogLevel;
  retentionDays?: number;
  /** Copie sur la console (développement). */
  console?: boolean;
}

/**
 * Journal JSONL quotidien. Les écritures sont synchrones mais courtes (une ligne) ;
 * le volume reste faible car le streaming n'est jamais journalisé fragment par fragment.
 */
export class FileLogger implements Logger {
  private readonly ring: LogEntry[] = [];
  private readonly level: number;

  constructor(private readonly options: FileLoggerOptions) {
    this.level = ORDER[options.level ?? 'info'];
    if (options.dir) {
      mkdirSync(options.dir, { recursive: true });
      this.prune(options.retentionDays ?? 14);
    }
  }

  debug(c: string, m: string, d?: unknown) { this.write('debug', c, m, d); }
  info(c: string, m: string, d?: unknown) { this.write('info', c, m, d); }
  warn(c: string, m: string, d?: unknown) { this.write('warn', c, m, d); }
  error(c: string, m: string, d?: unknown) { this.write('error', c, m, d); }

  recent(limit = 200): LogEntry[] {
    return this.ring.slice(-limit);
  }

  private write(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (ORDER[level] < this.level) return;
    const entry: LogEntry = { time: new Date().toISOString(), level, category, message: redact(message) };
    if (data !== undefined) entry.data = redactValue(data instanceof Error ? { error: data.message, stack: data.stack } : data);
    this.ring.push(entry);
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500);
    const line = JSON.stringify(entry);
    if (this.options.console) (level === 'error' ? console.error : console.log)(line);
    if (this.options.dir) {
      try {
        appendFileSync(join(this.options.dir, `monolith-${entry.time.slice(0, 10)}.log`), line + '\n');
      } catch {
        // Un journal indisponible ne doit jamais interrompre le moteur.
      }
    }
  }

  private prune(days: number): void {
    const limit = Date.now() - days * 86_400_000;
    try {
      for (const f of readdirSync(this.options.dir!)) {
        if (!/^monolith-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const p = join(this.options.dir!, f);
        if (statSync(p).mtimeMs < limit) rmSync(p, { force: true });
      }
    } catch {
      /* ignoré */
    }
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  recent: () => [],
};
