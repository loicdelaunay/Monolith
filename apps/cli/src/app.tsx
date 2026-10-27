import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Box, Static, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import {
  APP_VERSION,
  HarnessError,
  translate,
  type Conversation,
  type GenerationState,
  type HarnessClient,
  type Id,
  type Locale,
  type AttachmentRef,
  type Message,
  type MessageDelta,
  type QueuedInput,
  type ReasoningLevel,
  type Project,
  type Provider,
  type Settings,
} from '@monolith/contracts';
import { sanitize } from './sanitize.ts';
import * as ed from './editor.ts';
import { COMMANDS, completions, parseCommand } from './commands.ts';
import { CLI_THEMES, findCliTheme, type CliTheme } from './themes.ts';

type Item =
  | { key: string; kind: 'banner' }
  | { key: string; kind: 'message'; message: Message }
  | { key: string; kind: 'note'; text: string; tone?: 'muted' | 'error' | 'success' | 'accent' };

interface Props {
  client: HarnessClient;
  locale: Locale;
  dataDir: string;
  changelog: string;
}

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function errorText(locale: Locale, e: unknown): string {
  if (e instanceof HarnessError) {
    const label = translate(locale, `errors.${e.code}`);
    return label !== `errors.${e.code}` ? `${label} — ${e.message}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function applyDelta(message: Message, d: MessageDelta): void {
  if (d.kind === 'part') message.parts[d.partIndex] = { ...d.part };
  else if (d.kind === 'text' || d.kind === 'reasoning') {
    const part = message.parts[d.partIndex];
    if (part && (part.type === 'text' || part.type === 'reasoning')) part.text += d.text;
  } else if (d.kind === 'status') message.status = d.status;
}

/** Rendu terminal simplifié du Markdown : blocs de code colorés, titres en gras. */
function MarkdownLines({ text, theme, maxLines }: { text: string; theme: CliTheme; maxLines?: number }) {
  let lines = sanitize(text).split('\n');
  if (maxLines && lines.length > maxLines) lines = ['…', ...lines.slice(-maxLines)];
  let inCode = false;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inCode = !inCode;
          return (
            <Text key={i} color={theme.muted}>
              {line.trim().length > 3 ? `┌ ${line.trim().replace(/^(```|~~~)/, '')}` : inCode ? '┌' : '└'}
            </Text>
          );
        }
        if (inCode) return <Text key={i} color={theme.code}>{`│ ${line}`}</Text>;
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) return <Text key={i} bold color={theme.accent}>{h[2]}</Text>;
        return <Text key={i} color={theme.assistant}>{line === '' ? ' ' : line}</Text>;
      })}
    </Box>
  );
}

