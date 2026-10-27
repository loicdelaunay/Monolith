import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HarnessError } from '@monolith/contracts';
import { MIGRATIONS, type Migration } from './migrations.ts';
import type { Logger } from '../log/logger.ts';

export type Row = Record<string, SQLInputValue>;

export interface OpenDatabaseOptions {
  path: string;
  backupDir: string;
  logger: Logger;
  migrations?: Migration[];
  /** Nombre de sauvegardes de migration conservées. */
  keepBackups?: number;
}

export interface DatabaseInfo {
  schemaVersion: number;
  /** La base est plus récente que l'application : ouverte en lecture seule. */
  readOnly: boolean;
  sqliteVersion: string;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Accès SQLite synchrone. Exécuté dans le processus moteur (jamais dans le thread
 * d'interface ni dans le processus principal Electron).
 */
export class Database {
  readonly db: DatabaseSync;
  readonly info: DatabaseInfo;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private transactionDepth = 0;

  private constructor(db: DatabaseSync, info: DatabaseInfo) {
    this.db = db;
    this.info = info;
  }

  static open(options: OpenDatabaseOptions): Database {
    mkdirSync(dirname(options.path), { recursive: true });
    const migrations = options.migrations ?? MIGRATIONS;
    const fresh = !existsSync(options.path);
    const db = new DatabaseSync(options.path, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);

    const applied = db.prepare('SELECT version, name, checksum FROM _migrations ORDER BY version').all() as {
      version: number;
      name: string;
      checksum: string;
    }[];
    const known = new Map(migrations.map((m) => [m.version, m]));
    const latest = migrations.at(-1)?.version ?? 0;
    const current = applied.at(-1)?.version ?? 0;

    for (const row of applied) {
      const m = known.get(row.version);
      if (!m) continue; // migration plus récente que l'application : traitée plus bas
      if (checksum(m.sql) !== row.checksum) {
        db.close();
        throw new HarnessError(
          'storage',
          `La migration ${row.version} (${row.name}) appliquée à cette base ne correspond pas à celle de l'application. Base laissée intacte.`,
          { version: row.version },
        );
      }
    }

    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

    if (current > latest) {
      options.logger.warn('storage', 'Base plus récente que l’application : ouverture en lecture seule', { current, latest });
      db.close();
      const ro = new DatabaseSync(options.path, { readOnly: true, enableForeignKeyConstraints: true });
      return new Database(ro, { schemaVersion: current, readOnly: true, sqliteVersion });
    }

    const pending = migrations.filter((m) => m.version > current);
    if (pending.length > 0) {
      if (!fresh && current > 0) Database.backup(db, options, current);
      for (const m of pending) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(m.sql);
          db.prepare('INSERT INTO _migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
            m.version,
            m.name,
            checksum(m.sql),
            new Date().toISOString(),
          );
          db.exec('COMMIT');
          options.logger.info('storage', `Migration ${m.version} appliquée`, { name: m.name });
        } catch (error) {
          db.exec('ROLLBACK');
          db.close();
          throw new HarnessError('storage', `Échec de la migration ${m.version} (${m.name}) : ${(error as Error).message}`);
        }
      }
    }

    return new Database(db, { schemaVersion: latest, readOnly: false, sqliteVersion });
  }

  private static backup(db: DatabaseSync, options: OpenDatabaseOptions, fromVersion: number): void {
    mkdirSync(options.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(options.backupDir, `monolith-v${fromVersion}-${stamp}.sqlite`);
    db.prepare('VACUUM INTO ?').run(target);
    options.logger.info('storage', 'Sauvegarde avant migration', { target });
    const keep = options.keepBackups ?? 5;
    const backups = readdirSync(options.backupDir)
      .filter((f) => f.startsWith('monolith-v') && f.endsWith('.sqlite'))
      .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(options.backupDir, old), { force: true });
  }

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    this.assertWritable();
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Transaction réentrante (les niveaux imbriqués utilisent des savepoints). */
  transaction<T>(fn: () => T): T {
    this.assertWritable();
    const depth = this.transactionDepth;
    const sp = `sp${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (error) {
      this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  /** Copie cohérente de la base (sauvegarde manuelle). */
  backupTo(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  private assertWritable(): void {
    if (this.info.readOnly) {
      throw new HarnessError('storage', 'Base ouverte en lecture seule : elle a été créée par une version plus récente de l’application.');
    }
  }
}

export const bool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
export const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
