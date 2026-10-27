import { HarnessError, type Id, type ScheduledRun, type ScheduledTask, type ScheduledTaskInput } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import type { ConversationService } from './conversations.ts';
import type { GenerationRunner } from '../generation/runner.ts';
import type { NotificationService } from './ops.ts';
import type { Logger } from '../log/logger.ts';
import { now } from '../util.ts';

// ---------------------------------------------------------------------------
// CRON : 5 champs (minute heure jour-du-mois mois jour-de-semaine), fuseau IANA
// ---------------------------------------------------------------------------

const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

function field(text: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    const n = NAMES[s.toLowerCase()] ?? Number(s);
    if (!Number.isInteger(n) || n < min || n > max + (label === 'jour de semaine' ? 1 : 0)) throw new HarnessError('invalid_argument', `CRON : valeur « ${s} » invalide pour ${label} (${min}–${max})`);
    return label === 'jour de semaine' && n === 7 ? 0 : n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new HarnessError('invalid_argument', `CRON : pas « ${stepText} » invalide`);
    let a: number;
    let b: number;
    if (range === '*') [a, b] = [min, max];
    else if (range!.includes('-')) [a, b] = range!.split('-').map(num) as [number, number];
    else [a, b] = [num(range!), stepText === undefined ? num(range!) : max];
    if (a > b) throw new HarnessError('invalid_argument', `CRON : intervalle « ${range} » invalide`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const text = (MACROS[expr.trim().toLowerCase()] ?? expr).trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new HarnessError('invalid_argument', 'CRON : 5 champs attendus (minute heure jour mois jour-de-semaine) ou @hourly, @daily, @weekly, @monthly');
  const [mi, h, d, mo, wd] = parts as [string, string, string, string, string];
  return { minutes: field(mi, 0, 59, 'minute'), hours: field(h, 0, 23, 'heure'), days: field(d, 1, 31, 'jour du mois'), months: field(mo, 1, 12, 'mois'), weekdays: field(wd, 0, 6, 'jour de semaine'), daysRestricted: d !== '*', weekdaysRestricted: wd !== '*' };
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Composantes locales d'un instant dans un fuseau. */
function zoned(ms: number, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) };
}

