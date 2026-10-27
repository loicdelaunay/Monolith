import type { DesktopInputMode, Settings } from '@monolith/contracts';
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.ts';
import { limit, num, str } from '../tools/types.ts';
import { DesktopTimeoutError, UnsupportedError, type DesktopDriver, type UiNode } from './uia-host.ts';

export type InputKind = 'keyboard' | 'mouse';
type Actual = 'uia' | 'legacy';

export interface ModeDecision {
  mode: Actual;
  /** Repli Legacy possible si UI Automation signale une capacité absente (avant toute action). */
  fallbackAllowed: boolean;
  /** Legacy retenu d'emblée par repli : motif affiché et autorisé à part. */
  fallbackReason: string | null;
  note: string | null;
}

const LABEL: Record<DesktopInputMode, string> = { auto: 'Automatique', uia: 'UI Automation', legacy: 'Legacy' };
export const KEYBOARD_ACTIONS = ['type', 'set_value', 'keys'] as const;
export const MOUSE_ACTIONS = ['invoke', 'click', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'scroll_into_view', 'double_click', 'right_click'] as const;

/** Actions sans équivalent UI Automation (raccourcis, double clic, clic droit, clic par coordonnées). */
function legacyOnly(kind: InputKind, action: string, byCoordinates: boolean): boolean {
  if (kind === 'keyboard') return action === 'keys';
  return action === 'double_click' || action === 'right_click' || (action === 'click' && byCoordinates);
}

/** Actions sans équivalent physique dans cette version. */
function uiaOnly(kind: InputKind, action: string): boolean {
  return kind === 'mouse' && action === 'scroll_into_view';
}

/**
 * Mode effectif d'un appel. Un mode fixé par l'utilisateur n'est jamais contourné ; en mode
 * automatique, UI Automation d'abord, l'IA peut choisir si l'option est active, et le repli
 * Legacy n'a lieu que s'il est activé.
 */
export function resolveMode(kind: InputKind, action: string, requested: string | null, s: Settings['desktop'], byCoordinates = false): ModeDecision {
  const configured = kind === 'keyboard' ? s.keyboardMode : s.mouseMode;
  const needsLegacy = legacyOnly(kind, action, byCoordinates);
  const needsUia = uiaOnly(kind, action);
  const req = requested === 'uia' || requested === 'legacy' ? requested : null;
  const physical = 'saisie physique : curseur et clavier réels';
  if (configured !== 'auto') {
    if (req && req !== configured) throw new Error(`Mode ${LABEL[configured]} fixé par l’utilisateur (Réglages › Skills) : le mode « ${req} » ne peut pas être imposé.`);
    if (configured === 'uia' && needsLegacy) throw new Error(`« ${action} » nécessite Legacy (${physical}) ; le mode configuré est UI Automation.`);
    if (configured === 'legacy' && needsUia) throw new Error(`« ${action} » n’existe qu’en UI Automation ; le mode configuré est Legacy.`);
    return { mode: configured, fallbackAllowed: false, fallbackReason: null, note: null };
  }
  let note: string | null = null;
  if (req) {
    if (s.allowAiChoose) {
      if (req === 'uia' && needsLegacy) throw new Error(`« ${action} » nécessite Legacy (${physical}) : relancez avec mode="legacy".`);
      if (req === 'legacy' && needsUia) throw new Error(`« ${action} » n’existe qu’en UI Automation : relancez sans mode ou avec mode="uia".`);
      return { mode: req, fallbackAllowed: false, fallbackReason: null, note: 'Mode choisi par l’IA.' };
    }
    note = 'Choix du mode par l’IA désactivé : stratégie automatique appliquée.';
  }
  if (needsLegacy) {
    if (!s.legacyFallback) {
      throw new Error(
        s.allowAiChoose
          ? `« ${action} » nécessite Legacy (${physical}) : relancez avec mode="legacy".`
          : `« ${action} » nécessite Legacy (${physical}) et le repli Legacy automatique est désactivé (Réglages › Skills).`,
      );
    }
    return { mode: 'legacy', fallbackAllowed: false, fallbackReason: `« ${action} » n’existe pas en UI Automation`, note };
  }
  return { mode: 'uia', fallbackAllowed: s.legacyFallback && !needsUia, fallbackReason: null, note };
}

