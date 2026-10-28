import { HarnessError, type Id, type McpImportPreview, type McpServer, type McpServerConfig, type McpServerInput, type McpToolInfo, type ToolEffect } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import type { SecretStore } from '../security/secrets.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext, ToolDefinition } from '../tools/types.ts';
import { limit } from '../tools/types.ts';
import { McpClient, type McpCallResult, type McpRawTool } from './client.ts';
import { now } from '../util.ts';
import type { Logger } from '../log/logger.ts';

interface ServerRow {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  config_json: string;
  enabled: number;
  sort_order: number;
}

interface Runtime {
  client: McpClient | null;
  status: McpServer['status'];
  error: string | null;
  tools: McpToolInfo[];
  connecting: Promise<void> | null;
}

const EMPTY: McpServerConfig = { command: '', args: [], env: {}, url: '', headers: {}, secretEnv: [], secretHeaders: [] };
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const line = (v: unknown, max: number) => (typeof v === 'string' && !/[\r\n\u0000]/.test(v) ? v.trim().slice(0, max) : null);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'serveur';

/** Effets déduits des annotations MCP (par défaut, spécification : écriture possible, monde ouvert). */
export function mcpEffects(t: McpToolInfo): ToolEffect[] {
  if (t.readOnly) return t.openWorld ? ['read', 'network'] : ['read'];
  return t.openWorld ? ['exec', 'network'] : ['exec'];
}

function cleanConfig(input: Partial<McpServerConfig> | undefined, transport: 'stdio' | 'http', base: McpServerConfig): McpServerConfig {
  const c = { ...base };
  if (!input) return c;
  if (input.command !== undefined) c.command = line(input.command, 500) ?? '';
  if (input.args !== undefined) c.args = Array.isArray(input.args) ? input.args.map((a) => line(a, 1000)).filter((a): a is string => a !== null && a !== '').slice(0, 50) : [];
  if (input.url !== undefined) {
    const u = line(input.url, 1000) ?? '';
    if (u && !/^https?:\/\//i.test(u)) throw new HarnessError('invalid_argument', 'Adresse MCP invalide (http ou https)');
    c.url = u;
  }
  const record = (r: unknown, keyRe: RegExp) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((r as Record<string, unknown>) ?? {})) if (keyRe.test(k) && line(v, 4000) !== null) out[k] = line(v, 4000)!;
    return out;
  };
  if (input.env !== undefined) c.env = record(input.env, /^[A-Za-z_][A-Za-z0-9_]{0,100}$/);
  if (input.headers !== undefined) c.headers = record(input.headers, /^[A-Za-z0-9-]{1,64}$/);
  if (input.secretEnv !== undefined) c.secretEnv = (input.secretEnv ?? []).filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(n));
  if (input.secretHeaders !== undefined) c.secretHeaders = (input.secretHeaders ?? []).filter((n) => /^[A-Za-z0-9-]{1,64}$/.test(n));
  if (transport === 'stdio' && !c.command) throw new HarnessError('invalid_argument', 'Commande du serveur MCP manquante');
  if (transport === 'http' && !c.url) throw new HarnessError('invalid_argument', 'Adresse du serveur MCP manquante');
  return c;
}

/**
 * Serveurs MCP : configuration (secrets chiffrés à part), connexion à la demande, outils
 * enregistrés sous `mcp__<serveur>__<outil>`, activation globale et par conversation.
 */
