import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HarnessError, type CatalogModel, type ConnectionTestResult, type Id, type PlanItem, type ToolDisplay } from '@monolith/contracts';
import type { AdapterContext, ChatRequest, ExternalPermissionRequest, ExternalToolEvent, ProviderAdapter, ProviderConnection, StreamEvent } from './adapter.ts';
import { APP_VERSION } from '@monolith/contracts';

/**
 * Client ACP (Agent Client Protocol) : JSON-RPC 2.0 sur l'entrée/sortie standard d'un agent
 * externe (OpenCode, Gemini CLI, Claude Code…). L'agent garde son propre historique et exécute
 * ses outils ; le moteur fournit la lecture/écriture de fichiers dans la portée de la conversation
 * et soumet chaque demande d'autorisation de l'agent aux règles et à l'utilisateur.
 */

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const IDLE_MS = 15 * 60_000;

function quoteArg(a: string): string {
  return /^[\w@./:=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;
}

/** Processus d'agent : requêtes, notifications et requêtes entrantes. */
class AcpProcess {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private stderr = '';
  exited = false;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async (method) => {
    throw Object.assign(new Error(`Méthode non prise en charge : ${method}`), { code: -32601 });
  };

  constructor(command: string, args: string[], cwd: string, env: Record<string, string>, account: 'chatgpt' | null = null) {
    const win = process.platform === 'win32';
    // Abonnement ChatGPT : jamais de facturation d'API à l'insu de l'utilisateur ni de Codex substitué.
    const base: NodeJS.ProcessEnv = { ...process.env };
    if (account === 'chatgpt') for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_PATH']) delete base[k];
    // Windows : les agents installés par npm sont des scripts .cmd, lancés par l'interpréteur de commandes.
    this.proc = win
      ? spawn([command, ...args].map(quoteArg).join(' '), [], { cwd, env: { ...base, ...env }, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (d: string) => this.onData(d));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    const fail = (message: string) => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new HarnessError('provider_unreachable', message));
      this.pending.clear();
    };
    this.proc.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? `Commande introuvable : ${command}. Installez l’agent ou indiquez son chemin complet.` : `Agent : ${e.message}`));
    this.proc.on('exit', (code) => fail(`L’agent s’est arrêté (code ${code ?? '?'}).${this.stderr.trim() ? ` ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
  }

  private onData(d: string): void {
    this.buffer += d;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // journal de l'agent écrit sur la sortie standard : ignoré
      }
      if (msg.method && msg.id !== undefined) {
        this.onRequest(msg.method, msg.params ?? {}).then(
          (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
          (e: Error & { code?: number }) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
        );
      } else if (msg.method) {
        this.onNotification(msg.method, msg.params ?? {});
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new HarnessError(msg.error.code === -32000 ? 'provider_auth' : 'provider_bad_request', `Agent : ${msg.error.message}`));
        else p?.resolve(msg.result);
      }
    }
  }

  private write(m: RpcMessage): void {
    if (!this.exited) this.proc.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  request<T>(method: string, params: Json, timeoutMs = 0): Promise<T> {
    if (this.exited) return Promise.reject(new HarnessError('provider_unreachable', 'L’agent n’est plus actif.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => (this.pending.delete(id), reject(new HarnessError('provider_timeout', `L’agent ne répond pas (${method}).`))), timeoutMs) : null;
      this.pending.set(id, {
        resolve: (v) => (timer && clearTimeout(timer), resolve(v as T)),
        reject: (e) => (timer && clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Arrête l'agent et ses sous-processus (sous Windows, l'interpréteur de commandes ne les arrête pas seul). */
  kill(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 3000);
      this.proc.once('exit', () => (clearTimeout(timer), resolve()));
    });
    if (!this.exited) {
      this.exited = true;
      try {
        this.proc.stdin!.end();
        if (process.platform === 'win32' && this.proc.pid) spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else this.proc.kill();
      } catch {
        /* déjà arrêté */
      }
    }
    return done;
  }
}

interface Session {
  proc: AcpProcess;
  sessionId: string;
  key: string;
  images: boolean;
  fresh: boolean;
  timer: NodeJS.Timeout | null;
  /** Gestionnaire du tour en cours (mises à jour, autorisations). */
  turn: { emit: (e: StreamEvent) => void; ctx: AdapterContext; signal: AbortSignal } | null;
}

const effectsOf = (kind: unknown): ExternalPermissionRequest['effects'] => {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
      return ['read'];
    case 'edit':
    case 'delete':
    case 'move':
      return ['write'];
    case 'fetch':
      return ['network'];
    default:
      return ['exec'];
  }
};

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: Json) => {
      if (c.type === 'content') {
        const inner = c.content as Json | undefined;
        return inner?.type === 'text' ? String(inner.text ?? '') : '';
      }
      if (c.type === 'diff') return `Modification de ${String(c.path)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function diffDisplay(content: unknown): ToolDisplay | null {
  if (!Array.isArray(content)) return null;
  const changes = content
    .filter((c: Json) => c.type === 'diff')
    .map((c: Json) => ({ path: String(c.path), status: (c.oldText == null ? 'created' : 'modified') as 'created' | 'modified', before: String(c.oldText ?? ''), after: String(c.newText ?? '') }));
  return changes.length ? { kind: 'changes', changes, applied: true } : null;
}

export class AcpAdapter implements ProviderAdapter {
  readonly kind = 'acp' as const;
  private readonly sessions = new Map<Id, Session>();

  async listModels(): Promise<CatalogModel[]> {
    // L'agent choisit lui-même ses modèles : une seule entrée, « Agent ».
    return [{ id: 'agent', label: 'Agent', owner: null, contextWindow: null, maxOutputTokens: null, capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: true } }];
  }

  async test(conn: ProviderConnection): Promise<ConnectionTestResult> {
    const started = performance.now();
    const acp = conn.options.acp;
    if (!acp.command.trim()) return { ok: false, status: null, latencyMs: 0, modelCount: null, code: 'invalid_argument', message: 'Commande de l’agent manquante', usedCompletion: false };
    const proc = new AcpProcess(acp.command, acp.args, process.cwd(), acp.env, acp.account ?? null);
    try {
      const r = await proc.request<{ protocolVersion?: number; agentInfo?: { name?: string; version?: string } }>('initialize', this.initParams(), 30_000);
      const name = r.agentInfo?.name ? ` ${r.agentInfo.name}${r.agentInfo.version ? ` ${r.agentInfo.version}` : ''}` : '';
      return { ok: true, status: null, latencyMs: Math.round(performance.now() - started), modelCount: 1, code: 'ok', message: `Agent ACP${name} (protocole ${r.protocolVersion ?? '?'})`, usedCompletion: false };
    } catch (e) {
      return { ok: false, status: null, latencyMs: Math.round(performance.now() - started), modelCount: null, code: e instanceof HarnessError ? e.code : 'internal', message: (e as Error).message, usedCompletion: false };
    } finally {
      await proc.kill();
    }
  }

  /**
   * Connexion du compte de l'agent (comme la v1) : méthode `chat-gpt` annoncée par l'adaptateur Codex,
   * qui ouvre la connexion OpenAI dans le navigateur. Les identifiants restent gérés par Codex.
   */
  async authenticate(conn: ProviderConnection, signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const acp = conn.options.acp;
    if (acp.account !== 'chatgpt') return { ok: false, message: 'Cette connexion n’a pas de compte à connecter.' };
    const proc = new AcpProcess(acp.command, acp.args, process.cwd(), acp.env, 'chatgpt');
    const stop = () => void proc.kill();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const init = await proc.request<{ protocolVersion?: number; authMethods?: { id?: string }[] }>('initialize', this.initParams(), 120_000);
      const method = (init.authMethods ?? []).map((m) => m.id).find((id) => id === 'chat-gpt' || id === 'chatgpt');
      if (!method) return { ok: false, message: 'Cet adaptateur n’annonce pas la connexion ChatGPT : utilisez l’adaptateur Codex ACP compatible.' };
      // L'utilisateur termine la connexion dans son navigateur.
      await proc.request('authenticate', { methodId: method }, 10 * 60_000);
      return { ok: true, message: 'Compte ChatGPT connecté (identifiants gérés par Codex).' };
    } catch (e) {
      return { ok: false, message: signal.aborted ? 'Connexion annulée.' : (e as Error).message };
    } finally {
      signal.removeEventListener('abort', stop);
      await proc.kill();
    }
  }

  private initParams(): Json {
    return { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'monolith-harness', version: APP_VERSION } };
  }

  /** Session de la conversation : réutilisée tant que la commande et le dossier ne changent pas. */
  private async session(conn: ProviderConnection, ctx: AdapterContext): Promise<Session> {
    const acp = conn.options.acp;
    if (!acp.command.trim()) throw new HarnessError('invalid_argument', 'Commande de l’agent ACP manquante (Réglages › Fournisseurs).');
    const key = JSON.stringify([acp.command, acp.args, acp.env, acp.account ?? null, ctx.cwd]);
    const existing = this.sessions.get(ctx.conversationId);
    if (existing && existing.key === key && !existing.proc.exited) return existing;
    if (existing) await this.close(ctx.conversationId);
    const proc = new AcpProcess(acp.command, acp.args, ctx.cwd, acp.env, acp.account ?? null);
    try {
      const init = await proc.request<{ agentCapabilities?: { promptCapabilities?: { image?: boolean } } }>('initialize', this.initParams(), 60_000);
      const created = await proc.request<{ sessionId: string }>('session/new', { cwd: ctx.cwd, mcpServers: [] }, 60_000);
      const session: Session = { proc, sessionId: created.sessionId, key, images: init.agentCapabilities?.promptCapabilities?.image === true, fresh: true, timer: null, turn: null };
      proc.onNotification = (method, params) => this.onNotification(session, method, params);
      proc.onRequest = (method, params) => this.onRequest(session, method, params);
      this.sessions.set(ctx.conversationId, session);
      return session;
    } catch (e) {
      await proc.kill();
      throw e;
    }
  }

  private close(conversationId: Id): Promise<void> {
    const s = this.sessions.get(conversationId);
    if (!s) return Promise.resolve();
    if (s.timer) clearTimeout(s.timer);
    this.sessions.delete(conversationId);
    return s.proc.kill();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private readonly tools = new Map<string, ExternalToolEvent>();

  private onNotification(s: Session, method: string, params: Json): void {
    if (method !== 'session/update' || !s.turn) return;
    const u = (params.update ?? {}) as Json;
    const emit = s.turn.emit;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const c = u.content as Json | undefined;
        if (c?.type === 'text' && typeof c.text === 'string') emit({ type: u.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning', text: c.text });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        const prev = this.tools.get(id);
        const status = u.status === 'completed' ? 'done' : u.status === 'failed' ? 'error' : (prev?.status ?? 'running');
        const text = contentText(u.content);
        const ev: ExternalToolEvent = {
          id,
          name: `acp_${String(u.kind ?? prev?.name.replace(/^acp_/, '') ?? 'other')}`,
          family: 'acp',
          title: String(u.title ?? prev?.title ?? 'Action de l’agent'),
          status,
          arguments: u.rawInput !== undefined ? JSON.stringify(u.rawInput) : (prev?.arguments ?? '{}'),
          result: text || (u.rawOutput !== undefined ? JSON.stringify(u.rawOutput).slice(0, 20_000) : (prev?.result ?? null)),
          display: diffDisplay(u.content) ?? prev?.display ?? null,
        };
        this.tools.set(id, ev);
        emit({ type: 'external_tool', call: ev });
        break;
      }
      case 'plan': {
        const items: PlanItem[] = (Array.isArray(u.entries) ? (u.entries as Json[]) : []).map((e) => ({ text: String(e.content ?? ''), status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending' }));
        emit({ type: 'external_tool', call: { id: `plan-${s.sessionId}`, name: 'acp_plan', family: 'planning', title: 'Plan de l’agent', status: 'done', arguments: '{}', result: items.map((i) => `[${i.status}] ${i.text}`).join('\n'), display: { kind: 'plan', items } } });
        break;
      }
    }
  }

  private async onRequest(s: Session, method: string, params: Json): Promise<unknown> {
    const turn = s.turn;
    if (!turn) throw new Error('Aucune requête en cours');
    const { ctx, signal } = turn;
    switch (method) {
      case 'session/request_permission': {
        const call = (params.toolCall ?? {}) as Json;
        const options = (Array.isArray(params.options) ? params.options : []) as { optionId: string; kind: string }[];
        const locations = Array.isArray(call.locations) ? (call.locations as Json[]).map((l) => String(l.path ?? '')).filter(Boolean) : [];
        const prev = this.tools.get(String(call.toolCallId ?? ''));
        const decision = await ctx.requestPermission(
          {
            toolName: prev?.name ?? `acp_${String(call.kind ?? 'other')}`,
            family: 'acp',
            title: String(call.title ?? prev?.title ?? 'Action de l’agent'),
            arguments: call.rawInput !== undefined ? JSON.stringify(call.rawInput) : (prev?.arguments ?? '{}'),
            resources: locations,
            effects: effectsOf(call.kind ?? prev?.name.replace(/^acp_/, '')),
          },
          signal,
        );
        const pick = (kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
        const chosen = decision.allow ? pick(decision.always ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
        return { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } };
      }
      case 'fs/read_text_file': {
        const path = ctx.resolvePath(String(params.path ?? ''), false);
        let text = readFileSync(path, 'utf8');
        if (typeof params.line === 'number' || typeof params.limit === 'number') {
          const lines = text.split('\n');
          const start = Math.max(0, (Number(params.line) || 1) - 1);
          text = lines.slice(start, typeof params.limit === 'number' ? start + params.limit : undefined).join('\n');
        }
        return { content: text };
      }
      case 'fs/write_text_file': {
        const path = ctx.resolvePath(String(params.path ?? ''), true);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(params.content ?? ''), 'utf8');
        return null;
      }
      default:
        throw Object.assign(new Error(`Méthode non prise en charge : ${method}`), { code: -32601 });
    }
  }

  async *stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const ctx = request.context;
    if (!ctx) throw new HarnessError('unavailable', 'Agent ACP indisponible dans ce contexte.');
    const s = await this.session(conn, ctx);
    if (s.timer) clearTimeout(s.timer);

    // Seul le dernier message de l'utilisateur est envoyé : l'agent conserve son propre historique.
    const last = [...request.messages].reverse().find((m) => m.role === 'user');
    const prompt: Json[] = [];
    if (s.fresh && ctx.transcript.trim()) prompt.push({ type: 'text', text: `Contexte (échanges précédents de cette conversation) :\n${ctx.transcript}\n\n---\n` });
    if (last) {
      for (const p of typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content) {
        if (p.type === 'text') prompt.push({ type: 'text', text: p.text });
        else if (s.images) {
          const m = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
          if (m) prompt.push({ type: 'image', mimeType: m[1], data: m[2] });
        } else prompt.push({ type: 'text', text: '[Image non transmise : l’agent n’accepte pas les images.]' });
      }
    }
    s.fresh = false;

    const queue: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (e: StreamEvent) => {
      queue.push(e);
      wake?.();
    };
    s.turn = { emit: push, ctx, signal };
    const onAbort = () => s.proc.notify('session/cancel', { sessionId: s.sessionId });
    signal.addEventListener('abort', onAbort, { once: true });
    let done = false;
    let outcome: { stopReason?: string } | null = null;
    let failure: unknown = null;
    s.proc
      .request<{ stopReason?: string }>('session/prompt', { sessionId: s.sessionId, prompt })
      .then((r) => (outcome = r))
      .catch((e: unknown) => (failure = e))
      .finally(() => {
        done = true;
        wake?.();
      });
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      while (queue.length) yield queue.shift()!;
    } finally {
      signal.removeEventListener('abort', onAbort);
      s.turn = null;
      s.timer = setTimeout(() => void this.close(ctx.conversationId), IDLE_MS);
      s.timer.unref?.();
    }
    if (failure) throw failure;
    if (signal.aborted) throw new HarnessError('cancelled', 'Génération annulée');
    const reason = (outcome as { stopReason?: string } | null)?.stopReason ?? 'end_turn';
    if (reason === 'refusal') yield { type: 'notice', level: 'warning', code: 'agent_refusal', text: 'L’agent a refusé de poursuivre.' };
    yield { type: 'finish', reason: reason === 'end_turn' ? 'stop' : reason === 'max_tokens' ? 'length' : 'other', raw: reason };
  }
}