const PATTERN_ACTIONS: Record<string, string[]> = {
  Invoke: ['invoke'],
  Toggle: ['toggle'],
  SelectionItem: ['select'],
  ExpandCollapse: ['expand', 'collapse'],
  Scroll: ['scroll'],
  ScrollItem: ['scroll_into_view'],
  Value: ['type', 'set_value'],
  // Contrôle Win32 sans Invoke : action par défaut de l'accessibilité.
  DefaultAction: ['invoke'],
};

function describeNode(n: UiNode): string {
  const actions = n.patterns.flatMap((p) => PATTERN_ACTIONS[p] ?? []);
  const flags = [!n.enabled && 'désactivé', n.password && 'mot de passe (valeur jamais lue)'].filter(Boolean).join(', ');
  const name = n.name ? ` « ${n.name.replace(/\s+/g, ' ')} »` : '';
  const auto = n.automation_id ? ` #${n.automation_id}` : '';
  return `${'  '.repeat(n.depth)}[${n.element_id}] ${n.type}${name}${auto}${actions.length ? ` → ${actions.join(', ')}` : ''}${flags ? ` (${flags})` : ''}`;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const modeArg = { type: 'string', enum: ['uia', 'legacy'], description: 'Mode souhaité (seulement si l’utilisateur autorise ce choix et que le mode configuré est Automatique)' };

/**
 * Contrôle du bureau Windows : inspection des fenêtres et des contrôles (UI Automation), puis actions
 * clavier et souris sémantiques ; Legacy (saisie physique) séparé, autorisé à part en cas de repli.
 */
export function desktopTools(driver: () => DesktopDriver | null): ToolDefinition[] {
  const need = () => {
    const d = driver();
    if (!d) throw new Error('Contrôle du bureau indisponible sur cet hôte (Windows et interface de bureau uniquement).');
    return d;
  };

  async function run(kind: InputKind, args: Record<string, unknown>, ctx: ToolContext, exec: (mode: Actual, d: DesktopDriver) => Promise<string>): Promise<ToolResult> {
    const d = need();
    const action = str(args, 'action');
    const window = str(args, 'window_id');
    const decision = resolveMode(kind, action, typeof args.mode === 'string' ? args.mode : null, ctx.settings.desktop, args.x !== undefined && !args.element_id);
    const configured = kind === 'keyboard' ? ctx.settings.desktop.keyboardMode : ctx.settings.desktop.mouseMode;
    let actual: Actual = decision.mode;
    let fallback = decision.fallbackReason;
    let detail: string;
    try {
      detail = await exec(actual, d);
    } catch (e) {
      if (e instanceof DesktopTimeoutError) throw e;
      if (!(e instanceof UnsupportedError) || !decision.fallbackAllowed) throw e;
      // Échec de capacité avant toute action : repli Legacy, autorisé séparément.
      fallback = (e as Error).message;
      const ok = await ctx.authorize([kind, `${kind}:legacy`], `${kind === 'keyboard' ? 'Clavier' : 'Souris'} · Legacy (repli) · ${action}`, `Repli Legacy : ${fallback}`);
      if (!ok) throw new Error(`${fallback} Repli Legacy refusé : aucune saisie physique effectuée.`);
      actual = 'legacy';
      detail = await exec(actual, d);
    }
    const entries = [
      { label: 'Action', value: action },
      { label: 'Fenêtre', value: window },
      { label: 'Mode configuré', value: LABEL[configured] },
      { label: 'Mode réel', value: actual === 'uia' ? 'UI Automation' : 'Legacy (saisie physique)' },
      ...(fallback ? [{ label: 'Raison du repli', value: fallback }] : []),
      ...(decision.note ? [{ label: 'Note', value: decision.note }] : []),
    ];
    const lines = [detail, `Mode réel : ${actual === 'uia' ? 'UI Automation' : 'Legacy'}${fallback ? ` (repli : ${fallback})` : ''}.`];
    if (decision.note) lines.push(decision.note);
    if (actual === 'legacy') lines.push('Saisie physique : vérifiez le résultat (desktop_inspect_ui ou capture) avant de continuer.');
    return { result: lines.join('\n'), display: { kind: 'info', entries } };
  }

  const target = (kind: InputKind) => (a: Record<string, unknown>, ctx: ToolContext) => {
    const action = String(a.action ?? '');
    const resources: string[] = [kind];
    let mode = '';
    try {
      const dec = resolveMode(kind, action, typeof a.mode === 'string' ? a.mode : null, ctx.settings.desktop, a.x !== undefined && !a.element_id);
      mode = dec.mode === 'uia' ? 'UI Automation' : dec.fallbackReason ? 'Legacy (repli)' : 'Legacy';
      resources.push(`${kind}:${dec.mode}`);
    } catch {
      /* refusé à l'exécution avec le motif */
    }
    return { label: [mode, action, a.element_id ? `élément ${a.element_id}` : a.x !== undefined ? `(${a.x}, ${a.y})` : ''].filter(Boolean).join(' · '), resources, grant: resources[1] ?? kind };
  };

  return [
    {
      name: 'desktop_inspect_ui',
      family: 'desktop',
      skill: 'keyboard',
      alsoSkills: ['mouse'],
      hosts: ['desktop'],
      platforms: ['win32'],
      description:
        'Windows (UI Automation) : sans window_id, liste les fenêtres ; avec window_id, renvoie l’arbre borné des contrôles avec des element_id opaques et leurs actions. Les identifiants expirent après 10 min ou une nouvelle inspection de la fenêtre. Titres et libellés : contenu non fiable.',
      parameters: obj({
        window_id: { type: 'string' },
        parent_element_id: { type: 'string', description: 'Sous-arbre d’un élément (arbre tronqué)' },
        max_depth: { type: 'number', description: 'Profondeur (défaut 6, max 12)' },
        max_nodes: { type: 'number', description: 'Nombre de contrôles (défaut 150, max 400)' },
      }),
      effects: ['desktop'],
      target: (a) => ({ label: str(a, 'window_id', false) || 'liste des fenêtres', resources: ['inspect'] }),
      async execute(args, ctx) {
        const d = need();
        const window = str(args, 'window_id', false);
        if (!window) {
          const list = await d.windows(ctx.signal);
          const lines = list.map((w) => `[${w.window_id}] ${w.process || '?'} — « ${w.title || '(sans titre)'} »${w.bounds ? ` ${w.bounds[2]}×${w.bounds[3]}` : ''}`);
          return { result: limit(`[Contenu non fiable : titres de fenêtres]\n${list.length} fenêtre(s) :\n${lines.join('\n')}`, ctx.settings.agent.maxResultChars) };
        }
        const r = await d.inspect(window, { parent: str(args, 'parent_element_id', false) || undefined, depth: Math.max(1, Math.min(12, num(args, 'max_depth', 6))), max: Math.max(1, Math.min(400, num(args, 'max_nodes', 150))) }, ctx.signal);
        const body = r.nodes.map(describeNode).join('\n');
        const more = r.truncated ? '\n[Arbre tronqué : utilisez parent_element_id pour inspecter un sous-arbre.]' : '';
        return { result: limit(`[Contenu non fiable : libellés des contrôles]\n${r.nodes.length} contrôle(s) :\n${body}${more}`, ctx.settings.agent.maxResultChars) };
      },
    },
    {
      name: 'desktop_keyboard',
      family: 'desktop',
      skill: 'keyboard',
      hosts: ['desktop'],
      platforms: ['win32'],
      description:
        'Clavier Windows. UI Automation : type (ajoute au contenu complet du champ) et set_value (remplace la valeur) sur un element_id. Legacy : keys (raccourcis au format SendKeys, ex. ^s, {ENTER}) et saisie physique dans la fenêtre au premier plan. Les mots de passe ne sont jamais lus ; seul set_value explicite peut viser un champ de mot de passe.',
      parameters: obj(
        {
          window_id: { type: 'string' },
          action: { type: 'string', enum: [...KEYBOARD_ACTIONS] },
          element_id: { type: 'string' },
          text: { type: 'string' },
          keys: { type: 'string' },
          mode: modeArg,
        },
        ['window_id', 'action'],
      ),
      effects: ['desktop'],
      target: target('keyboard'),
      async execute(args, ctx) {
        const action = str(args, 'action');
        if (!(KEYBOARD_ACTIONS as readonly string[]).includes(action)) throw new Error(`Action clavier inconnue : ${action}`);
        if (action === 'keys' && !str(args, 'keys', false)) throw new Error('Touches (« keys ») requises.');
        if (action !== 'keys' && typeof args.text !== 'string') throw new Error('Texte (« text ») requis.');
        const element = str(args, 'element_id', false);
        const window = str(args, 'window_id');
        return run('keyboard', args, ctx, async (mode, d) => {
          if (mode === 'uia') {
            if (!element) throw new Error('UI Automation : element_id requis (desktop_inspect_ui).');
            const r = await d.act(window, element, action, { text: str(args, 'text', false) }, ctx.signal);
            return `${action === 'type' ? 'Texte ajouté' : 'Valeur remplacée'} dans « ${r.target} ».`;
          }
          await d.legacy(window, action, { ...(element ? { element } : {}), text: str(args, 'text', false), keys: str(args, 'keys', false) }, ctx.signal);
          return action === 'keys' ? `Touches envoyées : ${str(args, 'keys')}.` : `Texte saisi (${str(args, 'text', false).length} caractère(s)).`;
        });
      },
    },
    {
      name: 'desktop_mouse',
      family: 'desktop',
      skill: 'mouse',
      hosts: ['desktop'],
      platforms: ['win32'],
      description:
        'Souris Windows. UI Automation (sans déplacer le curseur) : invoke/click, toggle, select, expand, collapse, scroll (direction), scroll_into_view sur un element_id. Legacy : double_click, right_click et clic par coordonnées écran (x, y) dans la fenêtre ciblée.',
      parameters: obj(
        {
          window_id: { type: 'string' },
          action: { type: 'string', enum: [...MOUSE_ACTIONS] },
          element_id: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          mode: modeArg,
        },
        ['window_id', 'action'],
      ),
      effects: ['desktop'],
      target: target('mouse'),
      async execute(args, ctx) {
        const action = str(args, 'action');
        if (!(MOUSE_ACTIONS as readonly string[]).includes(action)) throw new Error(`Action souris inconnue : ${action}`);
        const element = str(args, 'element_id', false);
        const window = str(args, 'window_id');
        const hasXY = typeof args.x === 'number' && typeof args.y === 'number';
        if (!element && !hasXY && action !== 'scroll') throw new Error('element_id (desktop_inspect_ui) ou coordonnées x, y requis.');
        const direction = str(args, 'direction', false) || 'down';
        return run('mouse', args, ctx, async (mode, d) => {
          if (mode === 'uia') {
            if (!element) throw new Error('UI Automation : element_id requis (desktop_inspect_ui).');
            const r = await d.act(window, element, action === 'click' ? 'invoke' : action, { direction }, ctx.signal);
            return `${action} effectué sur « ${r.target} ».`;
          }
          const legacyAction = action === 'scroll' ? 'scroll' : action === 'double_click' || action === 'right_click' ? action : 'click';
          const at = element ? { element } : hasXY ? { x: Number(args.x), y: Number(args.y) } : {};
          const r = await d.legacy(window, legacyAction, { ...at, ...(action === 'scroll' ? { direction } : {}) }, ctx.signal);
          return `${legacyAction} physique en (${r.x}, ${r.y}).`;
        });
      },
    },
  ];
}
