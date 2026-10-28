import type { Id } from './model.ts';

/** Effets d'un outil : base des autorisations et des restrictions de mode. */
export type ToolEffect = 'read' | 'write' | 'exec' | 'network' | 'desktop' | 'interact';

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_permission'
  | 'running'
  | 'done'
  | 'error'
  | 'denied'
  | 'cancelled'
  | 'interrupted'
  /** Mode Proposition : changement préparé, non appliqué. */
  | 'proposed';

/**
 * Politique globale : refuser tout, demander, selon les règles (défaut), automatique (validateur
 * pour chaque action non couverte par la lecture automatique) ou autoriser tout (sans analyse).
 * Les règles Refuser et Demander s'appliquent toujours.
 */
export type PermissionPolicy = 'deny_all' | 'ask' | 'rules' | 'auto' | 'allow_all';
export const PERMISSION_POLICIES: PermissionPolicy[] = ['deny_all', 'ask', 'rules', 'auto', 'allow_all'];
export type PermissionScope = 'once' | 'conversation' | 'project' | 'global';

/** Comment un appel d'outil a été autorisé ou refusé (bouclier de la bulle d'outil). */
export interface PermissionRecord {
  decision: 'allow' | 'deny';
  /** `rule` : règle enregistrée ; `user` : réponse à la demande ; `policy` : politique globale ; `mode` : restriction du mode ; `automatic` : lecture dans la portée autorisée ; `validator` : validateur du mode Automatique. */
  source: 'rule' | 'user' | 'policy' | 'mode' | 'automatic' | 'validator';
  ruleId: Id | null;
  scope: PermissionScope | null;
  reason: string;
  decidedAt: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface Question {
  id: string;
  prompt: string;
  /** `single` par défaut ; `multiple` seulement sur demande explicite. */
  kind: 'single' | 'multiple' | 'text';
  options?: QuestionOption[];
  /** Choix avec réponse personnalisée. */
  allowCustom?: boolean;
}

export interface QuestionAnswer {
  questionId: string;
  optionIds: string[];
  text: string | null;
}

export interface ActionProposal {
  id: string;
  kind: 'continue' | 'agent' | 'new_chat' | 'queue';
  title: string;
  /** Consigne autonome, consultable avant le clic. */
  instructions: string;
  triggered: boolean;
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface FileChange {
  path: string;
  status: 'created' | 'modified' | 'deleted';
  before: string;
  after: string;
}

/** Représentation structurée d'un appel d'outil pour l'interface. */
export type ToolDisplay =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; startLine: number; endLine: number; totalLines: number; content: string }
  | { kind: 'list'; title: string; items: string[]; truncated: boolean }
  | { kind: 'changes'; changes: FileChange[]; applied: boolean; proposalIds?: Id[] }
  | { kind: 'command'; command: string; cwd: string; output: string; exitCode: number | null; status: 'running' | 'exited' | 'timeout' | 'killed'; terminalId: string }
  | { kind: 'plan'; items: PlanItem[] }
  | { kind: 'question'; questions: Question[]; answers: QuestionAnswer[] | null; cancelled: boolean }
  | { kind: 'actions'; actions: ActionProposal[] }
  | { kind: 'info'; entries: { label: string; value: string }[] }
  | { kind: 'image'; attachmentId: Id; caption: string }
  | { kind: 'subagents'; items: SubagentItem[] };

/** Suivi d'un sous-agent dans la bulle de l'outil de délégation. */
export interface SubagentItem {
  conversationId: Id;
  title: string;
  role: string;
  status: 'running' | 'done' | 'interrupted' | 'budget' | 'error' | 'cancelled';
  worktree: { path: string; branch: string } | null;
  summary: string;
}

export interface SubagentPreset {
  id: string;
  name: string;
  description: string;
  instructions: string;
  agentMode: 'plan' | 'propose' | 'execute';
  providerId: Id | null;
  model: string | null;
}

export interface SandboxChange {
  root: number;
  path: string;
  status: 'created' | 'modified' | 'deleted';
  /** L'original a changé depuis la création de la sandbox. */
  conflict: boolean;
  before: string;
  after: string;
  binary: boolean;
}

export interface SandboxStatus {
  enabled: boolean;
  roots: { original: string; copy: string }[];
  createdAt: string | null;
  changes: number;
}

export interface ToolCallRecord {
  /** Identifiant fourni par le modèle (ou généré). */
  id: string;
  name: string;
  family: string;
  effects: ToolEffect[];
  /** JSON brut envoyé par le modèle. */
  arguments: string;
  /** Cible lisible (chemin, commande…). */
  target: string | null;
  status: ToolCallStatus;
  /** Texte renvoyé au modèle (fidèle au résultat réel). */
  result: string | null;
  display: ToolDisplay | null;
  permission: PermissionRecord | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Données du fournisseur à renvoyer telles quelles (ex. signature de réflexion Gemini). */
  meta?: Record<string, string>;
  /** Exécuté hors du moteur (agent ACP, spécialiste d'un modèle composé) : affiché, jamais rejoué. */
  external?: boolean;
  /** Tour d'outils de la réponse : les appels d'un même tour sont rejoués ensemble, chaque tour séparément. */
  round?: number;
}

export interface PermissionRule {
  id: Id;
  scope: 'global' | 'project' | 'conversation';
  projectId: Id | null;
  conversationId: Id | null;
  /** Nom d'outil exact, ou `*`. */
  tool: string;
  /** Famille d'outils, ou `*`. */
  family: string;
  /** Motif de ressource (glob de chemin, commande, hôte) ; vide = toute ressource. */
  resource: string;
  decision: 'allow' | 'deny' | 'ask';
  origin: 'user' | 'import' | 'prompt';
  createdAt: string;
}

export interface PermissionDecisionLog {
  id: Id;
  conversationId: Id | null;
  tool: string;
  target: string | null;
  decision: 'allow' | 'deny';
  source: PermissionRecord['source'];
  ruleId: Id | null;
  scope: PermissionScope | null;
  reason: string;
  createdAt: string;
}

export interface PermissionRequest {
  requestId: string;
  conversationId: Id;
  messageId: Id;
  tool: string;
  family: string;
  effects: ToolEffect[];
  target: string | null;
  arguments: string;
  /** Aperçu des changements attendus (diff, commande…). */
  preview: ToolDisplay | null;
  reason: string;
}

export interface LoopReport {
  conversationId: Id;
  /** Appels répétés sans progrès (nom + arguments). */
  calls: { name: string; arguments: string; count: number }[];
}

export interface ConversationResource {
  id: Id;
  kind: 'folder' | 'file';
  path: string;
  available: boolean;
}

export interface ResourceScopeInfo {
  mode: 'inherit' | 'custom';
  items: ConversationResource[];
  /** Racines effectivement accessibles aux outils. */
  roots: string[];
  files: string[];
  privateDir: string;
  /** Fichiers d'instructions détectés et leur portée. */
  instructionFiles: { path: string; scope: string }[];
}

export interface FileProposal {
  id: Id;
  conversationId: Id;
  messageId: Id;
  callId: string;
  path: string;
  status: 'pending' | 'applied' | 'rejected' | 'conflict';
  change: FileChange;
  createdAt: string;
}

export interface SkillInfo {
  id: string;
  family: string;
  enabled: boolean;
  tools: string[];
  /** Disponibilité réelle sur cet hôte. */
  available: boolean;
  unavailableReason?: string;
}

export interface TerminalInfo {
  id: string;
  conversationId: Id;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'timeout' | 'killed';
  exitCode: number | null;
  startedAt: string;
}

export interface FileEntry {
  name: string;
  /** Chemin absolu canonique. */
  path: string;
  /** Chemin affiché (relatif à la racine). */
  display: string;
  type: 'file' | 'directory';
  size: number;
}

export interface FileContent {
  path: string;
  display: string;
  kind: 'text' | 'image' | 'binary' | 'too_large';
  mime: string;
  size: number;
  text?: string;
  dataBase64?: string;
}

export interface FileReference {
  input: string;
  exists: boolean;
  path: string | null;
  display: string | null;
  type: 'file' | 'directory' | null;
  line: number | null;
}

export interface GitStatusInfo {
  available: boolean;
  reason?: string;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}

export interface GitCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export type GitAction = 'stage' | 'unstage' | 'commit' | 'switch' | 'fetch' | 'pull' | 'push' | 'discard';
