import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { APP_VERSION, HarnessError } from '@monolith/contracts';
import { SseParser } from '../providers/sse.ts';

type Json = Record<string, unknown>;
interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code: number; message: string };
}

export const MCP_PROTOCOL = '2025-06-18';

interface Transport {
  request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: Json): Promise<void>;
  close(): Promise<void>;
  closed: boolean;
}

const quoteArg = (a: string) => (/^[\w@./:=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/** Transport stdio : JSON-RPC délimité par des fins de ligne. */
class StdioTransport implements Transport {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private stderr = '';
  closed = false;

  constructor(command: string, args: string[], env: Record<string, string>, cwd: string) {
    const win = process.platform === 'win32';
    this.proc = win
      ? spawn([command, ...args].map(quoteArg).join(' '), [], { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (d: string) => this.onData(d));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    const fail = (message: string) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new HarnessError('provider_unreachable', message));
      this.pending.clear();
    };
    this.proc.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? `Commande introuvable : ${command}` : e.message));
    this.proc.on('exit', (code) => fail(`Le serveur MCP s’est arrêté (code ${code ?? '?'}).${this.stderr.trim() ? ` ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
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
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // Aucune capacité client déclarée : les requêtes du serveur sont refusées proprement.
        this.write({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: `Méthode non prise en charge : ${msg.method}` } }) });
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new HarnessError('provider_bad_request', `MCP : ${msg.error.message}`));
        else p?.resolve(msg.result);
      }
    }
  }

  private write(m: RpcMessage): void {
    if (!this.closed) this.proc.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new HarnessError('provider_unreachable', 'Serveur MCP arrêté'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        this.pending.delete(id);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Annulé' } });
        done();
        reject(new HarnessError('cancelled', 'Appel MCP annulé'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done();
        reject(new HarnessError('provider_timeout', `Le serveur MCP ne répond pas (${method}).`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (v) => (done(), resolve(v)), reject: (e) => (done(), reject(e)) });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params: Json): Promise<void> {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 3000);
      this.proc.once('exit', () => (clearTimeout(timer), resolve()));
    });
    if (!this.closed) {
      this.closed = true;
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

/** Transport HTTP « streamable » : POST JSON-RPC, réponse JSON ou flux SSE, session `mcp-session-id`. */
class HttpTransport implements Transport {
  private nextId = 1;
  private session: string | null = null;
  closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async post(body: RpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': MCP_PROTOCOL, ...(this.session ? { 'mcp-session-id': this.session } : {}), ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    }).catch((e: Error) => {
      if (signal?.aborted) throw new HarnessError('cancelled', 'Appel MCP annulé');
      throw new HarnessError('provider_unreachable', `Serveur MCP injoignable : ${e.message}`);
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (r.status === 401 || r.status === 403) throw new HarnessError('provider_auth', `Serveur MCP : accès refusé (HTTP ${r.status}). Vérifiez l’en-tête d’authentification.`);
    if (!r.ok && r.status !== 202) throw new HarnessError('provider_bad_request', `Serveur MCP : HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    return r;
  }

  async request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const r = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal);
    const type = r.headers.get('content-type') ?? '';
    const pick = (msg: RpcMessage) => {
      if (msg.error) throw new HarnessError('provider_bad_request', `MCP : ${msg.error.message}`);
      return msg.result;
    };
    if (type.includes('text/event-stream') && r.body) {
      const parser = new SseParser();
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? parser.end() : parser.push(value);
        for (const ev of events) {
          try {
            const msg = JSON.parse(ev.data) as RpcMessage;
            if (msg.id === id) {
              void reader.cancel();
              return pick(msg);
            }
          } catch (e) {
            if (e instanceof HarnessError) throw e;
          }
        }
        if (done) break;
      }
      throw new HarnessError('provider_stream', 'Flux MCP terminé sans réponse');
    }
    const msg = (await r.json()) as RpcMessage | RpcMessage[];
    const found = Array.isArray(msg) ? msg.find((m) => m.id === id) : msg;
    if (!found) throw new HarnessError('provider_stream', 'Réponse MCP sans résultat');
    return pick(found);
  }

  async notify(method: string, params: Json): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, 15_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.session) await fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...this.headers }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }
}

export interface McpRawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Json;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface McpCallResult {
  content?: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource'; resource: { uri: string; text?: string } } | { type: string; [k: string]: unknown })[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Client MCP : initialisation, découverte paginée des outils, appels annulables. */
export class McpClient {
  serverInfo: { name: string; version: string } | null = null;

  private constructor(private readonly transport: Transport) {}

  static stdio(command: string, args: string[], env: Record<string, string>, cwd: string): McpClient {
    return new McpClient(new StdioTransport(command, args, env, cwd));
  }

  static http(url: string, headers: Record<string, string>): McpClient {
    return new McpClient(new HttpTransport(url, headers));
  }

  get closed(): boolean {
    return this.transport.closed;
  }

  async initialize(): Promise<void> {
    const r = (await this.transport.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'monolith-harness', version: APP_VERSION } }, 60_000)) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = { name: r.serverInfo?.name ?? '?', version: r.serverInfo?.version ?? '?' };
    await this.transport.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpRawTool[]> {
    const out: McpRawTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.transport.request('tools/list', cursor ? { cursor } : {}, 30_000)) as { tools?: McpRawTool[]; nextCursor?: string };
      out.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  callTool(name: string, args: Json, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult> {
    return this.transport.request('tools/call', { name, arguments: args }, timeoutMs, signal) as Promise<McpCallResult>;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
