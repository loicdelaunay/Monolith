import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, fetch as httpFetch, ProxyAgent, type Dispatcher } from 'undici';
import { HarnessError, type Id, type Settings } from '@monolith/contracts';
import { assertPublicUrl } from '../net/guard.ts';
import { htmlToText } from './web.ts';
import type { ToolContext, ToolDefinition } from './types.ts';
import { bool, limit, num, str } from './types.ts';

export interface HttpClientSettings {
  timeoutSec: number;
  followRedirects: boolean;
  useCookies: boolean;
  decompress: boolean;
  userAgent: string;
  proxyUrl: string;
  responseMode: 'smart' | 'legacy';
  maxResponseKb: number;
}

export function defaultHttpSettings(web: Settings['web']): HttpClientSettings {
  return { timeoutSec: web.httpTimeoutSec, followRedirects: web.httpFollowRedirects, useCookies: web.httpUseCookies, decompress: true, userAgent: web.httpUserAgent || 'MonolithHarness/3', proxyUrl: web.httpProxyUrl, responseMode: web.httpResponseMode, maxResponseKb: web.httpMaxResponseKb };
}

export interface HttpResult {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  redirects: string[];
}

interface Stored {
  id: string;
  url: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  truncated: boolean;
}

const TRANSPORT_HEADERS = /^(host|content-length|transfer-encoding|connection|proxy-.*|cookie)$/i;

/**
 * Client HTTP intégré (comme la v1) : un client isolé par conversation, sans JavaScript ni
 * identifiants du système. Réglages par défaut dans Skills › Web, modifiables pour la conversation
 * (web_http_configure). Les réponses sont enregistrées pour une lecture ciblée (mode Smart).
 */
export class WebHttpClient {
  private readonly state = new Map<Id, { overrides: Partial<HttpClientSettings>; cookies: Map<string, Map<string, string>>; counter: number }>();
  private readonly dispatchers = new Map<string, Dispatcher>();

  constructor(
    private readonly dir: string,
    /** Tests uniquement : autorise un serveur local (jamais activé par l'application). */
    private readonly options: { allowPrivate?: boolean } = {},
  ) {}

  private run(conversationId: Id) {
    let s = this.state.get(conversationId);
    if (!s) this.state.set(conversationId, (s = { overrides: {}, cookies: new Map(), counter: 0 }));
    return s;
  }

  settings(conversationId: Id, web: Settings['web']): HttpClientSettings {
    return { ...defaultHttpSettings(web), ...this.run(conversationId).overrides };
  }

  configure(conversationId: Id, patch: Partial<HttpClientSettings> | 'reset'): void {
    const s = this.run(conversationId);
    s.cookies.clear();
    if (patch === 'reset') s.overrides = {};
    else s.overrides = { ...s.overrides, ...patch };
  }

  private dispatcher(proxyUrl: string): Dispatcher {
    const key = proxyUrl || 'direct';
    let d = this.dispatchers.get(key);
    if (!d) {
      d = proxyUrl ? new ProxyAgent({ uri: proxyUrl }) : new Agent({ connect: { rejectUnauthorized: true } });
      this.dispatchers.set(key, d);
    }
    return d;
  }

