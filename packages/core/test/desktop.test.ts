import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServerResponse } from 'node:http';
import { DEFAULT_SETTINGS, type MessagePart, type PermissionRequest } from '@monolith/contracts';
import { Harness, MemoryProtector, silentLogger } from '../src/index.ts';
import { resolveMode } from '../src/desktop/input.ts';
import { UiaDriver, UnsupportedError, type DesktopDriver } from '../src/desktop/uia-host.ts';
import { mockProvider, sseChunk, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const win = process.platform === 'win32';
const D = DEFAULT_SETTINGS.desktop;

describe('modes du contrôle du bureau', () => {
  it('automatique : UI Automation d’abord, choix de l’IA, repli seulement s’il est activé', () => {
    expect(resolveMode('mouse', 'invoke', null, D)).toEqual({ mode: 'uia', fallbackAllowed: false, fallbackReason: null, note: null });
    expect(resolveMode('mouse', 'invoke', null, { ...D, legacyFallback: true }).fallbackAllowed).toBe(true);
    expect(resolveMode('mouse', 'invoke', 'legacy', D)).toMatchObject({ mode: 'legacy', note: 'Mode choisi par l’IA.' });
    // Choix de l'IA désactivé : la stratégie configurée s'impose.
    expect(resolveMode('mouse', 'invoke', 'legacy', { ...D, allowAiChoose: false })).toMatchObject({ mode: 'uia', note: expect.stringContaining('désactivé') });
    // Actions sans équivalent UI Automation : Legacy explicite, ou repli autorisé à part.
    expect(() => resolveMode('keyboard', 'keys', null, D)).toThrow(/mode="legacy"/);
    expect(() => resolveMode('mouse', 'right_click', null, { ...D, allowAiChoose: false })).toThrow(/repli Legacy automatique est désactivé/);
    expect(resolveMode('mouse', 'double_click', null, { ...D, legacyFallback: true })).toMatchObject({ mode: 'legacy', fallbackReason: expect.stringContaining('double_click') });
    expect(() => resolveMode('mouse', 'click', 'uia', D, true)).toThrow(/nécessite Legacy/);
    expect(resolveMode('mouse', 'click', null, D)).toMatchObject({ mode: 'uia' });
  });

  it('un mode fixe n’est jamais contourné', () => {
    expect(() => resolveMode('keyboard', 'type', 'legacy', { ...D, keyboardMode: 'uia' })).toThrow(/fixé par l’utilisateur/);
    expect(() => resolveMode('keyboard', 'keys', null, { ...D, keyboardMode: 'uia', legacyFallback: true })).toThrow(/mode configuré est UI Automation/);
    expect(resolveMode('keyboard', 'type', null, { ...D, keyboardMode: 'legacy' })).toEqual({ mode: 'legacy', fallbackAllowed: false, fallbackReason: null, note: null });
    expect(() => resolveMode('mouse', 'scroll_into_view', null, { ...D, mouseMode: 'legacy' })).toThrow(/n’existe qu’en UI Automation/);
    // Le réglage du clavier ne s'applique pas à la souris.
    expect(resolveMode('mouse', 'invoke', null, { ...D, keyboardMode: 'legacy' }).mode).toBe('uia');
  });
});

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
type Body = { tools?: { function: { name: string } }[] };

function toolCallStream(name: string, args: Record<string, unknown>, id: string): string {
  return sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
}

function fakeDriver() {
  const calls: string[] = [];
  const driver: DesktopDriver = {
    windows: async () => [{ window_id: '42.1', title: 'Bloc-notes', process: 'notepad', pid: 1, class: 'Notepad', bounds: [0, 0, 800, 600] }],
    inspect: async () => ({ nodes: [{ element_id: 'e1', parent: null, depth: 0, type: 'Button', name: 'OK', automation_id: 'ok', class: '', enabled: true, password: false, focusable: true, patterns: ['Invoke'], bounds: [1, 2, 3, 4] }], truncated: false }),
    act: async (_w, element, action) => {
      calls.push(`uia:${action}:${element}`);
      if (element === 'sans-motif') throw new UnsupportedError('Invoke');
      return { target: 'OK' };
    },
    legacy: async (_w, action, extra) => {
      calls.push(`legacy:${action}:${extra.element ?? `${extra.x},${extra.y}`}`);
      return { x: 10, y: 20 };
    },
    legacyBlockedUntil: () => 0,
    dispose: () => undefined,
  };
  return { driver, calls };
}

async function setup(steps: Step[], desktop: Partial<typeof D> = {}) {
  const bodies: Body[] = [];
  let n = 0;
  const mock = await mockProvider((_req, raw, res: ServerResponse) => {
    bodies.push(JSON.parse(raw || '{}') as Body);
    const step = steps[Math.min(n, steps.length - 1)]!;
    n++;
    const payload = 'tool' in step ? toolCallStream(step.tool, step.args, `call_${n}`) : sseChunk({ content: step.text }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    return writeFragmented(res, payload, 64);
  });
  cleanups.push(mock.close);
  const root = mkdtempSync(join(tmpdir(), 'mh-desk-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakeDriver();
  const h = new Harness({
    host: 'desktop',
    data: { dir: root, source: 'argument', portable: false, locationFile: null },
    logger: silentLogger,
    keyProtector: new MemoryProtector(),
    changelog: '',
    hostBridge: { request: async () => Promise.reject(new Error('non utilisé')) },
    desktopDriver: fake.driver,
  });
  cleanups.push(() => h.close());
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false }, skills: { enabled: { ...DEFAULT_SETTINGS.skills.enabled, keyboard: true, mouse: true } }, desktop });
  const c = await h.call('conversations.create', { projectId: null });
  await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
  const requests: PermissionRequest[] = [];
  return { h, c, bodies, calls: fake.calls, requests };
}

function respond(h: Harness, requests: PermissionRequest[], decide: (r: PermissionRequest) => { decision: 'allow' | 'deny'; scope?: 'once' | 'conversation' }) {
  h.events.on('permission.requested', (r) => {
    requests.push(r);
    const d = decide(r);
    setTimeout(() => void h.call('permissions.respond', { requestId: r.requestId, decision: d.decision, scope: d.scope ?? 'once' }), 5);
  });
}

async function run(h: Harness, conversationId: number) {
  await h.call('chat.send', { conversationId, input: { text: 'Agis sur la fenêtre' } });
  await h.generation.idle();
  const msg = (await h.call('messages.list', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;
  return msg.parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);
}

describe.skipIf(!win)('outils clavier et souris (Windows)', () => {
  it('skills désactivés par défaut ; une fois actifs, inspection et actions exposées', async () => {
    const s = await setup([{ text: 'ok' }]);
    const skills = await s.h.call('skills.list');
    expect(skills.find((k) => k.id === 'keyboard')).toMatchObject({ available: true, tools: ['desktop_inspect_ui', 'desktop_keyboard'] });
    expect(skills.find((k) => k.id === 'mouse')).toMatchObject({ available: true, tools: ['desktop_inspect_ui', 'desktop_mouse'] });
    expect(DEFAULT_SETTINGS.skills.enabled.keyboard).toBe(false);
    await run(s.h, s.c.id);
    const names = s.bodies[0]!.tools!.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['desktop_inspect_ui', 'desktop_keyboard', 'desktop_mouse']));
  });

  it('repli désactivé par défaut : capacité absente signalée sans saisie physique', async () => {
    const s = await setup([{ tool: 'desktop_mouse', args: { window_id: '42.1', action: 'invoke', element_id: 'sans-motif' } }, { text: 'fin' }]);
    respond(s.h, s.requests, () => ({ decision: 'allow' }));
    const [call] = await run(s.h, s.c.id);
    expect(call).toMatchObject({ status: 'error', result: expect.stringContaining('Invoke') });
    expect(s.calls).toEqual(['uia:invoke:sans-motif']);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.target).toContain('UI Automation');
  });

  it('repli activé : autorisation distincte, mode réel et raison affichés ; un refus n’agit pas', async () => {
    const s = await setup(
      [
        { tool: 'desktop_mouse', args: { window_id: '42.1', action: 'invoke', element_id: 'sans-motif' } },
        { tool: 'desktop_mouse', args: { window_id: '42.1', action: 'invoke', element_id: 'sans-motif' } },
        { text: 'fin' },
      ],
      { legacyFallback: true },
    );
    let n = 0;
    // Premier appel : tout autorisé ; second : action UIA autorisée, repli Legacy refusé.
    respond(s.h, s.requests, () => ({ decision: ++n === 4 ? 'deny' : 'allow' }));
    const [first, second] = await run(s.h, s.c.id);
    expect(s.requests.map((r) => r.target)).toEqual([expect.stringContaining('UI Automation'), expect.stringContaining('Legacy (repli)'), expect.stringContaining('UI Automation'), expect.stringContaining('Legacy (repli)')]);
    expect(first).toMatchObject({ status: 'done', result: expect.stringContaining('Mode réel : Legacy (repli :') });
    expect(first!.display).toMatchObject({ kind: 'info', entries: expect.arrayContaining([{ label: 'Mode réel', value: 'Legacy (saisie physique)' }, { label: 'Raison du repli', value: expect.stringContaining('Invoke') }]) });
    expect(second).toMatchObject({ status: 'error', result: expect.stringContaining('Repli Legacy refusé') });
    expect(s.calls).toEqual(['uia:invoke:sans-motif', 'legacy:click:sans-motif', 'uia:invoke:sans-motif']);
  });

  it('accord permanent propre au mode : UI Automation accordé ne couvre pas Legacy', async () => {
    const s = await setup([
      { tool: 'desktop_keyboard', args: { window_id: '42.1', action: 'set_value', element_id: 'e1', text: 'a' } },
      { tool: 'desktop_keyboard', args: { window_id: '42.1', action: 'set_value', element_id: 'e1', text: 'b' } },
      { tool: 'desktop_keyboard', args: { window_id: '42.1', action: 'keys', keys: '^s', mode: 'legacy' } },
      { text: 'fin' },
    ]);
    respond(s.h, s.requests, () => ({ decision: 'allow', scope: 'conversation' }));
    const calls = await run(s.h, s.c.id);
    expect(calls.map((c) => c.status)).toEqual(['done', 'done', 'done']);
    // Une demande pour UI Automation (puis règle keyboard:uia), une autre pour Legacy.
    expect(s.requests).toHaveLength(2);
    expect(s.requests[1]!.target).toContain('Legacy');
    expect((await s.h.call('permissions.rules', {})).map((r) => r.resource)).toEqual(['keyboard:uia', 'keyboard:legacy']);
    expect(calls[2]!.result).toContain('Mode réel : Legacy');
    expect(calls[2]!.result).toContain('Mode choisi par l’IA.');
    expect(s.calls).toEqual(['uia:set_value:e1', 'uia:set_value:e1', 'legacy:keys:undefined,undefined']);
  });
});