/** Prochaine échéance strictement après `after`, avec sauts par jour et par heure (≤ 1 an). */
export function nextRun(spec: CronSpec, tz: string, after: number): number | null {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const end = after + 366 * 86_400_000;
  while (t <= end) {
    const z = zoned(t, fmt);
    const dayOk = spec.daysRestricted && spec.weekdaysRestricted ? spec.days.has(z.day) || spec.weekdays.has(z.weekday) : spec.days.has(z.day) && spec.weekdays.has(z.weekday);
    if (!spec.months.has(z.month) || !dayOk) t += (24 * 60 - (z.hour * 60 + z.minute)) * 60_000;
    else if (!spec.hours.has(z.hour)) t += (60 - z.minute) * 60_000;
    else if (!spec.minutes.has(z.minute)) t += 60_000;
    else return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service : tâches, exécution pendant que l'application est ouverte, historique
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  project_id: number | null;
  conversation_id: number | null;
  mode: string;
  agent_mode: string;
  provider_id: number | null;
  model: string | null;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
}

/**
 * Tâches planifiées : vérifiées toutes les 30 s tant que l'application est ouverte (elles ne
 * réveillent pas un ordinateur en veille). Une échéance manquée pendant la fermeture n'est pas
 * rattrapée : la tâche repart à sa prochaine échéance.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<Id>();

  constructor(
    private readonly deps: {
      db: Database;
      events: EventBus;
      conversations: ConversationService;
      generation: () => GenerationRunner;
      notifications: NotificationService;
      notify: () => boolean;
      logger: Logger;
    },
  ) {}

  start(): void {
    // Échéances recalculées au démarrage (pas de rattrapage des exécutions manquées).
    for (const r of this.rows()) this.deps.db.run('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?', this.computeNext(r), r.id);
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private rows(): TaskRow[] {
    return this.deps.db.all<TaskRow>('SELECT * FROM scheduled_tasks ORDER BY id');
  }

  private map(r: TaskRow): ScheduledTask {
    return { id: r.id, name: r.name, cron: r.cron, timezone: r.timezone, prompt: r.prompt, projectId: r.project_id, conversationId: r.conversation_id, mode: r.mode as ScheduledTask['mode'], agentMode: r.agent_mode as ScheduledTask['agentMode'], providerId: r.provider_id, model: r.model, enabled: !!r.enabled, lastRunAt: r.last_run_at, nextRunAt: r.next_run_at };
  }

  private computeNext(r: Pick<TaskRow, 'cron' | 'timezone' | 'enabled'>): string | null {
    if (!r.enabled) return null;
    const n = nextRun(parseCron(r.cron), r.timezone, Date.now());
    return n === null ? null : new Date(n).toISOString();
  }

  list(): ScheduledTask[] {
    return this.rows().map((r) => this.map(r));
  }

  preview(cron: string, tz: string, count = 5): { next: string[] } {
    if (!validTimezone(tz)) throw new HarnessError('invalid_argument', `Fuseau horaire inconnu : ${tz}`);
    const spec = parseCron(cron);
    const out: string[] = [];
    let t = Date.now();
    for (let i = 0; i < Math.min(10, count); i++) {
      const n = nextRun(spec, tz, t);
      if (n === null) break;
      out.push(new Date(n).toISOString());
      t = n;
    }
    return { next: out };
  }

  save(input: ScheduledTaskInput): ScheduledTask {
    const name = String(input.name ?? '').trim().slice(0, 80);
    const prompt = String(input.prompt ?? '').trim();
    if (!name || !prompt) throw new HarnessError('invalid_argument', 'Nom et consigne obligatoires');
    if (!validTimezone(input.timezone)) throw new HarnessError('invalid_argument', `Fuseau horaire inconnu : ${input.timezone}`);
    parseCron(input.cron);
    if (input.conversationId !== null) this.deps.conversations.get(input.conversationId);
    const values = [name, input.cron.trim(), input.timezone, prompt.slice(0, 50_000), input.projectId, input.conversationId, input.mode === 'agent' ? 'agent' : 'chat', ['plan', 'propose', 'execute'].includes(input.agentMode) ? input.agentMode : 'plan', input.providerId, input.model, input.enabled ? 1 : 0] as const;
    let id: number;
    if (input.id !== undefined) {
      if (!this.deps.db.get('SELECT id FROM scheduled_tasks WHERE id = ?', input.id)) throw new HarnessError('not_found', 'Tâche introuvable');
      this.deps.db.run('UPDATE scheduled_tasks SET name = ?, cron = ?, timezone = ?, prompt = ?, project_id = ?, conversation_id = ?, mode = ?, agent_mode = ?, provider_id = ?, model = ?, enabled = ? WHERE id = ?', ...values, input.id);
      id = input.id;
    } else {
      id = this.deps.db.run('INSERT INTO scheduled_tasks (name, cron, timezone, prompt, project_id, conversation_id, mode, agent_mode, provider_id, model, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...values, now()).lastInsertRowid;
    }
    const row = this.deps.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', id)!;
    this.deps.db.run('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?', this.computeNext(row), id);
    this.changed();
    return this.map(this.deps.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', id)!);
  }

  delete(id: Id): void {
    this.deps.db.run('DELETE FROM scheduled_tasks WHERE id = ?', id);
    this.changed();
  }

  history(taskId?: Id, limit = 100): ScheduledRun[] {
    const rows = this.deps.db.all<{ id: number; task_id: number; task_name: string; started_at: string; finished_at: string | null; status: ScheduledRun['status']; conversation_id: number | null; error: string | null }>(
      `SELECT r.*, t.name AS task_name FROM scheduled_runs r JOIN scheduled_tasks t ON t.id = r.task_id ${taskId ? 'WHERE r.task_id = ?' : ''} ORDER BY r.id DESC LIMIT ?`,
      ...(taskId ? [taskId] : []),
      Math.min(500, limit),
    );
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, taskName: r.task_name, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, conversationId: r.conversation_id, error: r.error }));
  }

  private changed(): void {
    this.deps.events.emit('scheduler.changed', { tasks: this.list() });
  }

  async tick(): Promise<void> {
    const t = Date.now();
    for (const r of this.rows()) {
      if (!r.enabled || !r.next_run_at || Date.parse(r.next_run_at) > t || this.running.has(r.id)) continue;
      void this.run(r.id).catch((e: Error) => this.deps.logger.warn('scheduler', 'Exécution planifiée en échec', { task: r.name, error: e.message }));
    }
  }

  /** Exécute une tâche : nouvelle conversation (ou conversation fixe, file d'attente si occupée). */
  async run(id: Id): Promise<ScheduledRun> {
    const r = this.deps.db.get<TaskRow>('SELECT * FROM scheduled_tasks WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', 'Tâche introuvable');
    if (this.running.has(id)) throw new HarnessError('busy', 'Cette tâche est déjà en cours');
    this.running.add(id);
    const started = now();
    this.deps.db.run('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?', started, this.computeNext(r), id);
    const runId = this.deps.db.run("INSERT INTO scheduled_runs (task_id, started_at, status) VALUES (?, ?, 'running')", id, started).lastInsertRowid;
    this.changed();
    const finish = (status: 'done' | 'error', conversationId: Id | null, error: string | null) => {
      this.deps.db.run('UPDATE scheduled_runs SET finished_at = ?, status = ?, conversation_id = ?, error = ? WHERE id = ?', now(), status, conversationId, error, runId);
      if (this.deps.notify()) this.deps.notifications.add(status === 'done' ? 'success' : 'error', `Tâche planifiée « ${r.name} »`, status === 'done' ? 'Terminée.' : `Échec : ${error ?? ''}`, conversationId);
    };
    let conversationId: Id | null = r.conversation_id;
    try {
      const generation = this.deps.generation();
      if (conversationId === null) {
        const c = this.deps.conversations.create(r.project_id, `⏰ ${r.name} — ${new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`, { providerId: r.provider_id, model: r.model, reasoningLevel: 'auto' }, { titleSource: 'user' });
        conversationId = c.id;
        this.deps.conversations.update(c.id, { mode: r.mode as 'chat' | 'agent', agentMode: r.agent_mode as 'plan' });
      }
      const sent = await generation.send(conversationId, { text: r.prompt, mode: generation.isActive(conversationId) ? 'queue' : 'send' });
      if (sent.status === 'queued') {
        finish('done', conversationId, null);
      } else {
        const final = await generation.waitFor(conversationId);
        if (final === 'complete') finish('done', conversationId, null);
        else finish('error', conversationId, `Génération ${final ?? 'interrompue'}`);
      }
    } catch (e) {
      finish('error', conversationId, (e as Error).message);
    } finally {
      this.running.delete(id);
      this.changed();
    }
    return this.history(id, 1)[0]!;
  }
}
