import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SETTINGS } from '@monolith/contracts';
import { checkProxy, WebHttpClient, webHttpTools } from '../src/tools/web-http.ts';
import type { ToolContext } from '../src/tools/types.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const seen: { url: string; cookie: string | undefined; ua: string | undefined; custom: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', cookie: req.headers.cookie, ua: req.headers['user-agent'], custom: req.headers['x-custom'] as string | undefined });
    if (req.url === '/login') {
      res.writeHead(302, { location: '/page', 'set-cookie': 'session=abc; Path=/; HttpOnly' });
      return res.end();
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<html><head><title>Doc</title></head><body><h1>Guide</h1><p>Introduction.</p><h2>Installation</h2><p>Lancez npm install monolith.</p>${'<p>remplissage</p>'.repeat(50)}<h2>Licence</h2><p>MIT.</p></body></html>`);
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(40_000));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  const dir = mkdtempSync(join(tmpdir(), 'mh-web-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const client = new WebHttpClient(dir, { allowPrivate: true });
  cleanups.push(() => client.dispose());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ctx = { conversationId: 1, settings: { ...DEFAULT_SETTINGS, web: { ...DEFAULT_SETTINGS.web, httpUseCookies: true } }, signal: AbortSignal.timeout(10_000), agentMode: 'execute' } as unknown as ToolContext;
  const tools = Object.fromEntries(webHttpTools(() => client).map((t) => [t.name, t]));
  return { client, base, seen, ctx, tools };
}

describe('client HTTP intégré (v1)', () => {
  it('Smart : redirection suivie, cookies, réponse enregistrée, recherche et lecture ciblées', async () => {
    const { base, seen, ctx, tools } = await setup();
    const r = await tools.web_http_request!.execute({ url: `${base}/login`, headers: { 'X-Custom': 'oui' } }, ctx);
    expect(r.result).toContain('HTTP 200');
    expect(r.result).toContain('après 1 redirection');
    expect(r.result).toContain('## Installation');
    const fileId = /file_id : (\w+)/.exec(r.result)![1]!;
    expect(seen[1]).toMatchObject({ url: '/page', cookie: 'session=abc', custom: 'oui' });
    expect(seen[0]!.ua).toContain('MonolithHarness');
    const found = await tools.web_http_search!.execute({ file_id: fileId, query: 'npm install' }, ctx);
    expect(found.result).toMatch(/1 occurrence\(s\)\n\d+:\d+ +Lancez npm install monolith\./);
    const line = Number(/\n(\d+):/.exec(found.result)![1]);
    const read = await tools.web_http_read!.execute({ file_id: fileId, start_line: line, line_count: 1 }, ctx);
    expect(read.result).toContain('Lancez npm install monolith.');
    await expect(tools.web_http_read!.execute({ file_id: 'w../../x', start_line: 1 }, ctx)).rejects.toThrow(/invalide/);
  });

  it('configuration par conversation, troncature, legacy et garde de proxy', async () => {
    const { base, seen, ctx, tools } = await setup();
    const conf = await tools.web_http_configure!.execute({ user_agent: 'TestAgent/1', response_mode: 'legacy', follow_redirects: false }, ctx);
    expect(JSON.parse(conf.result)).toMatchObject({ userAgent: 'TestAgent/1', responseMode: 'legacy', followRedirects: false, tls_validation: true });
    const r = await tools.web_http_request!.execute({ url: `${base}/login` }, ctx);
    expect(r.result).toContain('HTTP 302');
    expect(seen.at(-1)!.ua).toBe('TestAgent/1');
    await tools.web_http_configure!.execute({ reset: true }, ctx);
    await tools.web_http_configure!.execute({ timeout_sec: 10 }, ctx);
    const settings = { ...ctx.settings, web: { ...ctx.settings.web, httpMaxResponseKb: 16 } };
    const big = await tools.web_http_request!.execute({ url: `${base}/big` }, { ...ctx, settings } as ToolContext);
    expect(big.result).toContain('TRONQUÉ à 16 Ko');
    expect(checkProxy('http://127.0.0.1:3128')).toBe('http://127.0.0.1:3128');
    expect(() => checkProxy('http://user:pw@proxy:8080')).toThrow(/identifiants/);
    // Sans l'option de test, une adresse locale est refusée.
    const strict = new WebHttpClient(mkdtempSync(join(tmpdir(), 'mh-web-')));
    await expect(strict.request(1, strict.settings(1, DEFAULT_SETTINGS.web), { method: 'GET', url: `${base}/page` }, AbortSignal.timeout(5000))).rejects.toThrow(/locale|privée/);
    await strict.dispose();
  });
});