describe.skipIf(win)('contrôle du bureau hors Windows', () => {
  it('skills déclarés indisponibles avec la raison', async () => {
    const s = await setup([{ text: 'ok' }]);
    const k = (await s.h.call('skills.list')).find((x) => x.id === 'keyboard');
    expect(k).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/macOS|Linux/) });
  });
});

describe.skipIf(!win)('UI Automation réelle (fenêtre de test hors écran, sans focus ni curseur)', () => {
  it('liste, inspecte, invoque, coche et saisit ; identifiants expirés ; fenêtres de Monolith exclues', { timeout: 180_000 }, async () => {
    const title = `MH-UIA-Test-${process.pid}-${Date.now()}`;
    const fixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'fixtures', 'uia-window.ps1'), '-Title', title], { windowsHide: true });
    cleanups.push(() => void fixture.kill());
    const lines: string[] = [];
    const waiters: { re: RegExp; resolve: () => void }[] = [];
    createInterface({ input: fixture.stdout }).on('line', (l) => {
      lines.push(l.replace(/^﻿/, ''));
      for (const w of [...waiters]) if (lines.some((x) => w.re.test(x))) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
    });
    const waitLine = (re: RegExp) => (lines.some((x) => re.test(x)) ? Promise.resolve() : new Promise<void>((resolve, reject) => (waiters.push({ re, resolve }), setTimeout(() => reject(new Error(`attendu : ${re} ; reçu : ${lines.join(' | ')}`)), 60_000))));
    await waitLine(/^ready$/);

    const dir = mkdtempSync(join(tmpdir(), 'mh-uia-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const driver = new UiaDriver(dir, [], 'powershell.exe', 60_000);
    cleanups.push(() => driver.dispose());

    const w = (await driver.windows()).find((x) => x.title === title);
    expect(w).toMatchObject({ process: 'powershell', pid: fixture.pid });
    const tree = await driver.inspect(w!.window_id, { depth: 4, max: 50 });
    const byAuto = (id: string) => tree.nodes.find((n) => n.automation_id === id)!;
    expect(byAuto('valider')).toMatchObject({ type: 'Button', name: 'Valider' });
    expect(byAuto('valider').patterns.some((p) => p === 'Invoke' || p === 'DefaultAction')).toBe(true);
    expect(byAuto('option').patterns).toContain('Toggle');
    expect(byAuto('champ').patterns).toContain('Value');

    await driver.act(w!.window_id, byAuto('valider').element_id, 'invoke', {});
    await waitLine(/^clicked$/);
    await driver.act(w!.window_id, byAuto('option').element_id, 'toggle', {});
    await waitLine(/^checked:True$/);
    await driver.act(w!.window_id, byAuto('champ').element_id, 'set_value', { text: 'Bonjour é' });
    await waitLine(/^text:Bonjour é$/);
    await driver.act(w!.window_id, byAuto('champ').element_id, 'type', { text: ' !' });
    await waitLine(/^text:Bonjour é !$/);
    // Capacité absente : signalée avant toute action.
    await expect(driver.act(w!.window_id, byAuto('valider').element_id, 'toggle', {})).rejects.toBeInstanceOf(UnsupportedError);
    // Une nouvelle inspection fait expirer les identifiants précédents.
    await driver.inspect(w!.window_id, { depth: 2, max: 10 });
    await expect(driver.act(w!.window_id, byAuto('valider').element_id, 'invoke', {})).rejects.toThrow(/inconnu ou expiré/);

    // Processus protégé (fenêtres de Monolith) : ni listé ni contrôlable.
    const guarded = new UiaDriver(dir, [fixture.pid!], 'powershell.exe', 60_000);
    cleanups.push(() => guarded.dispose());
    expect((await guarded.windows()).some((x) => x.title === title)).toBe(false);
    await expect(guarded.inspect(w!.window_id, { depth: 1, max: 5 })).rejects.toThrow(/Monolith/);
  });
});
