import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Message, ToolCallRecord } from '@monolith/contracts';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';
import { buildHistory, countImages, imageLimitRejection } from '../src/generation/prompt.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f10000000049454e44ae426082', 'hex');
type Part = { type: string; text?: string; image_url?: { url: string } };
type Body = { messages: { role: string; content: string | Part[] }[] };
const images = (b: Body) => b.messages.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter((p) => p.type === 'image_url').length), 0);

function reply(text: string): string {
  let out = sseChunk({ content: text });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n`;
  return out + 'data: [DONE]\n\n';
}

/** Fournisseur fictif ; `limit` imite vLLM (limit_mm_per_prompt), qui refuse au-delà. */
async function setup(limit: number | null) {
  const bodies: Body[] = [];
  const mock = await mockProvider(async (_req: IncomingMessage, raw, res: ServerResponse) => {
    const body = JSON.parse(raw || '{}') as Body;
    bodies.push(body);
    if (limit !== null && images(body) > limit) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'error', message: `At most ${limit} image(s) may be provided in one prompt.`, type: 'BadRequestError', param: null, code: 400 }));
      return;
    }
    return writeFragmented(res, reply('Vu.'), 50);
  });
  cleanups.push(mock.close);
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: true, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, autoCompact: false } });
  const c = await h.call('conversations.create', { projectId: null });
  const img = await h.call('attachments.upload', { name: 'photo.png', mime: 'image/png', dataBase64: PNG.toString('base64') });
  const send = async (text: string, count = 1) => {
    await h.call('chat.send', { conversationId: c.id, input: { text, attachmentIds: Array(count).fill(img.id) } });
    await h.generation.idle();
  };
  return { h, c, p, bodies, send };
}

describe('images renvoyées à chaque requête', () => {
  it('ne renvoie que les 8 images les plus récentes de la conversation', async () => {
    const { h, c, bodies, send } = await setup(null);
    for (let i = 1; i <= 10; i++) await send(`image ${i}`);
    const last = bodies.at(-1)!;
    expect(images(last)).toBe(8);
    // Les deux plus anciennes sont remplacées par une mention ; la dernière (le message en cours) est envoyée.
    expect(JSON.stringify(last.messages)).toContain('déjà envoyée plus tôt dans la conversation');
    const current = last.messages.at(-1)!.content as Part[];
    expect(current.some((p) => p.type === 'image_url')).toBe(true);
    const replies = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'assistant');
    expect(replies.every((m) => m.status === 'complete')).toBe(true);
  });

  it('garde toutes les images du message en cours, même au-delà de la limite par défaut', async () => {
    const { bodies, send } = await setup(null);
    await send('dix images', 10);
    expect(images(bodies.at(-1)!)).toBe(10);
  });

  it('apprend la limite annoncée par le fournisseur (vLLM) et renvoie la requête', async () => {
    const { h, c, p, bodies, send } = await setup(3);
    for (let i = 1; i <= 5; i++) await send(`image ${i}`);
    const list = await h.call('messages.list', { conversationId: c.id });
    const replies = list.filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.status)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete']);
    // Un seul refus : au 4e message ; ensuite au plus 3 images par requête, sans nouvel échec.
    expect(bodies.filter((b) => images(b) > 3)).toHaveLength(1);
    expect(images(bodies.at(-1)!)).toBe(3);
    expect(replies[3]!.parts.some((x) => x.type === 'notice' && x.code === 'images_limit')).toBe(true);
    expect((await h.call('providers.list')).find((x) => x.id === p.id)!.models[0]!.capabilities.maxImages).toBe(3);
  });

  it('signale les images du message en cours retirées pour respecter la limite du fournisseur', async () => {
    const { h, c, bodies, send } = await setup(2);
    await send('trois images', 3);
    const reply = (await h.call('messages.list', { conversationId: c.id })).at(-1)!;
    expect(reply.status).toBe('complete');
    expect(images(bodies.at(-1)!)).toBe(2);
    expect(reply.parts.some((x) => x.type === 'notice' && x.code === 'images_limited')).toBe(true);
  });
});

describe('captures des outils', () => {
  const call = (id: string, attachmentId: number): ToolCallRecord => ({ id, name: 'browser_screenshot', family: 'browser', effects: [], arguments: '{}', target: null, status: 'done', result: 'Capture prise.', display: { kind: 'image', attachmentId } as ToolCallRecord['display'], permission: null, startedAt: null, finishedAt: null, round: Number(id.slice(1)) });
  const msg = (seq: number, role: 'user' | 'assistant', parts: Message['parts']): Message => ({ id: seq, conversationId: 1, seq, role, origin: 'direct', status: 'complete', parts, snapshot: null, usage: null, error: null, createdAt: '', completedAt: null, durationMs: null, firstTokenMs: null });

  it('retire les captures les plus anciennes et garde l’association image ↔ appel', () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(`c${i}`, i + 1));
    const history = buildHistory([msg(1, 'user', [{ type: 'text', text: 'navigue' }]), msg(2, 'assistant', calls.map((c) => ({ type: 'tool' as const, call: c })))], {
      attachments: { text: () => '', dataUrl: (r) => `data:image/png;base64,${r.id}` },
      vision: true,
      imageLimit: { max: 2, strict: false },
    });
    expect(countImages(history.messages)).toBe(2);
    // Chaque tour a son message de captures : seuls les deux derniers restent, avec leur appel.
    const shots = history.messages.filter((m) => m.toolImagesFor);
    expect(shots.map((m) => m.toolImagesFor)).toEqual([['c3'], ['c4']]);
    expect(shots.map((m) => (m.content as Part[]).find((x) => x.type === 'image_url')!.image_url!.url)).toEqual(['data:image/png;base64,4', 'data:image/png;base64,5']);
    // Les résultats texte des outils restent tous.
    expect(history.messages.filter((m) => m.role === 'tool')).toHaveLength(5);
  });
});

describe('refus pour trop d’images', () => {
  it('reconnaît les messages courants et lit la limite', () => {
    expect(imageLimitRejection(400, 'At most 8 image(s) may be provided in one prompt.')).toEqual({ limit: 8 });
    expect(imageLimitRejection(400, 'At most 1 image(s) may be provided in one request.')).toEqual({ limit: 1 });
    expect(imageLimitRejection(400, 'Too many images provided. This model supports up to 5 images')).toEqual({ limit: 5 });
    expect(imageLimitRejection(400, 'A maximum of 20 images is allowed')).toEqual({ limit: 20 });
    expect(imageLimitRejection(400, 'too many images in request')).toEqual({ limit: null });
    expect(imageLimitRejection(500, 'At most 8 image(s) may be provided in one prompt.')).toBeNull();
    expect(imageLimitRejection(400, 'Invalid image format')).toBeNull();
  });
});
