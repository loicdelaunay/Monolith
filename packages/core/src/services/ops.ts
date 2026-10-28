import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type BackupInfo, type DashboardBucket, type DashboardData, type DashboardQuery, type Id, type MaintenanceReport, type NotificationItem, type Settings } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { redact } from '../security/redact.ts';
import { now } from '../util.ts';

// ---------------------------------------------------------------------------
// Sauvegardes manuelles et restauration au prochain démarrage
// ---------------------------------------------------------------------------

export const RESTORE_MARKER = 'restore-pending.json';
const BACKUP_NAME = /^monolith-(manual|v\d+)-[\w.-]+\.sqlite$/;

/** Applique une restauration demandée avant l'ouverture de la base (copie de sécurité de la base actuelle). */
export function applyPendingRestore(dbPath: string, backupDir: string): string | null {
  const marker = join(backupDir, RESTORE_MARKER);
  if (!existsSync(marker)) return null;
  try {
    const { name } = JSON.parse(readFileSync(marker, 'utf8')) as { name: string };
    const source = join(backupDir, name);
    if (!BACKUP_NAME.test(name) || !existsSync(source)) return null;
    if (existsSync(dbPath)) copyFileSync(dbPath, join(backupDir, `monolith-manual-avant-restauration-${now().replace(/[:.]/g, '-')}.sqlite`));
    for (const ext of ['-wal', '-shm']) rmSync(`${dbPath}${ext}`, { force: true });
    copyFileSync(source, `${dbPath}.restore`);
    renameSync(`${dbPath}.restore`, dbPath);
    return name;
  } finally {
    rmSync(marker, { force: true });
  }
}

export class BackupService {
  constructor(
    private readonly db: Database,
    private readonly dir: string,
  ) {}

