import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DownloadState } from '@monolith/contracts';
import { Harness, MemoryProtector, silentLogger } from '../src/index.ts';
import { readGgufMeta, writeGgufForTest } from '../src/local/gguf.ts';
import { estimateModel, quantOf } from '../src/local/service.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const GGUF = Buffer.concat([
  writeGgufForTest({ 'general.architecture': 'llama', 'general.name': 'Mini Llama', 'llama.context_length': 4096, 'llama.block_count': 22, 'llama.embedding_length': 2048, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 4, 'tokenizer.chat_template': '{{ messages }}' }),
  Buffer.alloc(300_000, 7),
]);
const SHA = createHash('sha256').update(GGUF).digest('hex');

async function hfMock() {
  const ranges: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/models?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ id: 'org/mini-llama-GGUF', downloads: 1234, likes: 5, lastModified: '2026-10-01T00:00:00Z' }]));
    }
    if (req.url === '/api/models/org/mini-llama-GGUF?blobs=true') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ siblings: [{ rfilename: 'README.md', size: 10 }, { rfilename: 'mini-llama.Q4_K_M.gguf', size: GGUF.length, lfs: { size: GGUF.length, sha256: SHA } }, { rfilename: 'gros-00001-of-00002.gguf', size: 9 }, { rfilename: 'mini-llama.Q8_0.gguf', size: GGUF.length, lfs: { size: GGUF.length, sha256: 'f'.repeat(64) } }] }));
    }
    if (req.url?.startsWith('/org/mini-llama-GGUF/resolve/main/')) {
      ranges.push(req.headers.range);
      const start = req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)![1]) : 0;
      res.writeHead(start ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': GGUF.length - start });
      return res.end(GGUF.subarray(start));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ranges };
}

