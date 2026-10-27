import { DEFAULT_SETTINGS, type AgentMode, type ConversationMode, type Settings, type SkillInfo } from '@monolith/contracts';
import type { ToolDefinition } from './types.ts';
import { INSTRUCTION_SKILLS } from './builtin.ts';

export type Host = 'desktop' | 'cli' | 'server';

/** Ce que chaque mode autorise : appliqué par le moteur, à l'exposition ET à l'exécution. */
export function modeAllows(tool: ToolDefinition, mode: ConversationMode, agentMode: AgentMode): { ok: boolean; reason: string } {
  if (mode === 'chat') {
    return ['info', 'questions', 'actions'].includes(tool.skill)
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'Mode Chat : seuls les outils conversationnels (informations, questions, propositions) sont disponibles. Passez en mode Agent.' };
  }
  const allowed: Record<AgentMode, string[]> = {
    plan: ['read', 'interact'],
    propose: ['read', 'interact', 'write'],
    execute: ['read', 'interact', 'write', 'exec', 'network', 'desktop'],
  };
  const bad = tool.effects.find((e) => !allowed[agentMode].includes(e));
  if (!bad) return { ok: true, reason: '' };
  return {
    ok: false,
    reason:
      agentMode === 'plan'
        ? 'Mode Plan : inspection et analyse uniquement, aucune modification ni commande.'
        : 'Mode Proposition : les changements de fichiers sont préparés pour validation ; commandes et accès réseau indisponibles.',
  };
}

/** Capacités déclarées par système : le contrôle du bureau n'existe que sous Windows dans cette version. */
const PLATFORM_REASON =
  process.platform === 'darwin'
    ? 'macOS : non pris en charge dans cette version (Windows uniquement, UI Automation).'
    : process.platform === 'linux'
      ? 'Linux : contrôle du clavier et de la souris non disponible.'
      : 'Système non pris en charge.';

function platformOk(t: ToolDefinition): boolean {
  return !t.platforms || t.platforms.includes(process.platform);
}

/** Registre des outils : intégrés, puis ceux des serveurs MCP (tranche T6). */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(prefix: string): void {
    for (const name of [...this.tools.keys()]) if (name.startsWith(prefix)) this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  skillEnabled(settings: Settings, skill: string): boolean {
    // Un skill apparu dans une version plus récente prend sa valeur par défaut.
    return settings.skills.enabled[skill] ?? DEFAULT_SETTINGS.skills.enabled[skill] ?? false;
  }

  /** Filtre supplémentaire de l'hôte (ex. navigateur absent). */
  hostFilter: (t: ToolDefinition) => boolean = () => true;

  /** Outils exposés au modèle pour cette génération : skill actif, mode compatible, hôte compatible. */
  available(settings: Settings, mode: ConversationMode, agentMode: AgentMode, host: Host, extra: (t: ToolDefinition) => boolean = this.hostFilter): ToolDefinition[] {
    return this.all().filter((t) => [t.skill, ...(t.alsoSkills ?? [])].some((s) => this.skillEnabled(settings, s)) && (!t.hosts || t.hosts.includes(host)) && platformOk(t) && modeAllows(t, mode, agentMode).ok && extra(t));
  }

  skills(settings: Settings, host: Host): SkillInfo[] {
    const bySkill = new Map<string, ToolDefinition[]>();
    for (const t of this.all()) for (const s of [t.skill, ...(t.alsoSkills ?? [])]) bySkill.set(s, [...(bySkill.get(s) ?? []), t]);
    const ids = new Set([...bySkill.keys(), ...Object.keys(INSTRUCTION_SKILLS)]);
    return [...ids].map((id) => {
      const tools = bySkill.get(id) ?? [];
      const hostOk = tools.length === 0 || tools.some((t) => (!t.hosts || t.hosts.includes(host)) && this.hostFilter(t));
      const platform = tools.length === 0 || tools.some(platformOk);
      return {
        id,
        family: tools[0]?.family ?? 'instructions',
        enabled: this.skillEnabled(settings, id),
        tools: tools.map((t) => t.name),
        available: hostOk && platform,
        ...(!platform ? { unavailableReason: PLATFORM_REASON } : hostOk ? {} : { unavailableReason: 'Indisponible sur cet hôte.' }),
      };
    });
  }
}