  list(): BackupInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => BACKUP_NAME.test(f))
      .map((name) => {
        const st = statSync(join(this.dir, name));
        return { name, size: st.size, createdAt: st.mtime.toISOString(), kind: name.startsWith('monolith-manual') ? ('manual' as const) : ('migration' as const) };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Copie cohérente de la base (VACUUM INTO), sans interrompre l'application. */
  create(): BackupInfo {
    if (this.db.info.readOnly) throw new HarnessError('unavailable', 'Base en lecture seule');
    const name = `monolith-manual-${now().replace(/[:.]/g, '-')}.sqlite`;
    this.db.db.prepare('VACUUM INTO ?').run(join(this.dir, name));
    return this.list().find((b) => b.name === name)!;
  }

  path(name: string): string {
    if (!BACKUP_NAME.test(name) || !existsSync(join(this.dir, name))) throw new HarnessError('not_found', 'Sauvegarde introuvable');
    return join(this.dir, name);
  }

  restore(name: string): { restartRequired: true } {
    this.path(name);
    writeFileSync(join(this.dir, RESTORE_MARKER), JSON.stringify({ name, requestedAt: now() }), 'utf8');
    return { restartRequired: true };
  }

  delete(name: string): void {
    rmSync(this.path(name), { force: true });
  }
}

// ---------------------------------------------------------------------------
// Tableau de bord : agrégats de la consommation
// ---------------------------------------------------------------------------

interface UsageRow {
  day: string;
  provider_id: number | null;
  provider_name: string;
  model: string;
  kind: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  estimated: number;
  first_token_ms: number | null;
}

export class DashboardService {
  constructor(private readonly db: Database) {}

  private rows(q: DashboardQuery): { rows: UsageRow[]; from: string; to: string } {
    const to = q.to ?? now().slice(0, 10);
    const from = q.from ?? new Date(Date.parse(to) - 29 * 86_400_000).toISOString().slice(0, 10);
    const where = ['substr(started_at, 1, 10) >= ?', 'substr(started_at, 1, 10) <= ?'];
    const params: (string | number)[] = [from, to];
    if (q.providerId) {
      where.push('provider_id = ?');
      params.push(q.providerId);
    }
    if (q.kind) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    const rows = this.db.all<UsageRow>(`SELECT substr(started_at, 1, 10) AS day, provider_id, provider_name, model, kind, status, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, estimated, first_token_ms FROM usage WHERE ${where.join(' AND ')} ORDER BY started_at`, ...params);
    return { rows, from, to };
  }

  data(q: DashboardQuery): DashboardData {
    const { rows, from, to } = this.rows(q);
    const bucket = (key: (r: UsageRow) => string) => {
      const map = new Map<string, DashboardBucket>();
      for (const r of rows) {
        const k = key(r);
        const b = map.get(k) ?? { key: k, requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
        b.requests++;
        b.inputTokens += r.input_tokens ?? 0;
        b.outputTokens += r.output_tokens ?? 0;
        if (r.status === 'error') b.errors++;
        map.set(k, b);
      }
      return [...map.values()];
    };
    // Une valeur par jour de la période, y compris les jours sans activité.
    const byDayMap = new Map(bucket((r) => r.day).map((b) => [b.key, b]));
    const byDay: DashboardBucket[] = [];
    for (let d = Date.parse(from); d <= Date.parse(to) && byDay.length < 400; d += 86_400_000) {
      const key = new Date(d).toISOString().slice(0, 10);
      byDay.push(byDayMap.get(key) ?? { key, requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 });
    }
    const ft = rows.map((r) => r.first_token_ms).filter((x): x is number => x !== null);
    const providers = new Map<number, string>();
    for (const r of this.db.all<{ provider_id: number; provider_name: string }>('SELECT DISTINCT provider_id, provider_name FROM usage WHERE provider_id IS NOT NULL')) providers.set(r.provider_id, r.provider_name);
    return {
      from,
      to,
      totals: {
        requests: rows.length,
        inputTokens: rows.reduce((a, r) => a + (r.input_tokens ?? 0), 0),
        outputTokens: rows.reduce((a, r) => a + (r.output_tokens ?? 0), 0),
        cachedInputTokens: rows.reduce((a, r) => a + (r.cached_input_tokens ?? 0), 0),
        reasoningTokens: rows.reduce((a, r) => a + (r.reasoning_tokens ?? 0), 0),
        errors: rows.filter((r) => r.status === 'error').length,
        estimated: rows.filter((r) => r.estimated).length,
        avgFirstTokenMs: ft.length ? Math.round(ft.reduce((a, b) => a + b, 0) / ft.length) : null,
      },
      byDay,
      byModel: bucket((r) => `${r.provider_name} · ${r.model}`).sort((a, b) => b.outputTokens + b.inputTokens - (a.outputTokens + a.inputTokens)),
      byKind: bucket((r) => r.kind).sort((a, b) => b.requests - a.requests),
      providers: [...providers.entries()].map(([id, name]) => ({ id, name })),
    };
  }

  csv(q: DashboardQuery): string {
    const { rows } = this.rows(q);
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['date', 'connexion', 'modele', 'type', 'statut', 'tokens_entree', 'tokens_sortie', 'tokens_cache', 'tokens_reflexion', 'estime', 'premier_token_ms'];
    return [head.join(','), ...rows.map((r) => [r.day, r.provider_name, r.model, r.kind, r.status, r.input_tokens, r.output_tokens, r.cached_input_tokens, r.reasoning_tokens, r.estimated ? 1 : 0, r.first_token_ms].map(esc).join(','))].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Notifications (cloche) : événements du moteur conservés
// ---------------------------------------------------------------------------

export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  add(level: NotificationItem['level'], title: string, body: string, conversationId: Id | null = null): NotificationItem {
    const t = now();
    const { lastInsertRowid: id } = this.db.run('INSERT INTO notifications (time, level, title, body, conversation_id, read) VALUES (?, ?, ?, ?, ?, 0)', t, level, redact(title).slice(0, 200), redact(body).slice(0, 2000), conversationId);
    // Historique borné : les plus anciennes sont supprimées.
    this.db.run('DELETE FROM notifications WHERE id <= (SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET 500)');
    const item = { id, time: t, level, title, body, conversationId, read: false };
    this.events.emit('notification.added', item);
    return item;
  }

  list(limit = 100): NotificationItem[] {
    return this.db
      .all<{ id: number; time: string; level: NotificationItem['level']; title: string; body: string; conversation_id: number | null; read: number }>('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', Math.min(500, limit))
      .map((r) => ({ id: r.id, time: r.time, level: r.level, title: r.title, body: r.body, conversationId: r.conversation_id, read: !!r.read }));
  }

  markRead(ids?: Id[]): void {
    if (!ids) this.db.run('UPDATE notifications SET read = 1');
    else for (const id of ids) this.db.run('UPDATE notifications SET read = 1 WHERE id = ?', id);
  }

  clear(): void {
    this.db.run('DELETE FROM notifications');
  }
}

// ---------------------------------------------------------------------------
// Maintenance automatique
// ---------------------------------------------------------------------------

export class MaintenanceService {
  constructor(
    private readonly deps: {
      db: Database;
      settings: () => Settings;
      attachmentsDir: string;
      isGenerating: (id: Id) => boolean;
      deleteConversation: (id: Id) => void;
      archiveConversation: (id: Id) => void;
    },
  ) {}

  run(): MaintenanceReport {
    const s = this.deps.settings().maintenance;
    const report: MaintenanceReport = { archived: 0, deleted: 0, attachments: 0 };
    const day = 86_400_000;
    if (s.autoArchiveDays > 0) {
      const limit = new Date(Date.now() - s.autoArchiveDays * day).toISOString();
      for (const r of this.deps.db.all<{ id: number }>('SELECT id FROM conversations WHERE archived = 0 AND pinned = 0 AND favorite = 0 AND parent_id IS NULL AND COALESCE(last_message_at, updated_at) < ?', limit)) {
        if (this.deps.isGenerating(r.id)) continue;
        this.deps.archiveConversation(r.id);
        report.archived++;
      }
    }
    if (s.autoDeleteArchivedDays > 0) {
      const limit = new Date(Date.now() - s.autoDeleteArchivedDays * day).toISOString();
      for (const r of this.deps.db.all<{ id: number }>('SELECT id FROM conversations WHERE archived = 1 AND favorite = 0 AND parent_id IS NULL AND updated_at < ?', limit)) {
        if (this.deps.isGenerating(r.id)) continue;
        this.deps.deleteConversation(r.id);
        report.deleted++;
      }
    }
    if (s.cleanAttachments) report.attachments = this.cleanAttachments();
    return report;
  }

  /** Pièces jointes plus référencées par aucun message, brouillon, file, projet ou description. */
  private cleanAttachments(): number {
    const used = new Set<number>();
    const scan = (json: string | null) => {
      if (!json) return;
      for (const m of json.matchAll(/"attachment(?:Id)?"\s*:\s*\{[^}]*?"id"\s*:\s*(\d+)|"attachmentId"\s*:\s*(\d+)|"id"\s*:\s*(\d+)\s*,\s*"name"/g)) used.add(Number(m[1] ?? m[2] ?? m[3]));
    };
    for (const r of this.deps.db.all<{ parts_json: string }>('SELECT parts_json FROM messages')) scan(r.parts_json);
    for (const r of this.deps.db.all<{ draft_attachments_json: string }>('SELECT draft_attachments_json FROM conversations')) scan(r.draft_attachments_json);
    for (const r of this.deps.db.all<{ attachments_json: string }>('SELECT attachments_json FROM queued_inputs')) scan(r.attachments_json);
    for (const r of this.deps.db.all<{ attachment_id: number }>('SELECT attachment_id FROM project_attachments')) used.add(r.attachment_id);
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const orphans = this.deps.db.all<{ id: number; sha256: string }>('SELECT id, sha256 FROM attachments WHERE created_at < ?', day).filter((a) => !used.has(a.id));
    for (const a of orphans) this.deps.db.run('DELETE FROM attachments WHERE id = ?', a.id);
    // Fichiers dont plus aucune pièce jointe ne partage le contenu.
    const live = new Set(this.deps.db.all<{ sha256: string }>('SELECT DISTINCT sha256 FROM attachments').map((r) => r.sha256));
    for (const f of existsSync(this.deps.attachmentsDir) ? readdirSync(this.deps.attachmentsDir) : []) if (/^[0-9a-f]{64}$/.test(f) && !live.has(f)) rmSync(join(this.deps.attachmentsDir, f), { force: true });
    // Dossiers copiés et copies nommées (accès des outils) sans pièce jointe correspondante.
    for (const sub of ['folders', 'files']) {
      const dir = join(this.deps.attachmentsDir, sub);
      for (const f of existsSync(dir) ? readdirSync(dir) : []) if (/^[0-9a-f]{64}$/.test(f) && !live.has(f)) rmSync(join(dir, f), { recursive: true, force: true });
    }
    return orphans.length;
  }
}
