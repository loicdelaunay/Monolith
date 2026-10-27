import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { createInProcessClient } from '@monolith/core';
import { sanitize } from '../src/sanitize.ts';
import * as ed from '../src/editor.ts';
import { completions, parseCommand } from '../src/commands.ts';
import { App } from '../src/app.tsx';
import { mockProvider, standardStream, tempHarness, writeFragmented } from '../../../packages/core/test/helpers.ts';

describe('assainissement terminal', () => {
  it('retire CSI, OSC (titre, presse-papiers, liens), DCS et contrôles', () => {
    const ESC = '\u001b';
    const ST = `${ESC}\\`;
    const evil = `ok${ESC}[31mrouge${ESC}[0m${ESC}]0;titre\u0007${ESC}]52;c;Y2xpcA==\u0007${ESC}]8;;http://x${ST}lien${ESC}]8;;${ST}${ESC}P1;2q${ST}\u0007\u0008\rfin\u009b2J`;
    expect(sanitize(evil)).toBe('okrougelienfin');
    expect(sanitize('a\tb\nc\r\nd')).toBe('a\tb\nc\nd');
    expect(sanitize('accents é à ç — 🚀')).toBe('accents é à ç — 🚀');
  });
});

describe('éditeur multiligne', () => {
  it('insère, efface par graphème et navigue entre les lignes', () => {
    let s = ed.insert(ed.empty(), 'héllo 👍🏽');
    s = ed.backspace(s);
    expect(s.text).toBe('héllo ');
    s = ed.insert(s, '\nmonde');
    expect(ed.lineInfo(s)).toMatchObject({ line: 1, column: 5 });
    s = ed.up(s)!;
    expect(ed.lineInfo(s)).toMatchObject({ line: 0, column: 5 });
    expect(ed.up(s)).toBeNull();
    expect(ed.deleteWordBefore(ed.end(s)).text).toBe('\nmonde');
  });

  it('rappelle l’historique en conservant le brouillon', () => {
    const h = new ed.History();
    h.push('un');
    h.push('deux');
    expect(h.previous('brouillon')).toBe('deux');
    expect(h.previous('deux')).toBe('un');
    expect(h.previous('un')).toBeNull();
    expect(h.next()).toBe('deux');
    expect(h.next()).toBe('brouillon');
  });
});

describe('commandes', () => {
  it('complète et analyse', () => {
    expect(completions('/pro').map((c) => c.name)).toEqual(['projects', 'project', 'providers', 'proposals']);
    expect(completions('/rename x')).toEqual([]);
    expect(parseCommand('/rename  Mon titre ')).toEqual({ name: 'rename', arg: 'Mon titre' });
  });
});

class FakeStdout extends Writable {
  frames: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = true;
  override _write(chunk: Buffer, _e: string, cb: () => void) {
    this.frames.push(chunk.toString());
    cb();
  }
  get text() {
    return sanitize(this.frames.join(''));
  }
}

function fakeStdin() {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (v: boolean) => void; ref: () => void; unref: () => void };
  s.isTTY = true;
  s.setRawMode = () => undefined;
  s.ref = () => undefined;
  s.unref = () => undefined;
  return s;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let lastOutput = () => '';
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`délai dépassé ; sortie :
${lastOutput().slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('parcours interactif', () => {
  it('envoie un message, affiche la réponse en flux et exécute une commande', async () => {
    const mock = await mockProvider((_req, _b, res) => writeFragmented(res, standardStream('Réponse du modèle en flux'), 4, 2));
    cleanups.push(mock.close);
    const { harness, cleanup } = tempHarness();
    cleanups.push(cleanup);
    const p = await harness.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await harness.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'mock-model' } });

    const stdout = new FakeStdout();
    const stdin = fakeStdin();
    lastOutput = () => stdout.text;
    const app = render(<App client={createInProcessClient(harness)} locale="fr" dataDir="test" changelog="" />, {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    });
    cleanups.push(() => app.unmount());
    await until(() => stdout.text.includes('Monolith Harness'));
    stdin.write('Bonjour');
    await until(() => stdout.text.includes('Bonjour'));
    stdin.write('\r');
    await until(() => stdout.text.includes('Réponse du modèle en flux'));
    await until(() => stdout.text.includes('mock-model'));
    const conversations = await harness.call('conversations.list', {});
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.title).toBe('Bonjour');

    stdin.write('/rename Titre CLI');
    await until(() => stdout.text.includes('/rename Titre CLI'));
    stdin.write('\r');
    await until(() => stdout.text.includes('Enregistré'));
    expect((await harness.call('conversations.get', { id: conversations[0]!.id })).title).toBe('Titre CLI');

    // Objectif, historique numéroté puis reprise depuis le premier message (génération terminée).
    await harness.generation.idle();
    stdin.write('/goal Livrer vite');
    await until(() => stdout.text.includes('/goal Livrer vite'));
    stdin.write('\r');
    await until(async () => (await harness.call('conversations.get', { id: conversations[0]!.id })).goal === 'Livrer vite');
    stdin.write('/resume 1');
    await until(() => stdout.text.includes('/resume 1'));
    stdin.write('\r');
    await until(() => stdout.text.includes('avant reprise'));
    expect(await harness.call('messages.list', { conversationId: conversations[0]!.id })).toEqual([]);
    expect((await harness.call('conversations.get', { id: conversations[0]!.id })).draft).toBe('Bonjour');
  });
});

describe('autorisations dans le terminal', () => {
  it('affiche la demande et applique la réponse au clavier', async () => {
    const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    let n = 0;
    const mock = await mockProvider((_req, _b, res) => {
      n++;
      const args = JSON.stringify({ path: 'note.txt', content: 'écrit depuis le CLI' });
      const body =
        n === 1
          ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: args } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
          : standardStream('Fichier écrit.');
      return writeFragmented(res, body, 50);
    });
    cleanups.push(mock.close);
    const { harness, cleanup } = tempHarness();
    cleanups.push(cleanup);
    const folder = mkdtempSync(join(tmpdir(), 'mh-cli-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const project = await harness.call('projects.create', { name: 'P' });
    await harness.call('projects.addFolder', { id: project.id, path: folder });
    const p = await harness.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await harness.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'mock-model', autoNaming: false } });
    const conv = await harness.call('conversations.create', { projectId: project.id });
    await harness.call('conversations.update', { id: conv.id, patch: { mode: 'agent', agentMode: 'execute' } });

    const stdout = new FakeStdout();
    const stdin = fakeStdin();
    lastOutput = () => stdout.text;
    const app = render(<App client={createInProcessClient(harness)} locale="fr" dataDir="test" changelog="" />, { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, debug: true });
    cleanups.push(() => app.unmount());
    await until(() => stdout.text.includes('Monolith Harness'));
    stdin.write('/open 1');
    await until(() => stdout.text.includes('/open 1'));
    stdin.write('\r');
    await until(() => stdout.text.includes('agent:execute'));
    stdin.write('Écris une note');
    await until(() => stdout.text.includes('Écris une note'));
    stdin.write('\r');
    await until(() => stdout.text.includes('Autorisation requise'));
    expect(existsSync(join(folder, 'note.txt'))).toBe(false);
    stdin.write('o');
    await harness.generation.idle();
    expect(readFileSync(join(folder, 'note.txt'), 'utf8')).toBe('écrit depuis le CLI');
    await until(() => stdout.text.includes('Fichier écrit.'));
  });
});