function fakeEngine(dir: string): string {
  const script = join(import.meta.dirname, 'fixtures', 'fake-llama-server.mjs');
  if (process.platform === 'win32') {
    const cmd = join(dir, 'llama-server.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, 'llama-server');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

async function waitDownload(h: Harness, done: (s: DownloadState) => boolean): Promise<DownloadState> {
  for (let i = 0; i < 200; i++) {
    const s = (await h.call('local.downloads')).at(-1);
    if (s && done(s)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('téléchargement non terminé');
}

describe('modèles locaux', () => {
  it('GGUF : métadonnées, quantification, estimation mémoire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-gguf-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'm.gguf'), GGUF);
    const meta = readGgufMeta(join(dir, 'm.gguf'));
    expect(meta).toEqual({ architecture: 'llama', name: 'Mini Llama', contextLength: 4096, blockCount: 22, embeddingLength: 2048, headCount: 32, headCountKv: 4, hasChatTemplate: true });
    expect(quantOf('Qwen3-8B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantOf('model.IQ3_XS.gguf')).toBe('IQ3_XS');
    // 7 Go de poids, 32 couches, contexte 8k : cache KV = 2 × 32 × 8192 × 8 × 128 × 2 o = 1 Go.
    const big = { ...meta, blockCount: 32, embeddingLength: 4096, headCount: 32, headCountKv: 8, contextLength: 32768 };
    const hw = { ramTotalMb: 32_000, ramFreeMb: 20_000, cpus: 8, cpuModel: '', gpus: [{ name: 'GPU', vramTotalMb: 8192, vramFreeMb: 6000, source: 'nvidia-smi' as const }] };
    const e = estimateModel(7000 * 1024 * 1024, big, 8192, hw);
    expect(e).toMatchObject({ weightsMb: 7000, kvCacheMb: 1024, fits: 'partial', totalLayers: 32 });
    expect(e.gpuLayers).toBeGreaterThan(10);
    expect(e.gpuLayers).toBeLessThan(32);
    expect(estimateModel(2000 * 1024 * 1024, big, 8192, hw).fits).toBe('gpu');
    expect(estimateModel(7000 * 1024 * 1024, big, 8192, { ...hw, gpus: [] }).fits).toBe('cpu');
  });

  it('catalogue Hugging Face, téléchargement vérifié, empreinte incorrecte rejetée, moteur et génération locale', async () => {
    const hf = await hfMock();
    const root = mkdtempSync(join(tmpdir(), 'mh-local-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const h = new Harness({ host: 'cli', data: { dir: root, source: 'argument', portable: false, locationFile: null }, logger: silentLogger, keyProtector: new MemoryProtector(), changelog: '', localEndpoints: { hfBase: hf.url } });
    cleanups.push(() => h.close());

    expect((await h.call('local.hfSearch', { query: 'llama' }))[0]).toMatchObject({ id: 'org/mini-llama-GGUF', downloads: 1234 });
    const files = await h.call('local.hfFiles', { repo: 'org/mini-llama-GGUF' });
    expect(files.map((f) => [f.name, f.quant])).toEqual([['mini-llama.Q4_K_M.gguf', 'Q4_K_M'], ['mini-llama.Q8_0.gguf', 'Q8_0']]);
    await expect(h.call('local.hfFiles', { repo: '../etc' })).rejects.toThrow(/invalide/);

    // Reprise : un fichier partiel est complété par une requête Range.
    writeFileSync(join(root, 'local', 'models', 'mini-llama.Q4_K_M.gguf.part'), GGUF.subarray(0, 1000));
    await h.call('local.download', { repo: 'org/mini-llama-GGUF', file: 'mini-llama.Q4_K_M.gguf' });
    const ok = await waitDownload(h, (s) => s.file.includes('Q4') && ['done', 'error'].includes(s.status));
    expect(ok).toMatchObject({ status: 'done', received: GGUF.length });
    expect(hf.ranges.at(-1)).toBe('bytes=1000-');
    expect(readFileSync(join(root, 'local', 'models', 'mini-llama.Q4_K_M.gguf')).equals(GGUF)).toBe(true);

    await h.call('local.download', { repo: 'org/mini-llama-GGUF', file: 'mini-llama.Q8_0.gguf' });
    const bad = await waitDownload(h, (s) => s.file.includes('Q8') && ['done', 'error'].includes(s.status));
    expect(bad).toMatchObject({ status: 'error', error: expect.stringContaining('SHA-256') });
    expect(existsSync(join(root, 'local', 'models', 'mini-llama.Q8_0.gguf'))).toBe(false);

    const models = await h.call('local.models');
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'mini-llama.Q4_K_M.gguf', repo: 'org/mini-llama-GGUF', sha256: SHA, quant: 'Q4_K_M', meta: { architecture: 'llama', contextLength: 4096 } });
    expect((await h.call('local.estimate', { id: models[0]!.id, contextSize: 2048 })).totalLayers).toBe(22);

    // Moteur : chemin fourni par l'utilisateur, vérifié par --version.
    await expect(h.call('local.setEnginePath', { path: join(root, 'absent.exe') })).rejects.toThrow(/introuvable/);
    const engine = await h.call('local.setEnginePath', { path: fakeEngine(root) });
    expect(engine).toMatchObject({ installed: true, version: '9999 (test)', source: 'custom' });

    // Fournisseur local : le serveur démarre à la demande, la réponse passe par son API OpenAI.
    await h.call('settings.update', { local: { contextSize: 2048, gpuLayers: 0 }, chat: { autoNaming: false } });
    const p = await h.call('providers.create', { name: 'Local', kind: 'local', preset: 'local', baseUrl: '' });
    expect(p.models.map((m) => [m.id, m.enabled])).toEqual([['mini-llama.Q4_K_M.gguf', true]]);
    expect((await h.call('providers.test', { providerId: p.id, kind: 'local', baseUrl: '' })).ok).toBe(true);
    const c = await h.call('conversations.create', { projectId: null });
    await h.call('conversations.update', { id: c.id, patch: { providerId: p.id, model: 'mini-llama.Q4_K_M.gguf' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Bonjour' } });
    await h.generation.idle();
    const msg = (await h.call('messages.list', { conversationId: c.id })).at(-1)!;
    expect(msg.parts.at(-1)).toMatchObject({ type: 'text', text: 'Bonjour depuis mini-llama.Q4_K_M.gguf (ctx 2048, ngl 0)' });
    expect((await h.call('local.engine')).running).toMatchObject({ model: 'mini-llama.Q4_K_M.gguf', contextSize: 2048, gpuLayers: 0 });
    expect((await h.call('local.stop')).running).toBeNull();
    await h.call('local.deleteModel', { id: 'mini-llama.Q4_K_M.gguf' });
    expect(await h.call('local.models')).toEqual([]);
  });
});
