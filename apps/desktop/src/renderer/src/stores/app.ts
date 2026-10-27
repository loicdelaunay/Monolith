import { computed, reactive, shallowRef, triggerRef, type ShallowRef } from 'vue';
import type {
  AppInfo,
  Compaction,
  Conversation,
  MessageTemplate,
  QueuedInput,
  GenerationState,
  Id,
  Message,
  MessageDelta,
  Project,
  Provider,
  ProviderPreset,
  Settings,
} from '@monolith/contracts';
import { api, host } from '../api.ts';
import type { RendererInfo } from '../../../shared/bridge.ts';

/**
 * État de l'interface : un cache d'affichage alimenté par les événements du moteur.
 * Le moteur reste la source de vérité ; aucune règle métier n'est dupliquée ici.
 */
export const store = reactive({
  ready: false,
  fatal: null as string | null,
  info: null as AppInfo | null,
  renderer: null as RendererInfo | null,
  settings: null as Settings | null,
  projects: [] as Project[],
  providers: [] as Provider[],
  presets: [] as ProviderPreset[],
  conversations: new Map<Id, Conversation>(),
  generations: new Map<Id, GenerationState>(),
  activeId: null as Id | null,
  loadingMessages: false,
  queues: new Map<Id, QueuedInput[]>(),
  compactions: new Map<Id, Compaction[]>(),
  templates: [] as MessageTemplate[],
  /** Erreurs signalées par le moteur hors d'un appel (ex. élément de file non envoyé). */
  engineErrors: [] as { code: string; message: string }[],
});

/** Messages par conversation ouverte. `shallowRef` : on déclenche le rendu explicitement. */
const messageCache = new Map<Id, ShallowRef<Message[]>>();

export function messagesOf(conversationId: Id) {
  let ref = messageCache.get(conversationId);
  if (!ref) {
    ref = shallowRef<Message[]>([]) as ShallowRef<Message[]>;
    messageCache.set(conversationId, ref);
  }
  return ref;
}

export const activeConversation = computed(() => (store.activeId !== null ? (store.conversations.get(store.activeId) ?? null) : null));

export function conversationsIn(projectId: Id | null, includeArchived: boolean): Conversation[] {
  return [...store.conversations.values()]
    .filter((c) => c.projectId === projectId && (includeArchived || !c.archived))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || b.id - a.id);
}

export async function loadMessages(conversationId: Id): Promise<void> {
  const ref = messagesOf(conversationId);
  store.loadingMessages = true;
  try {
    const [messages, queue, compactions] = await Promise.all([
      api.call('messages.list', { conversationId }),
      api.call('queue.list', { conversationId }),
      api.call('compactions.list', { conversationId }),
    ]);
    ref.value = messages;
    store.queues.set(conversationId, queue);
    store.compactions.set(conversationId, compactions);
  } finally {
    store.loadingMessages = false;
  }
}

export async function openConversation(id: Id | null): Promise<void> {
  store.activeId = id;
  if (id !== null) await loadMessages(id);
}

function applyDelta(message: Message, d: MessageDelta): void {
  if (d.kind === 'part') {
    message.parts[d.partIndex] = { ...d.part };
  } else if (d.kind === 'text' || d.kind === 'reasoning') {
    const part = message.parts[d.partIndex];
    if (part && (part.type === 'text' || part.type === 'reasoning')) part.text += d.text;
  } else if (d.kind === 'status') {
    message.status = d.status;
  }
}

/** Version de rendu par message : incrémentée à chaque delta pour un rendu ciblé. */
export const messageVersions = reactive(new Map<Id, number>());

function bump(id: Id) {
  messageVersions.set(id, (messageVersions.get(id) ?? 0) + 1);
}

function wireEvents(): void {
  api.on('settings.changed', (s) => (store.settings = s));
  api.on('projects.changed', ({ projects }) => (store.projects = projects));
  api.on('providers.changed', ({ providers }) => (store.providers = providers));
  api.on('conversation.changed', ({ conversation }) => {
    store.conversations.set(conversation.id, conversation);
  });
  api.on('conversation.deleted', ({ id }) => {
    store.conversations.delete(id);
    messageCache.delete(id);
    if (store.activeId === id) store.activeId = null;
  });
  api.on('conversations.reordered', ({ ids }) => {
    ids.forEach((id, i) => {
      const c = store.conversations.get(id);
      if (c) c.sortOrder = i + 1;
    });
  });
  api.on('message.added', ({ message }) => {
    const ref = messageCache.get(message.conversationId);
    if (!ref) return;
    if (ref.value.some((m) => m.id === message.id)) return;
    ref.value = [...ref.value, message];
  });
  api.on('message.updated', ({ message }) => {
    const ref = messageCache.get(message.conversationId);
    if (!ref) return;
    const index = ref.value.findIndex((m) => m.id === message.id);
    if (index === -1) return;
    const next = ref.value.slice();
    next[index] = message;
    ref.value = next;
    bump(message.id);
  });
  api.on('message.delta', ({ conversationId, messageId, deltas }) => {
    const ref = messageCache.get(conversationId);
    const message = ref?.value.find((m) => m.id === messageId);
    if (!message || !ref) return;
    for (const d of deltas) applyDelta(message, d);
    bump(messageId);
    triggerRef(ref);
  });
  api.on('queue.changed', ({ conversationId, items }) => store.queues.set(conversationId, items));
  api.on('templates.changed', ({ templates }) => (store.templates = templates));
  api.on('compaction.added', ({ compaction }) => {
    const list = store.compactions.get(compaction.conversationId) ?? [];
    store.compactions.set(compaction.conversationId, [...list, compaction]);
  });
  api.on('conversation.messagesReset', ({ conversationId }) => {
    if (messageCache.has(conversationId)) void loadMessages(conversationId);
  });
  api.on('log.error', (e) => store.engineErrors.push(e));
  api.on('generation.state', (state) => {
    if (state.status === 'finished') store.generations.delete(state.conversationId);
    else store.generations.set(state.conversationId, state);
    const c = store.conversations.get(state.conversationId);
    if (c) c.generating = state.status !== 'finished';
  });
}

export async function reloadAll(): Promise<void> {
  const [info, settings, projects, providers, presets, conversations, active, templates] = await Promise.all([
    api.call('app.info'),
    api.call('settings.get'),
    api.call('projects.list'),
    api.call('providers.list'),
    api.call('providers.presets'),
    api.call('conversations.list', { includeArchived: true }),
    api.call('chat.active'),
    api.call('templates.list'),
  ]);
  Object.assign(store, { info, settings, projects, providers, presets, templates });
  store.conversations = new Map(conversations.map((c) => [c.id, c]));
  store.generations = new Map(active.map((g) => [g.conversationId, g]));
  if (store.activeId !== null) {
    if (store.conversations.has(store.activeId)) await loadMessages(store.activeId);
    else store.activeId = null;
  }
}

export async function initStore(): Promise<void> {
  wireEvents();
  store.renderer = await host.info();
  await reloadAll();
  // Moteur relancé après un arrêt inattendu : on relit tout depuis la base.
  host.onEngineRestarted(() => void reloadAll());
  store.ready = true;
}

export function providerById(id: Id | null | undefined): Provider | null {
  if (id === null || id === undefined) return null;
  return store.providers.find((p) => p.id === id) ?? null;
}
