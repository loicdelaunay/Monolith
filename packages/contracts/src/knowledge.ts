import type { Id } from './model.ts';

// ---------- Mémoire ----------

/** Portée d'une mémoire : conversation, projet, générale (tous projets) ou profil de l'utilisateur. */
export type MemoryScope = 'conversation' | 'project' | 'global' | 'user';

export interface Memory {
  id: Id;
  scope: MemoryScope;
  projectId: Id | null;
  conversationId: Id | null;
  title: string;
  content: string;
  tags: string[];
  /** Provenance : saisie de l'utilisateur, outil de l'agent ou écriture forcée. */
  source: 'user' | 'agent' | 'forced';
  sourceConversationId: Id | null;
  sourceMessageId: Id | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersion {
  version: number;
  title: string;
  content: string;
  tags: string[];
  source: Memory['source'];
  createdAt: string;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  projectId?: Id;
  conversationId?: Id;
  query?: string;
  sort?: 'updated' | 'created' | 'title' | 'scope';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface MemoryInput {
  id?: Id;
  scope: MemoryScope;
  projectId?: Id | null;
  conversationId?: Id | null;
  title: string;
  content: string;
  tags?: string[];
}

// ---------- MCP ----------

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  command: string;
  args: string[];
  /** Variables d'environnement non secrètes. */
  env: Record<string, string>;
  url: string;
  /** En-têtes HTTP non secrets. */
  headers: Record<string, string>;
  /** Noms des variables / en-têtes dont la valeur est enregistrée chiffrée. */
  secretEnv: string[];
  secretHeaders: string[];
}

export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export interface McpServer {
  id: Id;
  name: string;
  transport: McpTransport;
  config: McpServerConfig;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: McpToolInfo[];
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  config: Partial<McpServerConfig>;
  /** Valeurs secrètes (variables ou en-têtes), chiffrées par le moteur, jamais relues. */
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export interface McpImportPreview {
  servers: (McpServerInput & { exists: boolean })[];
  errors: string[];
}

// ---------- RAG ----------

export interface RagRootStatus {
  root: string;
  files: number;
  chunks: number;
  /** Fichiers modifiés, ajoutés ou supprimés depuis l'indexation. */
  stale: number;
  indexedAt: string | null;
  embeddingModel: string | null;
}

export interface RagStatus {
  roots: RagRootStatus[];
  indexing: boolean;
  progress: { done: number; total: number; file: string | null } | null;
}

// ---------- Skills personnalisés ----------

export interface CustomSkill {
  name: string;
  description: string;
  scope: 'global' | 'project';
  /** Dossier du skill (SKILL.md et ressources). */
  path: string;
  enabled: boolean;
}