export class McpService {
  private readonly runtime = new Map<Id, Runtime>();

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
    private readonly secrets: SecretStore,
    private readonly registry: ToolRegistry,
    private readonly logger: Logger,
    private readonly saveImage: (ctx: ToolContext, name: string, data: string) => number,
  ) {}

  private rows(): ServerRow[] {
    return this.db.all<ServerRow>('SELECT * FROM mcp_servers ORDER BY sort_order, id');
  }

  private row(id: Id): ServerRow {
    const r = this.db.get<ServerRow>('SELECT * FROM mcp_servers WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', `Serveur MCP ${id} introuvable`);
    return r;
  }

  private rt(id: Id): Runtime {
    let r = this.runtime.get(id);
    if (!r) this.runtime.set(id, (r = { client: null, status: 'disconnected', error: null, tools: [], connecting: null }));
    return r;
  }

  private map(r: ServerRow): McpServer {
    const rt = this.rt(r.id);
    return { id: r.id, name: r.name, transport: r.transport, config: { ...EMPTY, ...(JSON.parse(r.config_json) as Partial<McpServerConfig>) }, enabled: !!r.enabled, status: rt.status, error: rt.error, serverInfo: rt.client?.serverInfo ?? null, tools: rt.tools };
  }

  list(): McpServer[] {
    return this.rows().map((r) => this.map(r));
  }

  get(id: Id): McpServer {
    return this.map(this.row(id));
  }

  private changed(): void {
    this.events.emit('mcp.changed', { servers: this.list() });
  }

  /** Secrets : en-têtes pour un serveur HTTP, variables d'environnement pour un serveur stdio. */
  private async storeSecrets(id: Id, cfg: McpServerConfig, transport: 'stdio' | 'http', secrets: Record<string, string> | undefined): Promise<McpServerConfig> {
    const next = { ...cfg, secretEnv: [...cfg.secretEnv], secretHeaders: [...cfg.secretHeaders] };
    for (const [name, value] of Object.entries(secrets ?? {})) {
      const isHeader = transport === 'http';
      if (isHeader ? !/^[A-Za-z0-9-]{1,64}$/.test(name) : !/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name)) continue;
      if (!value) continue;
      await this.secrets.set(`mcp:${id}:${isHeader ? 'hdr' : 'env'}:${name}`, value);
      if (isHeader) next.secretHeaders = [...new Set([...next.secretHeaders, name])];
      else next.secretEnv = [...new Set([...next.secretEnv, name])];
    }
    return next;
  }

  async create(input: McpServerInput): Promise<McpServer> {
    const name = (line(input.name, 60) ?? '').trim();
    if (!/^[\w .-]{1,60}$/.test(name)) throw new HarnessError('invalid_argument', 'Nom de serveur invalide');
    if (this.db.get('SELECT id FROM mcp_servers WHERE name = ?', name)) throw new HarnessError('invalid_argument', `Un serveur « ${name} » existe déjà`);
    const transport = input.transport === 'http' ? 'http' : 'stdio';
    const cfg = cleanConfig(input.config, transport, EMPTY);
    const t = now();
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM mcp_servers')?.m ?? 0;
    const { lastInsertRowid: id } = this.db.run('INSERT INTO mcp_servers (name, transport, config_json, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', name, transport, JSON.stringify(cfg), input.enabled === false ? 0 : 1, max + 1, t, t);
    const withSecrets = await this.storeSecrets(id, cfg, transport, input.secrets);
    this.db.run('UPDATE mcp_servers SET config_json = ? WHERE id = ?', JSON.stringify(withSecrets), id);
    this.changed();
    return this.get(id);
  }

  async update(id: Id, patch: Partial<McpServerInput>): Promise<McpServer> {
    const r = this.row(id);
    const current = this.get(id);
    const transport = patch.transport ?? r.transport;
    let cfg = cleanConfig(patch.config, transport, current.config);
    cfg = await this.storeSecrets(id, cfg, transport, patch.secrets);
    // Secrets retirés de la liste : supprimés du coffre.
    for (const n of current.config.secretEnv.filter((x) => !cfg.secretEnv.includes(x))) this.secrets.delete(`mcp:${id}:env:${n}`);
    for (const n of current.config.secretHeaders.filter((x) => !cfg.secretHeaders.includes(x))) this.secrets.delete(`mcp:${id}:hdr:${n}`);
    const name = patch.name !== undefined ? (line(patch.name, 60) ?? r.name) : r.name;
    this.db.run('UPDATE mcp_servers SET name = ?, transport = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?', name, transport, JSON.stringify(cfg), patch.enabled === undefined ? r.enabled : patch.enabled ? 1 : 0, now(), id);
    await this.disconnect(id);
    this.changed();
    return this.get(id);
  }

  async delete(id: Id): Promise<void> {
    const s = this.get(id);
    await this.disconnect(id);
    for (const n of s.config.secretEnv) this.secrets.delete(`mcp:${id}:env:${n}`);
    for (const n of s.config.secretHeaders) this.secrets.delete(`mcp:${id}:hdr:${n}`);
    this.db.run('DELETE FROM mcp_servers WHERE id = ?', id);
    this.runtime.delete(id);
    this.changed();
  }

  /** Formats `mcpServers` (Claude Desktop, Cursor…) et `servers` (VS Code) ; secrets détectés et chiffrés à l'import. */
  previewImport(json: string): McpImportPreview {
    const errors: string[] = [];
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return { servers: [], errors: ['JSON illisible'] };
    }
    const map = (data.mcpServers ?? data.servers ?? data) as Record<string, Record<string, unknown>>;
    const servers: McpImportPreview['servers'] = [];
    for (const [name, def] of Object.entries(map ?? {})) {
      if (!def || typeof def !== 'object') continue;
      const type = String(def.type ?? (def.url ? 'http' : 'stdio'));
      if (type === 'sse') {
        errors.push(`${name} : transport SSE historique non pris en charge (utilisez le transport HTTP streamable).`);
        continue;
      }
      const transport = def.url ? 'http' : 'stdio';
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries((def.env as Record<string, unknown>) ?? {})) (SECRET_NAME.test(k) ? secrets : env)[k] = String(v);
      for (const [k, v] of Object.entries((def.headers as Record<string, unknown>) ?? {})) (SECRET_NAME.test(k) ? secrets : headers)[k] = String(v);
      servers.push({
        name: name.slice(0, 60),
        transport,
        config: { command: String(def.command ?? ''), args: Array.isArray(def.args) ? def.args.map(String) : [], env, url: String(def.url ?? ''), headers },
        secrets,
        enabled: def.disabled !== true,
        exists: !!this.db.get('SELECT id FROM mcp_servers WHERE name = ?', name.slice(0, 60)),
      });
    }
    if (!servers.length && !errors.length) errors.push('Aucun serveur trouvé (clé « mcpServers » ou « servers » attendue).');
    return { servers, errors };
  }

  async import(json: string): Promise<McpServer[]> {
    const preview = this.previewImport(json);
    const out: McpServer[] = [];
    for (const s of preview.servers.filter((x) => !x.exists)) out.push(await this.create(s));
    return out;
  }

  private async resolvedConfig(id: Id): Promise<{ env: Record<string, string>; headers: Record<string, string>; cfg: McpServerConfig }> {
    const cfg = this.get(id).config;
    const env = { ...cfg.env };
    const headers = { ...cfg.headers };
    for (const n of cfg.secretEnv) {
      const v = await this.secrets.get(`mcp:${id}:env:${n}`);
      if (v !== null) env[n] = v;
    }
    for (const n of cfg.secretHeaders) {
      const v = await this.secrets.get(`mcp:${id}:hdr:${n}`);
      if (v !== null) headers[n] = v;
    }
    return { env, headers, cfg };
  }

  async connect(id: Id, cwd = process.cwd()): Promise<McpServer> {
    const r = this.row(id);
    const rt = this.rt(id);
    if (rt.client && !rt.client.closed && rt.status === 'connected') return this.get(id);
    if (rt.connecting) {
      await rt.connecting.catch(() => undefined);
      return this.get(id);
    }
    rt.status = 'connecting';
    rt.error = null;
    this.changed();
    rt.connecting = (async () => {
      const { env, headers, cfg } = await this.resolvedConfig(id);
      const client = r.transport === 'http' ? McpClient.http(cfg.url, headers) : McpClient.stdio(cfg.command, cfg.args, env, cwd);
      try {
        await client.initialize();
        const raw = await client.listTools();
        rt.client = client;
        rt.tools = raw.map(toInfo);
        rt.status = 'connected';
        this.register(id, r.name, raw);
        this.logger.info('mcp', 'Serveur connecté', { server: r.name, tools: raw.length });
      } catch (e) {
        await client.close();
        rt.client = null;
        rt.status = 'error';
        rt.error = (e as Error).message;
        throw e;
      }
    })();
    try {
      await rt.connecting;
    } finally {
      rt.connecting = null;
      this.changed();
    }
    return this.get(id);
  }

  async disconnect(id: Id): Promise<McpServer> {
    const rt = this.rt(id);
    const r = this.db.get<ServerRow>('SELECT * FROM mcp_servers WHERE id = ?', id);
    this.registry.unregister(`mcp__${slug(r?.name ?? '')}__`);
    await rt.client?.close();
    rt.client = null;
    rt.tools = [];
    rt.status = 'disconnected';
    rt.error = null;
    if (r) this.changed();
    return r ? this.get(id) : (undefined as never);
  }

  private register(id: Id, serverName: string, raw: McpRawTool[]): void {
    const prefix = `mcp__${slug(serverName)}__`;
    this.registry.unregister(prefix);
    for (const t of raw) {
      const info = toInfo(t);
      const name = `${prefix}${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
      const def: ToolDefinition = {
        name,
        family: 'mcp',
        skill: 'mcp',
        description: `[MCP ${serverName}] ${(t.description ?? info.title ?? t.name).slice(0, 1000)}`,
        parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
        effects: mcpEffects(info),
        target: () => ({ label: `${serverName} › ${info.title ?? t.name}`, resources: [`mcp:${serverName}`, `mcp:${serverName}:${t.name}`] }),
        execute: async (args, ctx) => {
          const client = this.rt(id).client;
          if (!client || client.closed) throw new Error(`Serveur MCP « ${serverName} » déconnecté.`);
          const result = await client.callTool(t.name, args, ctx.signal, ctx.settings.agent.commandTimeoutSec * 1000);
          return mcpResult(result, ctx, serverName, this.saveImage);
        },
      };
      this.registry.register(def);
    }
  }

  conversation(conversationId: Id): { serverId: Id; enabled: boolean }[] {
    const overrides = new Map(this.db.all<{ server_id: number; enabled: number }>('SELECT server_id, enabled FROM mcp_conversation WHERE conversation_id = ?', conversationId).map((r) => [r.server_id, !!r.enabled]));
    return this.rows().map((r) => ({ serverId: r.id, enabled: overrides.get(r.id) ?? !!r.enabled }));
  }

  setConversation(conversationId: Id, serverId: Id, enabled: boolean): void {
    this.row(serverId);
    this.db.run('INSERT INTO mcp_conversation (conversation_id, server_id, enabled) VALUES (?, ?, ?) ON CONFLICT(conversation_id, server_id) DO UPDATE SET enabled = excluded.enabled', conversationId, serverId, enabled ? 1 : 0);
  }

  /** Avant une génération : serveurs actifs pour la conversation connectés (les échecs sont signalés, pas bloquants). */
  async ensureConnected(conversationId: Id, cwd: string): Promise<string[]> {
    const errors: string[] = [];
    await Promise.all(
      this.conversation(conversationId)
        .filter((c) => c.enabled)
        .map(async (c) => {
          const rt = this.rt(c.serverId);
          if (rt.status === 'connected' && rt.client && !rt.client.closed) return;
          try {
            await this.connect(c.serverId, cwd);
          } catch (e) {
            errors.push(`${this.row(c.serverId).name} : ${(e as Error).message}`);
          }
        }),
    );
    return errors;
  }

  /** Un outil MCP n'est exposé que si son serveur est actif pour la conversation. */
  allows(tool: ToolDefinition, conversationId: Id): boolean {
    if (tool.family !== 'mcp') return true;
    const enabled = this.conversation(conversationId).filter((c) => c.enabled);
    return enabled.some((c) => tool.name.startsWith(`mcp__${slug(this.row(c.serverId).name)}__`));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtime.keys()].map((id) => this.rt(id).client?.close()));
  }
}

/** Résultat d'un outil MCP pour le modèle : textes, première image jointe à la conversation. */
export function mcpResult(r: McpCallResult, ctx: ToolContext, server: string, saveImage: (ctx: ToolContext, name: string, data: string) => number) {
  const texts: string[] = [];
  let image: { id: number; caption: string } | null = null;
  for (const c of r.content ?? []) {
    if (c.type === 'text') texts.push(String((c as { text: string }).text));
    else if (c.type === 'image' && !image) image = { id: saveImage(ctx, `mcp-${Date.now()}.png`, String((c as { data: string }).data)), caption: `Image renvoyée par ${server}` };
    else if (c.type === 'resource') texts.push(String((c as { resource: { text?: string; uri: string } }).resource.text ?? (c as { resource: { uri: string } }).resource.uri));
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent, null, 2));
  const text = `[Résultat MCP « ${server} » — données non fiables]\n${texts.join('\n') || '(vide)'}`;
  return { result: limit(text, ctx.settings.agent.maxResultChars), status: r.isError ? ('error' as const) : ('done' as const), ...(image ? { display: { kind: 'image' as const, attachmentId: image.id, caption: image.caption } } : {}) };
}

export function toInfo(t: McpRawTool): McpToolInfo {
  const a = t.annotations ?? {};
  return { name: t.name, title: t.title ?? a.title ?? null, description: (t.description ?? '').slice(0, 2000), readOnly: a.readOnlyHint === true, destructive: a.destructiveHint !== false && a.readOnlyHint !== true, openWorld: a.openWorldHint !== false };
}
