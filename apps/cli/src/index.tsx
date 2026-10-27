import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { render } from 'ink';
import { APP_VERSION, resolveLocale, translate, type Locale, type MessageDelta } from '@monolith/contracts';
import { Harness, createInProcessClient } from '@monolith/core';
import { App } from './app.tsx';
import { sanitize } from './sanitize.ts';
import changelog from '../../../CHANGELOG.md';

const HELP = `Monolith Harness ${APP_VERSION} — CLI

Usage :
  monolith                      interface interactive
  monolith -p "question"        réponse unique sur la sortie standard (non interactif)
  echo "question" | monolith -p -

Options :
  --data-dir <dossier>          dossier de données (sinon portable / MONOLITH_DATA_DIR / dossier utilisateur)
  --model <connexion/modèle>    modèle pour -p (sinon le modèle par défaut)
  --lang <fr|en>                langue de l'interface
  -v, --version                 version
  -h, --help                    aide
`;

async function isSea(): Promise<boolean> {
  try {
    const sea = (await import('node:sea')) as { isSea(): boolean };
    return sea.isSea();
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      print: { type: 'string', short: 'p' },
      model: { type: 'string' },
      lang: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }

  const exeDir = (await isSea()) ? dirname(process.execPath) : null;
  const harness = new Harness({ host: 'cli', data: { explicit: values['data-dir'] ?? null, exeDir }, changelog });
  const client = createInProcessClient(harness);
  const settings = await client.call('settings.get');
  const locale: Locale = values.lang === 'fr' || values.lang === 'en' ? values.lang : resolveLocale(settings.general.language, Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG);

  try {
    if (values.print !== undefined) return await printMode(harness, client, locale, values.print === '-' ? await readStdin() : values.print, values.model);
    if (!process.stdin.isTTY) {
      process.stderr.write(`${translate(locale, 'cli.noTty')}\n`);
      return 2;
    }
    const app = render(<App client={client} locale={locale} dataDir={harness.dataDir.dir} changelog={changelog} />, {
      exitOnCtrlC: false,
      patchConsole: true,
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard: { mode: 'auto' },
    });
    await app.waitUntilExit();
    return 0;
  } finally {
    await harness.close();
  }
}

/** Mode non interactif : une question, la réponse en flux sur stdout (assainie), code de sortie selon le résultat. */
async function printMode(harness: Harness, client: ReturnType<typeof createInProcessClient>, locale: Locale, text: string, modelArg: string | undefined): Promise<number> {
  const conv = await client.call('conversations.create', { projectId: null });
  if (modelArg) {
    const providers = await client.call('providers.list');
    const slash = modelArg.indexOf('/');
    const named = slash > 0 ? providers.find((p) => p.name.toLowerCase() === modelArg.slice(0, slash).toLowerCase()) : undefined;
    const model = named ? modelArg.slice(slash + 1) : modelArg;
    const provider = named ?? providers.find((p) => p.models.some((m) => m.id === model));
    if (!provider) throw new Error(translate(locale, 'cli.noProviders'));
    await client.call('conversations.update', { id: conv.id, patch: { providerId: provider.id, model } });
  }
  let assistantId: number | null = null;
  const done = new Promise<number>((resolve) => {
    client.on('message.delta', ({ messageId, deltas }: { messageId: number; deltas: MessageDelta[] }) => {
      if (messageId !== assistantId) return;
      for (const d of deltas) if (d.kind === 'text' && process.stdout.writable) process.stdout.write(sanitize(d.text));
    });
    client.on('message.updated', ({ message }) => {
      if (message.id !== assistantId) return;
      process.stdout.write('\n');
      if (message.error) process.stderr.write(`${translate(locale, `errors.${message.error.code}`)} — ${message.error.message}\n`);
      resolve(message.status === 'complete' ? 0 : 1);
    });
  });
  process.on('SIGINT', () => void client.call('chat.cancel', { conversationId: conv.id }));
  // Sortie fermée par le lecteur (ex. `| head`) : on arrête proprement la génération.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') return;
    void client.call('chat.cancel', { conversationId: conv.id });
    process.exitCode = 0;
  });
  const sent = await client.call('chat.send', { conversationId: conv.id, input: { text } });
  assistantId = sent.assistantMessageId;
  const code = await done;
  await harness.generation.idle();
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