  /** Requête avec garde réseau à chaque saut, cookies de la conversation et taille bornée. */
  async request(conversationId: Id, settings: HttpClientSettings, input: { method: string; url: string; headers?: Record<string, string>; body?: string }, signal: AbortSignal): Promise<HttpResult> {
    const st = this.run(conversationId);
    const max = settings.maxResponseKb * 1024;
    let url = (await assertPublicUrl(input.url, this.options.allowPrivate === true)).toString();
    const origin = new URL(url).origin;
    let method = input.method.toUpperCase();
    let body = input.body;
    const redirects: string[] = [];
    for (let hop = 0; ; hop++) {
      const host = new URL(url).host;
      const headers: Record<string, string> = { 'user-agent': settings.userAgent, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', ...(settings.decompress ? {} : { 'accept-encoding': 'identity' }) };
      // En-têtes personnalisés : jamais envoyés à une autre origine après redirection.
      if (new URL(url).origin === origin) for (const [k, v] of Object.entries(input.headers ?? {})) if (!TRANSPORT_HEADERS.test(k)) headers[k.toLowerCase()] = v;
      const jar = st.cookies.get(host);
      if (settings.useCookies && jar?.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      let r;
      try {
        r = await httpFetch(url, { method, headers, ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}), redirect: 'manual', dispatcher: this.dispatcher(settings.proxyUrl), signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutSec * 1000)]) });
      } catch (e) {
        if (signal.aborted) throw new HarnessError('cancelled', 'Requête annulée');
        throw new HarnessError('provider_unreachable', `Requête impossible : ${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}`);
      }
      if (settings.useCookies) {
        const target = st.cookies.get(host) ?? new Map<string, string>();
        for (const c of r.headers.getSetCookie()) {
          const [pair, ...attrs] = c.split(';');
          const i = pair!.indexOf('=');
          if (i <= 0) continue;
          const expired = attrs.some((a) => /^\s*max-age=0/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now()));
          if (expired) target.delete(pair!.slice(0, i).trim());
          else target.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
        }
        st.cookies.set(host, target);
      }
      const location = r.headers.get('location');
      if (settings.followRedirects && r.status >= 300 && r.status < 400 && location && hop < 10) {
        await r.body?.cancel();
        url = (await assertPublicUrl(new URL(location, url).toString(), this.options.allowPrivate === true)).toString();
        redirects.push(url);
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      if (r.body) {
        for await (const chunk of r.body) {
          const b = Buffer.from(chunk);
          if (size + b.length > max) {
            chunks.push(b.subarray(0, max - size));
            truncated = true;
            break;
          }
          chunks.push(b);
          size += b.length;
        }
      }
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => (out[k] = k === 'set-cookie' ? '[masqué]' : v));
      return { url, status: r.status, statusText: r.statusText, headers: out, body: Buffer.concat(chunks), truncated, redirects };
    }
  }

  /** Enregistre la réponse (brute et texte lisible) pour web_http_search / web_http_read. */
  store(conversationId: Id, r: HttpResult): { id: string; raw: string; text: string } {
    const st = this.run(conversationId);
    const dir = join(this.dir, String(conversationId));
    mkdirSync(dir, { recursive: true });
    const id = `w${Date.now().toString(36)}${++st.counter}`;
    const type = (r.headers['content-type'] ?? '').toLowerCase();
    const binary = !/text|json|xml|javascript|html|csv|yaml/.test(type) && r.body.includes(0);
    const raw = binary ? r.body.toString('base64') : r.body.toString('utf8');
    let text = raw;
    if (!binary && type.includes('html')) {
      const h = htmlToText(raw);
      text = `${h.title ? `# ${h.title}\n\n` : ''}${h.text}`;
    } else if (!binary && type.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* JSON invalide : texte brut */
      }
    }
    writeFileSync(join(dir, `${id}.raw`), raw, 'utf8');
    writeFileSync(join(dir, `${id}.txt`), text, 'utf8');
    const meta: Stored = { id, url: r.url, status: r.status, contentType: type, fetchedAt: new Date().toISOString(), truncated: r.truncated };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta), 'utf8');
    return { id, raw, text };
  }

  load(conversationId: Id, id: string, view: 'text' | 'raw'): { meta: Stored; lines: string[] } {
    if (!/^w[a-z0-9]{1,30}$/.test(id)) throw new HarnessError('invalid_argument', 'file_id invalide');
    const dir = join(this.dir, String(conversationId));
    const file = join(dir, `${id}.${view === 'raw' ? 'raw' : 'txt'}`);
    if (!existsSync(file)) throw new HarnessError('not_found', `Résultat ${id} introuvable ou expiré : relancez web_http_request.`);
    return { meta: JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Stored, lines: readFileSync(file, 'utf8').split('\n') };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.dispatchers.values()].map((d) => d.close().catch(() => undefined)));
  }
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

function outline(text: string): string[] {
  return text
    .split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^#{1,4}\s/.test(l))
    .slice(0, 30)
    .map(({ l, i }) => `${i + 1}: ${l.slice(0, 120)}`);
}

