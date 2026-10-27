import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Harness, MemoryProtector, silentLogger } from '../src/index.ts';

/** Profil isolé dans un dossier temporaire ; aucune donnée utilisateur réelle n'est touchée. */
export function tempHarness(dir?: string): { harness: Harness; dir: string; cleanup: () => Promise<void> } {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'mh-test-'));
  const harness = new Harness({
    host: 'cli',
    data: { dir: root, source: 'argument', portable: false, locationFile: null },
    logger: silentLogger,
    keyProtector: new MemoryProtector(),
    changelog: '# Changelog de test',
  });
  return {
    harness,
    dir: root,
    cleanup: async () => {
      await harness.close();
      if (!dir) rmSync(root, { recursive: true, force: true });
    },
  };
}

export type MockHandler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

/** Faux fournisseur compatible OpenAI sur 127.0.0.1 (aucun appel réseau externe). */
export async function mockProvider(handler: MockHandler): Promise<{ url: string; requests: { path: string; body: unknown; headers: IncomingMessage['headers'] }[]; close: () => Promise<void> }> {
  const requests: { path: string; body: unknown; headers: IncomingMessage['headers'] }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => (body += d));
    req.on('end', () => {
      let parsed: unknown = body;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        /* corps brut */
      }
      requests.push({ path: req.url ?? '', body: parsed, headers: req.headers });
      void handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sseChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

/** Écrit une réponse SSE découpée en fragments de taille fixe (y compris au milieu des lignes). */
export async function writeFragmented(res: ServerResponse, payload: string, size = 7, delayMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const bytes = Buffer.from(payload, 'utf8');
  for (let i = 0; i < bytes.length; i += size) {
    res.write(bytes.subarray(i, i + size));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  res.end();
}

export function standardStream(text: string, reasoning = ''): string {
  let out = '';
  if (reasoning) out += sseChunk({ reasoning_content: reasoning });
  for (const word of text.split(/(?<= )/)) out += sseChunk({ content: word });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } })}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}
