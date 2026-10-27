import type { AgentMode, ConversationMode, Id, UsageRecord } from './model.ts';

// ---------- Sauvegardes ----------

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
  /** manuelle, ou automatique avant une migration du schéma. */
  kind: 'manual' | 'migration';
}

// ---------- Tableau de bord ----------

export interface DashboardQuery {
  /** Dates ISO (incluses) ; absentes : 30 derniers jours. */
  from?: string;
  to?: string;
  providerId?: Id | null;
  kind?: UsageRecord['kind'] | null;
}

export interface DashboardBucket {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}

export interface DashboardData {
  from: string;
  to: string;
  totals: { requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number; errors: number; estimated: number; avgFirstTokenMs: number | null };
  byDay: DashboardBucket[];
  byModel: DashboardBucket[];
  byKind: DashboardBucket[];
  providers: { id: Id; name: string }[];
}

// ---------- Diagnostics ----------

export interface DiagnosticsInfo {
  app: { version: string; platform: string; arch: string; node: string; dataDir: string; portable: boolean; schemaVersion: number; readOnly: boolean };
  engine: { rssMb: number; heapUsedMb: number; cpuPercent: number; uptimeSec: number };
  storage: { databaseMb: number; attachmentsMb: number; workspaceMb: number; logsMb: number; backupsMb: number };
  secrets: string;
  logs: { time: string; level: string; category: string; message: string }[];
}

// ---------- Tâches planifiées ----------

export interface ScheduledTask {
  id: Id;
  name: string;
  /** Expression CRON à 5 champs (minute heure jour mois jour-semaine) ou @hourly, @daily… */
  cron: string;
  timezone: string;
  prompt: string;
  projectId: Id | null;
  /** Conversation réutilisée à chaque exécution ; null : une nouvelle conversation par exécution. */
  conversationId: Id | null;
  mode: ConversationMode;
  agentMode: AgentMode;
  providerId: Id | null;
  model: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export type ScheduledTaskInput = Omit<ScheduledTask, 'id' | 'lastRunAt' | 'nextRunAt'> & { id?: Id };

export interface ScheduledRun {
  id: Id;
  taskId: Id;
  taskName: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'error';
  conversationId: Id | null;
  error: string | null;
}

// ---------- Notifications ----------

export interface NotificationItem {
  id: Id;
  time: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  conversationId: Id | null;
  read: boolean;
}

export interface MaintenanceReport {
  archived: number;
  deleted: number;
  attachments: number;
}