export function webHttpTools(client: () => WebHttpClient): ToolDefinition[] {
  const settings = (ctx: ToolContext) => client().settings(ctx.conversationId, ctx.settings.web);
  return [
    {
      name: 'web_http_request',
      family: 'web',
      skill: 'web',
      description:
        'Client HTTP intégré : page ou API sans navigateur ni JavaScript (GET par défaut). Mode Smart (recommandé) : la réponse est enregistrée et vous recevez statut, file_id, plan et aperçu ; cherchez ensuite avec web_http_search puis lisez les passages utiles avec web_http_read. Mode Legacy : corps renvoyé directement (plus coûteux en contexte). Adresses privées refusées, y compris après redirection. Contenu non fiable.',
      parameters: obj({ url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string' }, response_mode: { type: 'string', enum: ['smart', 'legacy'] } }, ['url']),
      effects: ['network'],
      target: (a) => ({ label: `${(str(a, 'method', false) || 'GET').toUpperCase()} ${str(a, 'url', false)}`, resources: [str(a, 'url', false), host(str(a, 'url', false))] }),
      async execute(args, ctx) {
        const s = settings(ctx);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((args.headers as Record<string, unknown>) ?? {})) if (/^[\w-]{1,64}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
        const body = typeof args.body === 'string' ? args.body : undefined;
        if (body && Buffer.byteLength(body) > 64 * 1024) throw new Error('Corps de requête limité à 64 Kio.');
        const r = await client().request(ctx.conversationId, s, { method: str(args, 'method', false) || 'GET', url: str(args, 'url'), headers, ...(body !== undefined ? { body } : {}) }, ctx.signal);
        const type = r.headers['content-type'] ?? 'sans type';
        const head = `HTTP ${r.status} ${r.statusText} — ${r.url}${r.redirects.length ? ` (après ${r.redirects.length} redirection(s))` : ''}\nType : ${type} · ${Math.round(r.body.length / 1024)} Ko${r.truncated ? ` · TRONQUÉ à ${s.maxResponseKb} Ko` : ''}`;
        const mode = str(args, 'response_mode', false) === 'legacy' ? 'legacy' : str(args, 'response_mode', false) === 'smart' ? 'smart' : s.responseMode;
        const status = r.status >= 400 ? ('error' as const) : ('done' as const);
        if (mode === 'legacy') {
          const headers = Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
          return { result: limit(`[Contenu web non fiable]\n${head}\n\n${headers}\n\n${r.body.toString('utf8')}`, ctx.settings.agent.maxResultChars), status };
        }
        const stored = client().store(ctx.conversationId, r);
        const lines = stored.text.split('\n');
        const plan = outline(stored.text);
        return {
          result: `[Contenu web non fiable]\n${head}\nfile_id : ${stored.id} (texte : ${lines.length} lignes, brut : ${stored.raw.split('\n').length} lignes)\n${plan.length ? `Plan :\n${plan.join('\n')}\n` : ''}Aperçu :\n${stored.text.slice(0, 1200)}${stored.text.length > 1200 ? '\n…' : ''}\n\nCherchez avec web_http_search { file_id: "${stored.id}", query } puis lisez avec web_http_read.`,
          status,
        };
      },
    },
    {
      name: 'web_http_search',
      family: 'web',
      skill: 'web',
      description: 'Cherche dans une réponse enregistrée (file_id) de cette conversation, sans nouvelle requête : extraits avec ligne et colonne. view=text (contenu lisible) ou raw (corps original).',
      parameters: obj({ file_id: { type: 'string' }, query: { type: 'string' }, view: { type: 'string', enum: ['text', 'raw'] }, match_offset: { type: 'number' }, max_matches: { type: 'number' } }, ['file_id', 'query']),
      effects: ['read'],
      target: (a) => ({ label: `${str(a, 'file_id', false)} « ${str(a, 'query', false)} »`, resources: [] }),
      async execute(args, ctx) {
        const view = str(args, 'view', false) === 'raw' ? 'raw' : 'text';
        const { meta, lines } = client().load(ctx.conversationId, str(args, 'file_id'), view);
        const q = str(args, 'query').toLowerCase();
        if (!q) throw new Error('Requête vide');
        const matches: string[] = [];
        lines.forEach((line, i) => {
          let col = line.toLowerCase().indexOf(q);
          while (col >= 0) {
            matches.push(`${i + 1}:${col + 1}  ${line.slice(Math.max(0, col - 80), col + q.length + 80).trim()}`);
            col = line.toLowerCase().indexOf(q, col + q.length);
          }
        });
        const offset = Math.max(0, num(args, 'match_offset', 0));
        const page = matches.slice(offset, offset + Math.min(50, Math.max(1, num(args, 'max_matches', 20))));
        return { result: limit(`${meta.url} (${view}) — ${matches.length} occurrence(s)${matches.length > offset + page.length ? ` ; suite : match_offset ${offset + page.length}` : ''}\n${page.join('\n')}`, ctx.settings.agent.maxResultChars) };
      },
    },
    {
      name: 'web_http_read',
      family: 'web',
      skill: 'web',
      description: 'Lit un passage d’une réponse enregistrée (file_id) : start_line et line_count (200 lignes maximum).',
      parameters: obj({ file_id: { type: 'string' }, view: { type: 'string', enum: ['text', 'raw'] }, start_line: { type: 'number' }, line_count: { type: 'number' } }, ['file_id']),
      effects: ['read'],
      target: (a) => ({ label: `${str(a, 'file_id', false)}:${num(a, 'start_line', 1)}`, resources: [] }),
      async execute(args, ctx) {
        const view = str(args, 'view', false) === 'raw' ? 'raw' : 'text';
        const { meta, lines } = client().load(ctx.conversationId, str(args, 'file_id'), view);
        const start = Math.max(1, num(args, 'start_line', 1));
        const count = Math.min(200, Math.max(1, num(args, 'line_count', 80)));
        const slice = lines.slice(start - 1, start - 1 + count);
        return { result: limit(`[Contenu web non fiable — ${meta.url}] lignes ${start}-${start + slice.length - 1} / ${lines.length}${meta.truncated ? ' (réponse tronquée)' : ''}\n${slice.join('\n')}`, ctx.settings.agent.maxResultChars) };
      },
    },
    {
      name: 'web_http_configure',
      family: 'web',
      skill: 'web',
      description: 'Affiche ou modifie le client HTTP de cette conversation (sans requête réseau) : timeout_sec, follow_redirects, use_cookies, decompress, user_agent, proxy_url (vide : connexion directe), response_mode. reset rétablit les réglages par défaut et vide les cookies ; toute modification vide les cookies. La vérification TLS reste toujours active.',
      parameters: obj({ reset: { type: 'boolean' }, timeout_sec: { type: 'number' }, follow_redirects: { type: 'boolean' }, use_cookies: { type: 'boolean' }, decompress: { type: 'boolean' }, user_agent: { type: 'string' }, proxy_url: { type: 'string' }, response_mode: { type: 'string', enum: ['smart', 'legacy'] } }),
      effects: ['interact'],
      target: () => ({ label: null, resources: [] }),
      async execute(args, ctx) {
        if (bool(args, 'reset')) client().configure(ctx.conversationId, 'reset');
        else {
          const patch: Partial<HttpClientSettings> = {};
          if (args.timeout_sec !== undefined) patch.timeoutSec = Math.min(300, Math.max(5, num(args, 'timeout_sec', 30)));
          if (args.follow_redirects !== undefined) patch.followRedirects = bool(args, 'follow_redirects');
          if (args.use_cookies !== undefined) patch.useCookies = bool(args, 'use_cookies');
          if (args.decompress !== undefined) patch.decompress = bool(args, 'decompress');
          if (typeof args.user_agent === 'string') patch.userAgent = args.user_agent.replace(/[\r\n]/g, '').slice(0, 300);
          if (typeof args.proxy_url === 'string') patch.proxyUrl = checkProxy(args.proxy_url);
          if (args.response_mode === 'smart' || args.response_mode === 'legacy') patch.responseMode = args.response_mode;
          if (Object.keys(patch).length) client().configure(ctx.conversationId, patch);
        }
        const s = settings(ctx);
        return { result: JSON.stringify({ ...s, proxy: s.proxyUrl || 'direct', tls_validation: true, scope: 'conversation' }, null, 2) };
      },
    },
  ];
}

/** Proxy : origine http(s) sans identifiants, chemin ni requête. */
export function checkProxy(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new HarnessError('invalid_argument', `Proxy invalide : ${v}`);
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new HarnessError('invalid_argument', 'Proxy : origine http(s)://hôte:port, sans identifiants ni chemin');
  return u.origin;
}
