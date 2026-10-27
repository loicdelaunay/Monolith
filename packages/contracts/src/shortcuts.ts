import type { AgentMode, ConversationMode, ReasoningLevel } from './model.ts';
import type { ShortcutItem } from './settings.ts';

const REASONING: ReasoningLevel[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];

/** Combinaison normalisée d'un évènement clavier (« Ctrl+Shift+K », « Alt+1 », « F5 »). */
export function comboFromEvent(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
  // Lettres et chiffres d'après la touche physique : indépendant de la disposition et de Maj.
  const physical = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.code && /^Digit\d$/.test(e.code) ? e.code.slice(5) : null;
  const key = physical ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (!/^([A-Z0-9]|F([1-9]|1[0-2]))$/.test(key)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean) as string[];
  return [...mods, key].join('+');
}

/** Une combinaison est utilisable si elle comporte Ctrl, Alt ou Meta (ou est une touche F). */
export function validCombo(keys: string): boolean {
  return /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Z0-9]|F([1-9]|1[0-2]))$/.test(keys) && (/^F\d+$/.test(keys.split('+').at(-1)!) || /(Ctrl|Alt|Meta)\+/.test(keys));
}

/** Combinaisons réservées par les raccourcis intégrés et l'application. */
export const RESERVED_COMBOS = ['Ctrl+Shift+M', 'Ctrl+Shift+R', 'Ctrl+J', 'Ctrl+N', 'Ctrl+K', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y'];

const MODES: { mode: ConversationMode; agentMode: AgentMode | null }[] = [
  { mode: 'chat', agentMode: null },
  { mode: 'agent', agentMode: 'plan' },
  { mode: 'agent', agentMode: 'propose' },
  { mode: 'agent', agentMode: 'execute' },
];

/** Mode suivant : Chat → Plan → Proposition → Exécution → Chat. */
export function nextMode(mode: ConversationMode, agentMode: AgentMode): { mode: ConversationMode; agentMode?: AgentMode } {
  const i = MODES.findIndex((m) => m.mode === mode && (m.mode === 'chat' || m.agentMode === agentMode));
  const next = MODES[(i + 1) % MODES.length]!;
  return next.agentMode ? { mode: next.mode, agentMode: next.agentMode } : { mode: next.mode };
}

/** Niveau de réflexion suivant parmi Auto et les niveaux proposés par le modèle. */
export function nextReasoning(current: ReasoningLevel, levels: ReasoningLevel[]): ReasoningLevel {
  const cycle: ReasoningLevel[] = ['auto', ...levels.filter((l) => l !== 'auto')];
  const i = cycle.indexOf(current);
  return cycle[(i + 1) % cycle.length]!;
}

/** Valide et normalise une liste de raccourcis (doublons et combinaisons invalides retirés). */
export function sanitizeShortcuts(value: unknown): ShortcutItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(RESERVED_COMBOS);
  const out: ShortcutItem[] = [];
  for (const raw of value.slice(0, 30)) {
    const x = (raw ?? {}) as Partial<ShortcutItem>;
    const keys = typeof x.keys === 'string' ? x.keys.trim() : '';
    if (!validCombo(keys) || seen.has(keys)) continue;
    seen.add(keys);
    out.push({
      id: typeof x.id === 'string' && /^[\w-]{1,40}$/.test(x.id) ? x.id : `sc-${out.length + 1}-${keys.replace(/\+/g, '')}`,
      keys,
      label: typeof x.label === 'string' ? x.label.trim().slice(0, 60) : '',
      providerId: typeof x.providerId === 'number' ? x.providerId : null,
      model: typeof x.model === 'string' && x.model.trim() ? x.model.trim().slice(0, 200) : null,
      mode: x.mode === 'chat' || x.mode === 'agent' ? x.mode : null,
      agentMode: x.agentMode === 'plan' || x.agentMode === 'propose' || x.agentMode === 'execute' ? x.agentMode : null,
      reasoningLevel: x.reasoningLevel && REASONING.includes(x.reasoningLevel) ? x.reasoningLevel : null,
    });
  }
  return out;
}

/** Modifications de conversation appliquées par un raccourci (champs non renseignés : inchangés). */
export function shortcutPatch(item: ShortcutItem): { providerId?: number; model?: string; mode?: ConversationMode; agentMode?: AgentMode; reasoningLevel?: ReasoningLevel } {
  return {
    ...(item.providerId !== null && item.model ? { providerId: item.providerId, model: item.model } : {}),
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.agentMode ? { agentMode: item.agentMode, mode: 'agent' as const } : {}),
    ...(item.reasoningLevel ? { reasoningLevel: item.reasoningLevel } : {}),
  };
}
