import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { BenchmarkState } from '@monolith/contracts';
import { mockProvider, standardStream, tempHarness, writeFragmented } from './helpers.ts';
import { encodePng } from '../src/util/png.ts';
import { heuristicScore, textMetrics } from '../src/services/studio.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { model?: string; messages?: { role: string; content: unknown }[]; prompt?: string };
const caps = (vision: boolean | null) => ({ reasoningLevels: [], reasoningSource: 'unknown' as const, rejectedLevels: [], vision, tools: null });
const PNG_1x1 = encodePng(1, 1, new Uint8Array([255, 0, 0, 255])).toString('base64');

async function setup(handler: (body: Body, url: string, res: ServerResponse) => void | Promise<void>) {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const bodies: { url: string; body: Body }[] = [];
  const mock = await mockProvider((req, raw, res) => {
    const body = JSON.parse(raw || '{}') as Body;
    bodies.push({ url: req.url ?? '', body });
    return handler(body, req.url ?? '', res);
  });
  cleanups.push(mock.close);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: ['texte', 'autre', 'vis'].map((id) => ({ id, label: id, enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual' as const, capabilities: caps(id === 'vis' ? true : id === 'texte' ? false : null) })) });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'texte', autoNaming: false } });
  return { h, bodies, providerId: p.id };
}

describe('outils dédiés', () => {
  it('traduction et correction : consigne, résultat, consommation', async () => {
    const { h, bodies } = await setup((_b, _u, res) => writeFragmented(res, standardStream('  Hello world.  ')));
    const r = await h.call('studio.text', { task: 'translate', text: 'Bonjour le monde.', targetLanguage: 'anglais', tone: 'formel' });
    expect(r).toMatchObject({ text: 'Hello world.', model: 'texte', providerName: 'Mock' });
    const system = String(bodies[0]!.body.messages![0]!.content);
    expect(system).toContain('Traduis fidèlement le texte en anglais');
    expect(system).toContain('Ton souhaité : formel');
    await h.call('studio.text', { task: 'proofread', text: 'Il sont venu.' });
    expect(String(bodies[1]!.body.messages![0]!.content)).toContain('Corrige');
    await expect(h.call('studio.text', { task: 'translate', text: '   ' })).rejects.toThrow(/vide/);
    const usage = await h.call('usage.list', {});
    expect(usage.filter((u: { kind: string }) => u.kind === 'tool')).toHaveLength(2);
  });

  it('détection IA : indicateurs, texte trop court, avis du modèle', async () => {
    const { h } = await setup((_b, _u, res) => writeFragmented(res, standardStream('{"verdict":"mixed","confidence":0.4,"reasons":["style uniforme"]}')));
    const short = await h.call('studio.detect', { text: 'Trop court.' });
    expect(short.heuristicLabel).toBe('too_short');
    const regular = Array.from({ length: 12 }, () => 'Cette solution permet d’optimiser efficacement les processus de l’entreprise moderne aujourd’hui.').join(' ');
    const m = textMetrics(regular);
    expect(m.burstiness).toBe(0);
    expect(heuristicScore(m).label).toBe('probably_ai');
    const r = await h.call('studio.detect', { text: regular, useModel: true });
    expect(r.model).toMatchObject({ verdict: 'mixed', confidence: 0.4, reasons: ['style uniforme'] });
  });

  it('benchmark : cibles en parallèle, contrôle de réponse, progression', async () => {
    const { h, providerId } = await setup((b, _u, res) => writeFragmented(res, standardStream(b.model === 'texte' ? 'La réponse est 4.' : 'Je ne sais pas.'), 40, 1));
    const states: BenchmarkState[] = [];
    h.events.on('benchmark.progress', (s) => states.push(s));
    const start = await h.call('benchmark.start', { targets: [{ providerId, model: 'texte' }, { providerId, model: 'autre' }], cases: [{ prompt: '2+2 ?', expected: '4' }, { prompt: 'Capitale ?' }], repeat: 1 });
    expect(start).toMatchObject({ running: true, total: 4 });
    await expect(h.call('benchmark.start', { targets: [{ providerId, model: 'texte' }], cases: [{ prompt: 'x' }], repeat: 1 })).rejects.toThrow(/déjà/);
    for (let i = 0; i < 100 && (await h.call('benchmark.state'))!.running; i++) await new Promise((r) => setTimeout(r, 30));
    const final = (await h.call('benchmark.state'))!;
    expect(final.done).toBe(4);
    expect(final.results.filter((r) => r.caseIndex === 0).map((r) => [r.model, r.passed]).sort()).toEqual([['autre', false], ['texte', true]]);
    expect(final.results.every((r) => r.ok && r.durationMs >= 0)).toBe(true);
    expect(states.at(-1)!.running).toBe(false);
  });

  it('génération d’images (compatible OpenAI) et assets SVG / pixel art', async () => {
    const { h, providerId, bodies } = await setup((b, url, res) => {
      if (url.endsWith('/images/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_1x1, revised_prompt: 'un carré rouge' }] }));
        return;
      }
      return writeFragmented(res, standardStream('ok'));
    });
    await expect(h.call('images.generate', { prompt: 'carré' })).rejects.toThrow(/images/);
    await h.call('settings.update', { studio: { imageProviderId: providerId, imageModel: 'gpt-image-1' } });
    const img = await h.call('images.generate', { prompt: 'un carré rouge', size: '512x512' });
    expect(img.attachments[0]).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(img.revisedPrompt).toBe('un carré rouge');
    expect(bodies.at(-1)!.body).toMatchObject({ model: 'gpt-image-1', size: '512x512' });

    await expect(h.call('assets.save', { name: 'mal', kind: 'svg', content: '<svg><script>alert(1)</script></svg>' })).rejects.toThrow(/scripts/);
    await expect(h.call('assets.save', { name: 'mal2', kind: 'svg', content: '<svg onload="x()"></svg>' })).rejects.toThrow(/événements/);
    await expect(h.call('assets.save', { name: 'mal3', kind: 'svg', content: '<svg><image href="https://evil/x.png"/></svg>' })).rejects.toThrow(/références/);
    await h.call('assets.save', { name: 'logo', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#5b5bd6"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect></svg>' });
    const pixel = { width: 2, height: 2, palette: ['#00000000', '#ff0000'], frames: [['10', '01'], ['01', '10']], fps: 4 };
    await h.call('assets.save', { name: 'damier', kind: 'pixel', content: JSON.stringify(pixel) });
    await expect(h.call('assets.save', { name: 'faux', kind: 'pixel', content: JSON.stringify({ ...pixel, frames: [['12', '01']] }) })).rejects.toThrow(/indice|lignes/);
    expect((await h.call('assets.list')).map((a) => [a.name, a.kind]).sort()).toEqual([['damier', 'pixel'], ['logo', 'svg']]);
    const png = await h.call('assets.png', { name: 'damier', scale: 3, frame: 1 });
    expect([png.width, png.height]).toEqual([6, 6]);
    expect(Buffer.from(png.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('vision de secours : l’image est décrite une fois puis transmise en texte', async () => {
    const { h, providerId, bodies } = await setup((b, _u, res) => writeFragmented(res, standardStream(b.model === 'vis' ? 'Un carré rouge sur fond blanc.' : 'Je vois la description.')));
    await h.call('settings.update', { studio: { visionProviderId: providerId, visionModel: 'vis' } });
    const att = await h.call('attachments.upload', { name: 'carre.png', mime: 'image/png', dataBase64: PNG_1x1 });
    const c = await h.call('conversations.create', { projectId: null });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Que vois-tu ?', attachmentIds: [att.id] } });
    await h.generation.idle();
    const vision = bodies.filter((b) => b.body.model === 'vis');
    expect(vision).toHaveLength(1);
    expect(JSON.stringify(vision[0]!.body.messages)).toContain('image_url');
    const chat = bodies.filter((b) => b.body.model === 'texte').at(-1)!;
    expect(JSON.stringify(chat.body.messages)).not.toContain('image_url');
    expect(JSON.stringify(chat.body.messages)).toContain('Un carré rouge sur fond blanc.');
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Et maintenant ?' } });
    await h.generation.idle();
    expect(bodies.filter((b) => b.body.model === 'vis')).toHaveLength(1);
  });
});