function MessageView({ message, theme, settings, locale, tail }: { message: Message; theme: CliTheme; settings: Settings; locale: Locale; tail?: number }) {
  const t = (k: string, p?: Record<string, string | number>) => translate(locale, k, p);
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const files = message.parts.filter((p) => p.type === 'attachment').map((p) => sanitize((p as { attachment: AttachmentRef }).attachment.name));
    const origin = message.origin === 'steer' ? `⚡ ${t('queue.originSteer')}` : message.origin === 'queue' ? `⏱ ${t('queue.originQueue')}` : null;
    return (
      <Box marginTop={1} flexDirection="column">
        {origin ? <Text color={theme.muted}>{origin}</Text> : null}
        <Box>
          <Text color={theme.accent} bold>{'› '}</Text>
          <Text color={theme.user}>{sanitize(text)}</Text>
        </Box>
        {files.length ? <Text color={theme.muted}>{`  📎 ${files.join(', ')}`}</Text> : null}
      </Box>
    );
  }
  const display = settings.chat.reasoningDisplay;
  return (
    <Box flexDirection="column" marginTop={1}>
      {message.parts.map((part, i) => {
        if (part.type === 'reasoning') {
          if (display === 'none') return null;
          const lines = sanitize(part.text).split('\n');
          const shown = display === 'collapsed' ? lines.slice(-3) : lines;
          return (
            <Box key={i} flexDirection="column">
              <Text color={theme.reasoning} italic>{`✻ ${t('chat.reasoningBlock')}${display === 'collapsed' && lines.length > 3 ? ' (…)' : ''}`}</Text>
              {shown.map((l, j) => (
                <Text key={j} color={theme.reasoning} italic>{`  ${l}`}</Text>
              ))}
            </Box>
          );
        }
        if (part.type === 'text') return <MarkdownLines key={i} text={part.text} theme={theme} {...(tail ? { maxLines: tail } : {})} />;
        if (part.type !== 'notice') return null;
        return (
          <Text key={i} color={part.level === 'info' ? theme.muted : theme.warning}>
            {`⚠ ${sanitize(part.text)}`}
          </Text>
        );
      })}
      {message.error ? (
        <Text color={theme.error}>{`✖ ${translate(locale, `errors.${message.error.code}`)}${message.error.status ? ` (HTTP ${message.error.status})` : ''} — ${sanitize(message.error.message)}`}</Text>
      ) : null}
      {message.status !== 'streaming' ? (
        <Text color={theme.muted}>
          {[
            message.status !== 'complete' ? t(`chat.status.${message.status}`) : null,
            message.snapshot?.model,
            message.usage ? `${message.usage.inputTokens ?? '—'} ${t('chat.tokensIn')} · ${message.usage.outputTokens ?? '—'} ${t('chat.tokensOut')}${message.usage.cachedInputTokens ? ` · ${message.usage.cachedInputTokens} ${t('chat.cached')}` : ''}${message.usage.estimated ? ` (${t('chat.estimated')})` : ''}` : null,
            message.durationMs ? `${(message.durationMs / 1000).toFixed(1)} s` : null,
            message.snapshot?.reasoning && (message.snapshot.reasoning.requested !== 'auto' || message.snapshot.reasoning.fallback)
              ? `✻ ${t('chat.reasoningSent', { requested: t(`reasoningLevels.${message.snapshot.reasoning.requested}`), sent: t(`reasoningLevels.${message.snapshot.reasoning.sent ?? 'auto'}`) })}${message.snapshot.reasoning.parameter ? ` (${message.snapshot.reasoning.parameter})` : ''}${message.snapshot.reasoning.fallback ? ` — ${t('chat.reasoningFallback', { reason: message.snapshot.reasoning.fallback })}` : ''}`
              : null,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </Text>
      ) : null}
    </Box>
  );
}

export function App({ client, locale, dataDir, changelog }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const t = useCallback((k: string, p?: Record<string, string | number>) => translate(locale, k, p), [locale]);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [contextProject, setContextProject] = useState<Id | null>(null);
  const [items, setItems] = useState<Item[]>([{ key: nextKey(), kind: 'banner' }]);
  const [epoch, setEpoch] = useState(0);
  const [streaming, setStreaming] = useState<Message | null>(null);
  const [, setTick] = useState(0);
  const [gen, setGen] = useState<GenerationState | null>(null);
  const [editor, setEditor] = useState<ed.EditorState>(ed.empty());
  const [selection, setSelection] = useState(0);
  const [pendingConfirm, setPendingConfirm] = useState<{ prompt: string; run: () => Promise<void> } | null>(null);
  const [queue, setQueue] = useState<QueuedInput[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const history = useRef(new ed.History());
  const activeRef = useRef<Conversation | null>(null);
  const streamingRef = useRef<Message | null>(null);
  const lastCtrlC = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  activeRef.current = active;
  const theme = useMemo(() => findCliTheme(settings?.cli.theme), [settings?.cli.theme]);

  const note = useCallback((text: string, tone: 'muted' | 'error' | 'success' | 'accent' = 'muted') => {
    setItems((list) => [...list, { key: nextKey(), kind: 'note', text, tone }]);
  }, []);

  // ---------- Chargement et événements du moteur ----------
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, p, pr, c] = await Promise.all([
        client.call('settings.get'),
        client.call('projects.list'),
        client.call('providers.list'),
        client.call('conversations.list', { includeArchived: false }),
      ]);
      if (!alive) return;
      setSettings(s);
      setProjects(p);
      setProviders(pr);
      setConversations(c);
    })();
    const offs = [
      client.on('settings.changed', setSettings),
      client.on('projects.changed', ({ projects }) => setProjects(projects)),
      client.on('providers.changed', ({ providers }) => setProviders(providers)),
      client.on('conversation.changed', ({ conversation }) => {
        setConversations((list) => {
          const others = list.filter((x) => x.id !== conversation.id);
          return conversation.archived ? others : [conversation, ...others];
        });
        if (activeRef.current?.id === conversation.id) setActive(conversation);
      }),
      client.on('conversation.deleted', ({ id }) => {
        setConversations((list) => list.filter((x) => x.id !== id));
        if (activeRef.current?.id === id) setActive(null);
      }),
      client.on('message.added', ({ message }) => {
        if (message.conversationId !== activeRef.current?.id) return;
        if (message.role === 'assistant' && message.status === 'streaming') {
          streamingRef.current = structuredClone(message);
          setStreaming(streamingRef.current);
        } else setItems((list) => [...list, { key: nextKey(), kind: 'message', message }]);
      }),
      client.on('message.delta', ({ messageId, deltas }) => {
        const m = streamingRef.current;
        if (!m || m.id !== messageId) return;
        for (const d of deltas) applyDelta(m, d);
        setTick((x) => x + 1);
      }),
      client.on('message.updated', ({ message }) => {
        if (streamingRef.current?.id !== message.id) return;
        streamingRef.current = null;
        setStreaming(null);
        setItems((list) => [...list, { key: nextKey(), kind: 'message', message }]);
      }),
      client.on('queue.changed', ({ conversationId, items }) => {
        if (conversationId === activeRef.current?.id) setQueue(items);
      }),
      client.on('conversation.messagesReset', ({ conversationId }) => {
        const c = activeRef.current;
        if (c && c.id === conversationId) void client.call('conversations.get', { id: c.id }).then((fresh) => openConversationRef.current?.(fresh));
      }),
      client.on('compaction.added', ({ compaction }) => {
        if (compaction.conversationId === activeRef.current?.id) note(t(compaction.trigger === 'auto' ? 'chat.compactedAuto' : 'chat.compactedManual', { date: new Date(compaction.createdAt).toLocaleString() }), 'accent');
      }),
      client.on('log.error', (e) => note(`${t(`errors.${e.code}`)} — ${e.message}`, 'error')),
      client.on('generation.state', (s) => {
        if (s.conversationId !== activeRef.current?.id) return;
        setGen(s.status === 'finished' ? null : s);
      }),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
    };
  }, [client]);

  // ---------- Brouillons ----------
  useEffect(() => {
    const c = activeRef.current;
    if (!c) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void client.call('conversations.saveDraft', { id: c.id, draft: editor.text, attachmentIds: attachments.map((a) => a.id) }).catch(() => undefined), 500);
  }, [editor.text, attachments, client]);

  const clearScreen = () => {
    stdout.write('\u001b[2J\u001b[3J\u001b[H');
    setEpoch((e) => e + 1);
  };

  const openConversation = useCallback(
    async (c: Conversation) => {
      const messages = await client.call('messages.list', { conversationId: c.id });
      clearScreen();
      // Référence mise à jour immédiatement : les événements du premier envoi arrivent avant le rendu.
      activeRef.current = c;
      setActive(c);
      setContextProject(c.projectId);
      setGen(null);
      const running = messages.find((m) => m.status === 'streaming');
      streamingRef.current = running ? structuredClone(running) : null;
      setStreaming(streamingRef.current);
      setItems([
        { key: nextKey(), kind: 'banner' },
        ...messages.filter((m) => m !== running).map((message): Item => ({ key: nextKey(), kind: 'message', message })),
      ]);
      setEditor({ text: c.draft, cursor: c.draft.length });
      setAttachments(c.draftAttachments);
      setQueue(await client.call('queue.list', { conversationId: c.id }));
      history.current.reset();
    },
    [client],
  );
  const openConversationRef = useRef(openConversation);
  openConversationRef.current = openConversation;

  const projectName = (id: Id | null) => (id === null ? t('sidebar.personal') : (projects.find((p) => p.id === id)?.name ?? '?'));
  const effective = (c: Conversation | null) => {
    const providerId = c?.providerId ?? settings?.chat.defaultProviderId ?? null;
    const model = c && c.providerId !== null ? c.model : (settings?.chat.defaultModel ?? null);
    return { provider: providers.find((p) => p.id === providerId) ?? null, model };
  };

  // ---------- Commandes ----------
  const runCommand = async (name: string, arg: string): Promise<void> => {
    const c = activeRef.current;
    const needConversation = () => {
      if (!c) throw new HarnessError('invalid_argument', t('cli.noConversation'));
      return c;
    };
    switch (name) {
      case 'help':
        note(COMMANDS.map((cmd) => `/${cmd.name}${cmd.args ? ' ' + cmd.args : ''} — ${t(cmd.help)}`).join('\n') + '\n\n' + t('cli.keys'), 'muted');
        return;
      case 'new': {
        const created = await client.call('conversations.create', { projectId: contextProject, ...(arg ? { title: arg } : {}) });
        await openConversation(created);
        return;
      }
      case 'list': {
        const list = await client.call('conversations.list', { includeArchived: arg === 'all' });
        setConversations(list.filter((x) => !x.archived));
        if (list.length === 0) return note(t('sidebar.noConversations'));
        note(list.map((x, i) => `${String(i + 1).padStart(3)}. ${x.pinned ? '📌 ' : x.favorite ? '★ ' : ''}${sanitize(x.title)}  [${projectName(x.projectId)}]${x.archived ? ` (${t('conversation.archived')})` : ''}${x.generating ? ' …' : ''}`).join('\n'));
        return;
      }
      case 'open': {
        const list = await client.call('conversations.list', { includeArchived: true });
        const n = Number(arg);
        const target = Number.isInteger(n) && n > 0 ? list[n - 1] : list.find((x) => x.title.toLowerCase().includes(arg.toLowerCase()));
        if (!target) return note(t('sidebar.noResults'), 'error');
        await openConversation(target);
        return;
      }
      case 'rename':
        if (!arg) return note(t('cli.argRequired'), 'error');
        await client.call('conversations.update', { id: needConversation().id, patch: { title: arg } });
        return note(t('common.saved'), 'success');
      case 'delete': {
        const conv = needConversation();
        setPendingConfirm({
          prompt: t('conversation.deleteMessage', { title: sanitize(conv.title) }) + ' (o/n)',
          run: async () => {
            await client.call('conversations.delete', { id: conv.id });
            clearScreen();
            setItems([{ key: nextKey(), kind: 'banner' }]);
            note(t('cli.deleted'), 'success');
          },
        });
        return;
      }
      case 'archive':
        await client.call('conversations.update', { id: needConversation().id, patch: { archived: !needConversation().archived } });
        return note(needConversation().archived ? t('conversation.unarchive') : t('conversation.archive'), 'success');
      case 'pin':
        await client.call('conversations.update', { id: needConversation().id, patch: { pinned: !needConversation().pinned } });
        return note(t('common.saved'), 'success');
      case 'fav':
        await client.call('conversations.update', { id: needConversation().id, patch: { favorite: !needConversation().favorite } });
        return note(t('common.saved'), 'success');
      case 'search': {
        if (!arg) return note(t('cli.argRequired'), 'error');
        const hits = await client.call('conversations.search', { query: arg, limit: 20 });
        if (hits.length === 0) return note(t('sidebar.noResults'));
        note(hits.map((h) => `• ${sanitize(h.title)} [${projectName(h.projectId)}]${h.snippet ? `\n    ${sanitize(h.snippet)}` : ''}`).join('\n') + `\n${t('cli.openHint')}`);
        return;
      }
      case 'projects':
        if (projects.length === 0) return note(t('cli.noProjects'));
        return note(projects.map((p, i) => `${String(i + 1).padStart(3)}. ${sanitize(p.name)}${p.folders.length ? `  (${p.folders.map((f) => f.path).join(', ')})` : ''}${p.id === contextProject ? '  ◀' : ''}`).join('\n'));
      case 'project': {
        if (!arg) return note(`${t('cli.currentProject')} ${projectName(contextProject)}`);
        if (arg === 'perso' || arg === 'personal') {
          setContextProject(null);
          return note(`${t('cli.currentProject')} ${t('sidebar.personal')}`, 'success');
        }
        if (arg.startsWith('new ')) {
          const p = await client.call('projects.create', { name: arg.slice(4).trim() });
          setContextProject(p.id);
          return note(`${t('cli.currentProject')} ${sanitize(p.name)}`, 'success');
        }
        const n = Number(arg);
        const p = Number.isInteger(n) && n > 0 ? projects[n - 1] : projects.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
        if (!p) return note(t('sidebar.noResults'), 'error');
        setContextProject(p.id);
        return note(`${t('cli.currentProject')} ${sanitize(p.name)} — ${t('cli.newHint')}`, 'success');
      }
      case 'move': {
        const conv = needConversation();
        const target = arg === 'perso' || arg === 'personal' ? null : (projects.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()))?.id ?? undefined);
        if (target === undefined) return note(t('sidebar.noResults'), 'error');
        await client.call('conversations.update', { id: conv.id, patch: { projectId: target } });
        return note(t('common.saved'), 'success');
      }
      case 'providers':
        if (providers.length === 0) return note(t('cli.noProviders'), 'error');
        return note(
          providers
            .map((p) => `${p.enabled ? '●' : '○'} ${sanitize(p.name)}  ${p.baseUrl}  ${p.hasKey ? '🔒' : ''}\n    ${p.models.filter((m) => m.enabled).map((m) => m.id).join(', ') || t('chat.noModels')}`)
            .join('\n'),
        );
      case 'model': {
        const conv = needConversation();
        if (!arg) {
          const e = effective(conv);
          return note(`${e.provider ? sanitize(e.provider.name) : '—'} / ${e.model ?? '—'}`);
        }
        const [a, b] = arg.includes('/') && providers.some((p) => arg.toLowerCase().startsWith(p.name.toLowerCase() + '/')) ? [arg.slice(0, arg.indexOf('/')), arg.slice(arg.indexOf('/') + 1)] : [null, arg];
        const provider = a ? providers.find((p) => p.name.toLowerCase() === a.toLowerCase()) : (providers.find((p) => p.models.some((m) => m.id === b)) ?? effective(conv).provider);
        if (!provider) return note(t('cli.noProviders'), 'error');
        await client.call('conversations.update', { id: conv.id, patch: { providerId: provider.id, model: b } });
        return note(`${sanitize(provider.name)} / ${b}`, 'success');
      }
      case 'cancel':
        if (c) await client.call('chat.cancel', { conversationId: c.id });
        return;
      case 'steer': {
        const conv = needConversation();
        if (!arg) return note(t('cli.argRequired'), 'error');
        const r = await client.call('chat.send', { conversationId: conv.id, input: { text: arg, mode: 'steer' } });
        return note(r.status === 'steered' ? t('queue.steered') : t('cli.sentNow'), 'success');
      }
      case 'queue':
        if (queue.length === 0) return note(t('cli.queueEmpty'));
        return note(queue.map((q, i) => `${String(i + 1).padStart(3)}. ${q.kind === 'steer' ? '⚡' : '⏱'} ${sanitize(q.text)}${q.attachments.length ? ` 📎${q.attachments.length}` : ''}`).join('\n'));
      case 'unqueue': {
        const item = queue[Number(arg) - 1];
        if (!item) return note(t('sidebar.noResults'), 'error');
        await client.call('queue.remove', { id: item.id });
        return note(t('common.saved'), 'success');
      }
      case 'next':
        await client.call('queue.sendNext', { conversationId: needConversation().id });
        return;
      case 'history': {
        const list = (await client.call('messages.list', { conversationId: needConversation().id })).filter((m) => m.role === 'user');
        if (list.length === 0) return note(t('sidebar.noConversations'));
        return note(list.map((m, i) => `${String(i + 1).padStart(3)}. ${sanitize(m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').split('\n')[0]!.slice(0, 90))}`).join('\n') + `\n${t('cli.historyHint')}`);
      }
      case 'resume': {
        const conv = needConversation();
        const users = (await client.call('messages.list', { conversationId: conv.id })).filter((m) => m.role === 'user');
        const target = users[Number(arg) - 1];
        if (!target) return note(t('cli.historyHint'), 'error');
        const r = await client.call('conversations.resumeFrom', { id: conv.id, messageId: target.id });
        const backup = await client.call('conversations.get', { id: r.backupConversationId });
        note(t('actions.resumedDetail', { title: sanitize(backup.title) }), 'success');
        return;
      }
      case 'fork': {
        const conv = needConversation();
        let messageId: number | null = null;
        if (arg) {
          const users = (await client.call('messages.list', { conversationId: conv.id })).filter((m) => m.role === 'user');
          messageId = users[Number(arg) - 1]?.id ?? null;
          if (messageId === null) return note(t('cli.historyHint'), 'error');
        }
        const copy = await client.call('conversations.fork', { id: conv.id, messageId });
        await openConversation(copy);
        return note(messageId === null ? t('actions.duplicated') : t('actions.forked'), 'success');
      }
      case 'export': {
        const conv = needConversation();
        const includeReasoning = /--reasoning\b/.test(arg);
        const target = arg.replace(/--reasoning\b/, '').trim();
        const { fileName, markdown } = await client.call('conversations.exportMarkdown', { id: conv.id, includeReasoning });
        const path = resolve(target || fileName);
        // Aucun écrasement silencieux.
        if (existsSync(path)) return note(t('cli.fileExists', { path }), 'error');
        writeFileSync(path, markdown, 'utf8');
        return note(`${t('actions.exported')} : ${path}`, 'success');
      }
      case 'goal': {
        const conv = needConversation();
        if (!arg) return note(conv.goal ? `${t('actions.goal')} : ${sanitize(conv.goal)}` : t('cli.noGoal'));
        await client.call('conversations.update', { id: conv.id, patch: { goal: arg === '-' ? '' : arg } });
        return note(t('common.saved'), 'success');
      }
      case 'compact': {
        note(t('actions.compacting'));
        const c2 = await client.call('conversations.compact', { id: needConversation().id });
        return note(t('actions.compactedDetail', { count: c2.upToSeq }), 'success');
      }
      case 'context': {
        const u = await client.call('conversations.contextUsage', { id: needConversation().id });
        return note(`${t('chat.contextUsage', { used: u.tokens, total: u.contextWindow ?? '?' })}${u.source === 'estimate' ? ` (${t('chat.estimated')})` : ''} · ${t('cli.compactions', { count: u.compactions })}`);
      }
      case 'templates': {
        const list = await client.call('templates.list');
        if (list.length === 0) return note(t('templates.empty'));
        return note(list.map((x) => `• ${sanitize(x.name)} — ${sanitize(x.content.split('\n')[0]!.slice(0, 70))}`).join('\n'));
      }
      case 'template': {
        const list = await client.call('templates.list');
        const tpl = list.find((x) => x.name.toLowerCase() === arg.toLowerCase()) ?? list.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
        if (!arg || !tpl) return note(t('sidebar.noResults'), 'error');
        setEditor({ text: tpl.content, cursor: tpl.content.length });
        return;
      }
      case 'attach': {
        if (!arg) return note(t('cli.argRequired'), 'error');
        const path = resolve(arg.replace(/^["']|["']$/g, ''));
        if (!existsSync(path)) return note(t('cli.fileMissing', { path }), 'error');
        const ref = await client.call('attachments.upload', { name: basename(path), mime: '', dataBase64: readFileSync(path).toString('base64') });
        setAttachments((list) => [...list, ref]);
        return note(`📎 ${sanitize(ref.name)} (${ref.kind}, ${Math.round(ref.size / 1024)} Ko)`, 'success');
      }
      case 'detach':
        setAttachments([]);
        return note(t('cli.detached'), 'success');
      case 'reasoning': {
        const conv = needConversation();
        const e = effective(conv);
        const caps = e.provider?.models.find((m) => m.id === e.model)?.capabilities;
        const levels: ReasoningLevel[] = ['auto', ...(caps?.reasoningLevels ?? []).filter((l) => !caps?.rejectedLevels.includes(l))];
        if (!arg) return note(`${t('chat.reasoning')} : ${t(`reasoningLevels.${conv.reasoningLevel}`)} — ${t('cli.levels')} ${levels.join(', ')}${levels.length === 1 ? `\n${t('chat.reasoningOnlyAuto')}` : ''}`);
        if (!levels.includes(arg as ReasoningLevel)) return note(`${t('cli.levels')} ${levels.join(', ')}`, 'error');
        await client.call('conversations.update', { id: conv.id, patch: { reasoningLevel: arg as ReasoningLevel } });
        return note(t('common.saved'), 'success');
      }
      case 'theme': {
        if (!arg || !CLI_THEMES.some((x) => x.id === arg)) return note(`${t('cli.themes')} ${CLI_THEMES.map((x) => x.id).join(', ')}`);
        await client.call('settings.update', { cli: { theme: arg } });
        return note(t('common.saved'), 'success');
      }
      case 'info': {
        const info = await client.call('app.info');
        return note(`Monolith Harness ${info.version} (CLI)\n${t('settings.about.data')} : ${info.dataDir} (${t(`settings.general.dataSource.${info.dataDirSource}`)})\nNode ${info.nodeVersion} · SQLite ${info.sqliteVersion} · ${info.platform} ${info.arch}\n${t('settings.general.secrets')} : ${info.secretProtection.mechanism} — ${info.secretProtection.message}\n${t('cli.guiOnly')}`);
      }
      case 'changelog':
        return note(changelog.split('\n').slice(0, 40).join('\n'));
      case 'quit':
      case 'exit':
        exit();
        return;
      default:
        note(t('cli.unknownCommand', { name }), 'error');
    }
  };

  const submit = async () => {
    const text = editor.text;
    if (!text.trim() && attachments.length === 0) return;
    if (text.trim().startsWith('/')) {
      const parsed = parseCommand(text);
      const matches = completions(text.trim());
      const name = parsed && !COMMANDS.some((c) => c.name === parsed.name) && matches.length === 1 ? matches[0]!.name : parsed?.name;
      setEditor(ed.empty());
      history.current.push(text);
      if (name) await runCommand(name, parsed?.arg ?? '').catch((e) => note(errorText(locale, e), 'error'));
      return;
    }
    try {
      let conv = activeRef.current;
      if (!conv) {
        conv = await client.call('conversations.create', { projectId: contextProject });
        await openConversation(conv);
      }
      history.current.push(text);
      setEditor(ed.empty());
      const ids = attachments.map((a) => a.id);
      setAttachments([]);
      // Pendant une génération, Entrée met en file ; /steer transmet à la prochaine frontière.
      const r = await client.call('chat.send', { conversationId: conv.id, input: { text, attachmentIds: ids, mode: 'queue' } });
      if (r.status === 'queued') note(t('queue.added'));
    } catch (e) {
      note(errorText(locale, e), 'error');
    }
  };

  // ---------- Saisie ----------
  usePaste((text) => {
    setEditor((s) => ed.insert(s, text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')));
  });

  const suggestions = completions(editor.text);
  useEffect(() => setSelection(0), [editor.text]);

  useInput((input, key) => {
    if (pendingConfirm) {
      const yes = /^[oy]$/i.test(input);
      const job = pendingConfirm;
      setPendingConfirm(null);
      if (yes) void job.run().catch((e) => note(errorText(locale, e), 'error'));
      else note(t('common.cancel'));
      return;
    }
    if (key.ctrl && input === 'c') {
      if (gen && activeRef.current) {
        void client.call('chat.cancel', { conversationId: activeRef.current.id });
        return;
      }
      if (editor.text) {
        setEditor(ed.empty());
        return;
      }
      if (Date.now() - lastCtrlC.current < 1500) exit();
      else {
        lastCtrlC.current = Date.now();
        note(t('cli.ctrlCAgain'));
      }
      return;
    }
    if (key.escape) {
      if (gen && activeRef.current) void client.call('chat.cancel', { conversationId: activeRef.current.id });
      return;
    }
    if (key.return) {
      // Nouvelle ligne : Maj+Entrée (terminaux compatibles), Alt+Entrée, ou « \ » en fin de ligne.
      if (key.shift || key.meta) return setEditor((s) => ed.insert(s, '\n'));
      if (editor.text.slice(0, editor.cursor).endsWith('\\')) return setEditor((s) => ed.insert(ed.backspace(s), '\n'));
      if (suggestions.length > 0 && !COMMANDS.some((c) => `/${c.name}` === editor.text.trim())) {
        const pick = suggestions[selection] ?? suggestions[0]!;
        if (!pick.args) {
          void runCommand(pick.name, '').catch((e) => note(errorText(locale, e), 'error'));
          setEditor(ed.empty());
          return;
        }
        const text = `/${pick.name} `;
        return setEditor({ text, cursor: text.length });
      }
      void submit();
      return;
    }
    if (input === '\n' || (key.ctrl && input === 'j')) return setEditor((s) => ed.insert(s, '\n'));
    if (key.tab && suggestions.length > 0) {
      const pick = suggestions[selection] ?? suggestions[0]!;
      const text = `/${pick.name}${pick.args ? ' ' : ''}`;
      return setEditor({ text, cursor: text.length });
    }
    if (key.upArrow) {
      if (suggestions.length > 0) return setSelection((i) => (i - 1 + suggestions.length) % suggestions.length);
      const moved = ed.up(editor);
      if (moved) return setEditor(moved);
      const prev = history.current.previous(editor.text);
      if (prev !== null) setEditor({ text: prev, cursor: prev.length });
      return;
    }
    if (key.downArrow) {
      if (suggestions.length > 0) return setSelection((i) => (i + 1) % suggestions.length);
      const moved = ed.down(editor);
      if (moved) return setEditor(moved);
      const next = history.current.next();
      if (next !== null) setEditor({ text: next, cursor: next.length });
      return;
    }
    if (key.leftArrow) return setEditor((s) => ed.left(s));
    if (key.rightArrow) return setEditor((s) => ed.right(s));
    if (key.home || (key.ctrl && input === 'a')) return setEditor((s) => ed.home(s));
    if (key.end || (key.ctrl && input === 'e')) return setEditor((s) => ed.end(s));
    if (key.ctrl && input === 'w') return setEditor((s) => ed.deleteWordBefore(s));
    if (key.ctrl && input === 'u') return setEditor(ed.empty());
    if (key.ctrl && input === 'l') return clearScreen();
    if (key.backspace) return setEditor((s) => ed.backspace(s));
    if (key.delete) return setEditor((s) => ed.del(s));
    if (key.ctrl || key.meta) return;
    if (input) setEditor((s) => ed.insert(s, input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')));
  });

  if (!settings) return <Text color="gray">{t('app.loading')}</Text>;

  const { provider, model } = effective(active);
  const width = Math.max(20, columns);
  const tail = Math.max(6, rows - 12);
  const { line: curLine, column: curCol, lines } = ed.lineInfo(editor);
  const toneColor = (tone?: string) => (tone === 'error' ? theme.error : tone === 'success' ? theme.success : tone === 'accent' ? theme.accent : theme.muted);

  return (
    <Box flexDirection="column">
      <Static key={epoch} items={items}>
        {(item) =>
          item.kind === 'banner' ? (
            <Box key={item.key} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
              <Text>
                <Text bold color={theme.accent}>Monolith Harness</Text>
                <Text color={theme.muted}>{`  v${APP_VERSION} · CLI`}</Text>
              </Text>
              <Text color={theme.muted}>{active ? `${projectName(active.projectId)} › ${sanitize(active.title)}` : t('cli.welcome')}</Text>
              <Text color={theme.muted}>{`${t('settings.about.data')} : ${dataDir}`}</Text>
            </Box>
          ) : item.kind === 'message' ? (
            <MessageView key={item.key} message={item.message} theme={theme} settings={settings} locale={locale} />
          ) : (
            <Box key={item.key} marginTop={1}>
              <Text color={toneColor(item.tone)}>{sanitize(item.text)}</Text>
            </Box>
          )
        }
      </Static>

      {streaming ? <MessageView message={streaming} theme={theme} settings={settings} locale={locale} tail={tail} /> : null}
      {gen ? (
        <Text color={theme.muted}>
          {gen.status === 'retrying' ? t('chat.retrying', { attempt: gen.attempt + 1, seconds: Math.ceil((gen.retryInMs ?? 0) / 1000), reason: gen.retryReason ?? '' }) : `◌ ${t('chat.thinking')}`}
          {`  ${t('cli.stopHint')}`}
        </Text>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.border}>{'─'.repeat(width)}</Text>
      </Box>
      {pendingConfirm ? (
        <Text color={theme.warning}>{pendingConfirm.prompt}</Text>
      ) : (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}>
              <Text color={theme.accent}>{i === 0 ? '› ' : '  '}</Text>
              {i === curLine ? (
                <>
                  <Text>{line.slice(0, curCol)}</Text>
                  <Text inverse>{line.slice(curCol, curCol + 1) || ' '}</Text>
                  <Text>{line.slice(curCol + 1)}</Text>
                </>
              ) : (
                <Text>{line}</Text>
              )}
              {i === 0 && editor.text === '' ? <Text color={theme.muted}>{t('cli.placeholder')}</Text> : null}
            </Text>
          ))}
        </Box>
      )}
      {suggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {suggestions.slice(0, 8).map((s, i) => (
            <Text key={s.name} color={i === selection ? theme.accent : theme.muted}>
              {`${i === selection ? '▸' : ' '} /${s.name}${s.args ? ' ' + s.args : ''}  — ${t(s.help)}`}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text color={theme.muted}>
        {`${projectName(active?.projectId ?? contextProject)}${active ? ` › ${sanitize(active.title)}` : ''}  ·  ${provider ? sanitize(provider.name) : t('cli.noProvider')}${model ? ` / ${model}` : ''}${active && active.reasoningLevel !== 'auto' ? ` · ✻ ${active.reasoningLevel}` : ''}${queue.length ? `  ·  ⏱ ${queue.length}` : ''}${attachments.length ? `  ·  📎 ${attachments.map((a) => sanitize(a.name)).join(', ')}` : ''}${active?.goal ? '  ·  ⚑' : ''}  ·  /help`}
      </Text>
    </Box>
  );
}
