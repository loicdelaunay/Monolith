import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import type { MessagePart, PermissionRequest } from '@monolith/contracts';
import { Harness, MemoryProtector, silentLogger } from '../src/index.ts';
import type { ModelManifest } from '../src/local/ai-manifests.ts';
import { LOCAL_EMBEDDING_MODEL } from '../src/services/rag.ts';
import { mockProvider, sseChunk, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const FILES: Record<string, Buffer> = {
  'bundle/classify.py': Buffer.from('# faux classifieur\n'),
  'bundle/model/encoder-int8.onnx': Buffer.alloc(50_000, 1),
  'onnx/model_quantized.onnx': Buffer.alloc(40_000, 2),
  'tokenizer.json': Buffer.from('{"faux":true}'),
};
const manifest = (id: 'lancet' | 'minilm', paths: string[], prefix: string, corrupt = false): ModelManifest => ({
  id,
  version: 'test',
  repo: `test/${id}`,
  revision: 'r1',
  prefix,
  files: paths.map((p) => ({ path: p, size: FILES[prefix + p]!.length, sha256: corrupt ? 'f'.repeat(64) : sha(FILES[prefix + p]!) })),
});

async function hfMock() {
  const server = createServer((req, res) => {
    const m = /^\/test\/(lancet|minilm)\/resolve\/r1\/(.+)$/.exec(req.url ?? '');
    const body = m ? FILES[m[2]!] : undefined;
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakePython(dir: string): string {
  const script = join(import.meta.dirname, 'fixtures', 'fake-python.mjs');
  if (process.platform === 'win32') {
    const cmd = join(dir, 'python.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, 'python');
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}

async function harness(opts: { corrupt?: boolean; providerUrl?: string; hfBase?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mh-lai-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const hf = await hfMock();
  const h = new Harness({
    host: 'cli',
    data: { dir: root, source: 'argument', portable: false, locationFile: null },
    logger: silentLogger,
    keyProtector: new MemoryProtector(),
    changelog: '',
    localAi: {
      hfBase: opts.hfBase ?? hf,
      python: fakePython(root),
      manifests: { lancet: manifest('lancet', ['classify.py', 'model/encoder-int8.onnx'], 'bundle/', opts.corrupt), minilm: manifest('minilm', ['onnx/model_quantized.onnx', 'tokenizer.json'], '') },
    },
  });
  cleanups.push(() => h.close());
  return { h, root };
}

describe('IA locale (LANCET Nano, MiniLM)', () => {
  it('installation vérifiée après accord, puis classification des commandes', async () => {
    const { h } = await harness();
    expect((await h.call('localai.status')).components.map((c) => [c.id, c.installed])).toEqual([['lancet', false], ['minilm', false]]);
    // Rien n'est téléchargé tant que l'installation n'est pas demandée.
    expect(await h.localAi.classify('ls', 'bash')).toMatchObject({ classification: 'review', reason: expect.stringContaining('non installé') });
    const stages: string[] = [];
    h.events.on('localai.progress', (p) => stages.push(p.stage));
    await h.call('localai.install', { component: 'lancet' });
    await h.localAi.idle();
    expect(stages).toEqual(expect.arrayContaining(['dependencies', 'download', 'prepare', 'ready']));
    expect((await h.call('localai.status')).components[0]).toMatchObject({ id: 'lancet', installed: true });
    expect(await h.localAi.classify('ls -la', 'bash')).toEqual({ classification: 'not_flagged', score: 0.02, reason: null });
    expect(await h.localAi.classify('rm -rf /', 'bash')).toMatchObject({ classification: 'risky', score: 0.97 });
    expect((await h.localAi.classify('x'.repeat(9000), 'bash')).classification).toBe('review');
  });

  it('empreinte incorrecte : installation refusée, rien n’est publié', async () => {
    const { h } = await harness({ corrupt: true });
    let error = '';
    h.events.on('localai.progress', (p) => p.stage === 'error' && (error = p.message ?? ''));
    await h.call('localai.install', { component: 'lancet' });
    await h.localAi.idle();
    expect(error).toContain('SHA-256');
    expect((await h.call('localai.status')).components[0]!.installed).toBe(false);
  });

  it('mode Automatique avec LANCET Nano : commande non signalée acceptée, risquée demandée, autres actions selon les règles', async () => {
    let turn = 0;
    const steps = [
      { tool: 'run_command', args: { command: 'echo bonjour' } },
      { tool: 'run_command', args: { command: 'rm -rf ./dossier' } },
      { tool: 'write_file', args: { path: 'a.txt', content: 'x' } },
    ];
    const mock = await mockProvider((_req, _raw, res: ServerResponse) => {
      const step = steps[turn++];
      const done = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`;
      void writeFragmented(res, (step ? sseChunk({ tool_calls: [{ index: 0, id: `c${turn}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }) : sseChunk({ content: 'fin' })) + done, 64);
    });
    cleanups.push(mock.close);
    const { h } = await harness();
    await h.call('localai.install', { component: 'lancet' });
    await h.localAi.idle();
    const folder = mkdtempSync(join(tmpdir(), 'mh-lai-p-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const project = await h.call('projects.create', { name: 'P' });
    await h.call('projects.addFolder', { id: project.id, path: folder });
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false }, permissions: { policy: 'auto', validator: 'lancet' } });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
    const requests: PermissionRequest[] = [];
    h.events.on('permission.requested', (r) => {
      requests.push(r);
      setTimeout(() => void h.call('permissions.respond', { requestId: r.requestId, decision: 'deny', scope: 'once' }), 5);
    });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Go' } });
    await h.generation.idle();
    const calls = (await h.call('messages.list', { conversationId: c.id })).at(-1)!.parts.filter((x): x is Extract<MessagePart, { type: 'tool' }> => x.type === 'tool').map((x) => x.call);
    expect(calls[0]).toMatchObject({ permission: { decision: 'allow', source: 'validator', reason: expect.stringContaining('LANCET Nano : commande non signalée') } });
    expect(calls[1]).toMatchObject({ status: 'denied' });
    expect(requests.map((r) => r.reason)).toEqual([expect.stringContaining('commande risquée (score 0.97) — suppression récursive'), expect.stringContaining('n’analyse que les commandes')]);
  });

  it('RAG : embeddings locaux MiniLM (synonymes trouvés sans correspondance lexicale)', async () => {
    const { h } = await harness();
    await h.call('localai.install', { component: 'minilm' });
    await h.localAi.idle();
    const folder = mkdtempSync(join(tmpdir(), 'mh-lai-rag-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'compta.ts'), 'export function totalFacture() { return 42; }\n');
    writeFileSync(join(folder, 'src', 'animaux.ts'), 'export const chat = "miaou";\n');
    await h.call('settings.update', { rag: { embeddingSource: 'local' } });
    const rag = (h as unknown as { rag: { index: (id: number, roots: string[]) => Promise<unknown>; search: (r: string[], q: string, k: number, s: AbortSignal) => Promise<{ path: string }[]> } }).rag;
    await rag.index(1, [folder]);
    const sources = h.db.all<{ embedding_model: string }>('SELECT embedding_model FROM rag_sources');
    expect(sources.every((s) => s.embedding_model === LOCAL_EMBEDDING_MODEL)).toBe(true);
    // « invoice » n'apparaît dans aucun fichier : seul le voisinage sémantique le relie à « facture ».
    expect((await rag.search([folder], 'invoice', 1, AbortSignal.timeout(5000)))[0]!.path).toBe('src/compta.ts');
  });
});

describe('IA locale : environnement Python', () => {
  it('archive téléchargée, vérifiée par SHA-256 puis extraite ; empreinte incorrecte refusée', async () => {
    const { execFileSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { LocalAiService } = await import('../src/local/ai-runtime.ts');
    const { EventBus } = await import('../src/events.ts');
    const { PYTHON_RUNTIME } = await import('../src/local/ai-manifests.ts');
    const work = mkdtempSync(join(tmpdir(), 'mh-py-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const exe = process.platform === 'win32' ? 'python.exe' : join('bin', 'python3');
    mkdirSync(join(work, 'src', 'python', process.platform === 'win32' ? '' : 'bin'), { recursive: true });
    writeFileSync(join(work, 'src', 'python', exe), 'faux');
    const archive = join(work, 'py.tar.gz');
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-czf', archive, '-C', join(work, 'src'), 'python']);
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(archive);
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-length': bytes.length }).end(bytes);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    const githubBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const make = (sha256: string, dir: string) => new LocalAiService({ dir, events: new EventBus(), logger: silentLogger, githubBase, runtime: { triple: 'x86_64-test', sha256 } });

    const good = make(sha(bytes), join(work, 'ok'));
    await good.installRuntime(AbortSignal.timeout(30_000));
    expect(paths[0]).toBe(`/astral-sh/python-build-standalone/releases/download/${PYTHON_RUNTIME.release}/cpython-${PYTHON_RUNTIME.version}%2B${PYTHON_RUNTIME.release}-x86_64-test-install_only.tar.gz`);
    const dir = join(work, 'ok', `python-${PYTHON_RUNTIME.version}-${PYTHON_RUNTIME.release}-${process.platform}-${process.arch}`);
    expect(existsSync(join(dir, 'python', exe))).toBe(true);
    expect(existsSync(join(dir, '.complete'))).toBe(true);

    const bad = make('0'.repeat(64), join(work, 'bad'));
    await expect(bad.installRuntime(AbortSignal.timeout(30_000))).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(work, 'bad', `python-${PYTHON_RUNTIME.version}-${PYTHON_RUNTIME.release}-${process.platform}-${process.arch}`))).toBe(false);
  });
});

describe('RAG : modèle pris sur le poste (Hugging Face inaccessible)', () => {
  const files = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-lai-poste-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'onnx'));
    return dir;
  };
  const failure = (h: Harness) => {
    const seen = { message: '' };
    h.events.on('localai.progress', (p) => p.stage === 'error' && (seen.message = p.message ?? ''));
    return seen;
  };
  const minilm = async (h: Harness) => (await h.call('localai.status')).components.find((c) => c.id === 'minilm')!;

  it('site inaccessible : l’erreur le nomme, les fichiers à récupérer sont fournis', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const free = (s.address() as AddressInfo).port;
        s.close(() => resolve(free));
      });
    });
    const { h } = await harness({ hfBase: `http://127.0.0.1:${port}` });
    const seen = failure(h);
    await h.call('localai.install', { component: 'minilm' });
    await h.localAi.idle();
    expect(seen.message).toContain('127.0.0.1 inaccessible');
    const info = await minilm(h);
    expect(info.installed).toBe(false);
    expect(info.files.map((f) => [f.path, f.url.endsWith(`/test/minilm/resolve/r1/${f.path}`), f.bytes])).toEqual([['onnx/model_quantized.onnx', true, 40_000], ['tokenizer.json', true, FILES['tokenizer.json']!.length]]);
  }, 20_000);

  it('fichiers prévus : installés comme un téléchargement, index conservé (disposition Hugging Face)', async () => {
    const { h } = await harness();
    const dir = files();
    writeFileSync(join(dir, 'onnx', 'model_quantized.onnx'), FILES['onnx/model_quantized.onnx']!);
    writeFileSync(join(dir, 'tokenizer.json'), FILES['tokenizer.json']!);
    const stages: string[] = [];
    h.events.on('localai.progress', (p) => stages.push(p.stage));
    await h.call('localai.installFrom', { component: 'minilm', paths: [join(dir, 'onnx', 'model_quantized.onnx')] });
    await h.localAi.idle();
    expect(stages).toEqual(expect.arrayContaining(['copy', 'prepare', 'ready']));
    expect(await minilm(h)).toMatchObject({ installed: true, custom: null });
    expect(h.localAi.customEmbeddingId()).toBeNull();
    expect((await h.localAi.embed(['facture']))[0]).toHaveLength(4);
  });

  it('autre modèle : adopté après essai, signalé, réindexé, et le modèle prévu reste récupérable', async () => {
    const { h } = await harness();
    await h.call('settings.update', { rag: { embeddingSource: 'local' } });
    const folder = mkdtempSync(join(tmpdir(), 'mh-lai-rag-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, 'compta.ts'), '// gestion de la facture client\nexport const total = 1;\n');
    const rag = (h as unknown as { rag: { index: (id: number, roots: string[]) => Promise<unknown> } }).rag;
    const models = () => h.db.all<{ embedding_model: string }>('SELECT embedding_model FROM rag_sources').map((s) => s.embedding_model);
    await h.call('localai.install', { component: 'minilm' });
    await h.localAi.idle();
    await rag.index(1, [folder]);
    expect(models()).toEqual([LOCAL_EMBEDDING_MODEL]);

    const dir = files();
    writeFileSync(join(dir, 'mon-modele.onnx'), Buffer.alloc(3000, 7));
    writeFileSync(join(dir, 'tokenizer.json'), '{"autre":true}');
    await h.call('localai.installFrom', { component: 'minilm', paths: [join(dir, 'mon-modele.onnx'), join(dir, 'tokenizer.json')] });
    await h.localAi.idle();
    expect(await minilm(h)).toMatchObject({ installed: true, custom: 'mon-modele.onnx' });
    const id = h.localAi.customEmbeddingId()!;
    expect(id).toMatch(/^local:custom-[0-9a-f]{12}$/);
    await rag.index(1, [folder]);
    expect(models()).toEqual([id]);

    await h.call('localai.install', { component: 'minilm' });
    await h.localAi.idle();
    expect(await minilm(h)).toMatchObject({ installed: true, custom: null });
    await rag.index(1, [folder]);
    expect(models()).toEqual([LOCAL_EMBEDDING_MODEL]);
  });

  it('modèle inutilisable : refusé, celui déjà installé reste en place', async () => {
    const { h } = await harness();
    await h.call('localai.install', { component: 'minilm' });
    await h.localAi.idle();
    const dir = files();
    writeFileSync(join(dir, 'casse.onnx'), 'inutilisable');
    writeFileSync(join(dir, 'tokenizer.json'), '{}');
    const seen = failure(h);
    await h.call('localai.installFrom', { component: 'minilm', paths: [join(dir, 'casse.onnx')] });
    await h.localAi.idle();
    expect(seen.message).toContain('Modèle incompatible : sortie inattendue');
    expect(await minilm(h)).toMatchObject({ installed: true, custom: null });
    expect((await h.localAi.embed(['chat']))[0]).toHaveLength(4);
  });

  it('sélection incomplète : refus explicite, sans installation', async () => {
    const { h } = await harness();
    const dir = files();
    writeFileSync(join(dir, 'seul.onnx'), 'x');
    await expect(h.call('localai.installFrom', { component: 'minilm', paths: [join(dir, 'seul.onnx')] })).rejects.toThrow('tokenizer.json introuvable');
    await expect(h.call('localai.installFrom', { component: 'minilm', paths: [join(dir, 'absent.onnx')] })).rejects.toThrow('fichier .onnx');
    await expect(h.call('localai.installFrom', { component: 'minilm', paths: [] })).rejects.toThrow('fichier .onnx');
    await expect(h.call('localai.installFrom', { component: 'lancet', paths: [join(dir, 'seul.onnx')] })).rejects.toThrow('Seul le modèle d’embeddings');
    expect((await minilm(h)).installed).toBe(false);
  });
});
