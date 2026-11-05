import { fileIcon } from './file-icons.ts';
import type { FileReference, Id } from '@monolith/contracts';
import { api } from '../api.ts';
import { i18n } from '../i18n.ts';

const translator = i18n.global as unknown as { t: (key: string) => string };

// ---------- Mermaid (chargé à la demande, niveau de sécurité strict) ----------
type Mermaid = typeof import('mermaid').default;
let mermaid: Promise<Mermaid> | null = null;
let mermaidTheme = '';
const svgCache = new Map<string, string | Error>();
let seq = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import('mermaid').then((m) => m.default);
  return mermaid;
}

/** Remplace les blocs `mermaid` par leur diagramme ; un diagramme invalide reste affiché comme code. */
export async function renderMermaid(root: HTMLElement): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.mh-mermaid:not([data-rendered])')];
  if (!nodes.length) return;
  const m = await loadMermaid();
  const theme = document.documentElement.classList.contains('mh-dark') ? 'dark' : 'default';
  if (theme !== mermaidTheme) {
    mermaidTheme = theme;
    // Mermaid 12 utilise « elk » par défaut ; elkjs n'est pas embarqué (voir stubs/elk.ts) : disposition dagre.
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit', layout: 'dagre' });
  }
  for (const node of nodes) {
    if (!node.isConnected || node.dataset.rendered) continue;
    const source = decodeURIComponent(node.dataset.mermaid ?? '');
    const key = `${theme}\u0000${source}`;
    let result = svgCache.get(key);
    if (result === undefined) {
      try {
        result = (await m.render(`mh-mermaid-${++seq}`, source)).svg;
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
        console.warn('Mermaid : diagramme non rendu —', result.message.slice(0, 300));
      }
      // Les éléments temporaires créés par Mermaid en cas d'erreur sont retirés.
      document.getElementById(`dmh-mermaid-${seq}`)?.remove();
      if (svgCache.size > 200) svgCache.delete(svgCache.keys().next().value!);
      svgCache.set(key, result);
    }
    if (!node.isConnected) continue;
    node.dataset.rendered = '1';
    if (result instanceof Error) {
      node.classList.add('failed');
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'mh-mermaid-svg';
    wrap.innerHTML = result;
    const tools = document.createElement('div');
    tools.className = 'mh-mermaid-tools';
    const button = (data: string, icon: string, label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset[data] = '1';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = `<i class="pi ${icon}"></i>`;
      return b;
    };
    tools.append(button('mermaidZoom', 'pi-search-plus', translator.t('diagram.open')), button('mermaidToggle', 'pi-code', translator.t('diagram.code')));
    wrap.append(tools);
    node.prepend(wrap);
    node.classList.add('rendered');
  }
}

// ---------- Blocs interactifs ----------
/**
 * Code écrit par le modèle, exécuté dans le cadre du protocole dédié (voir main/widget-frame.ts) : origine
 * opaque, sans réseau. Seuls échanges avec le chat : le code envoyé au cadre, sa hauteur et ses erreurs.
 */
const WIDGET_URL = 'monolith-widget://frame/';
const WIDGET_MIN_HEIGHT = 48;
const WIDGET_MAX_HEIGHT = 640;
const widgetFrames = new WeakMap<object, { frame: HTMLIFrameElement; html: string; error: HTMLElement }>();

/**
 * Thème de l'application et style de départ. Couche `mh` entre le reset de Tailwind (base) et ses classes
 * (utilities) : elle survit au reset, cède aux classes et à tout CSS écrit par le bloc.
 */
function widgetStyle(): string {
  const root = getComputedStyle(document.documentElement);
  const vars = ['--mh-text', '--mh-muted', '--mh-border', '--mh-surface', '--mh-hover', '--mh-accent', '--mh-accent-text', '--mh-radius', '--mh-radius-sm'].map((name) => `${name}:${root.getPropertyValue(name).trim()}`);
  return `@layer theme,base,mh,components,utilities;:root{${vars.join(';')};--mh-font:${getComputedStyle(document.body).fontFamily};color-scheme:${root.colorScheme}}@layer mh{html{background:transparent}body{margin:0;padding:12px;color:var(--mh-text);font:14px/1.5 var(--mh-font)}}`;
}

window.addEventListener('message', (e) => {
  const target = e.source ? widgetFrames.get(e.source) : undefined;
  const data = e.data as { mhWidget?: unknown; value?: unknown } | null;
  if (!target || !data) return;
  if (data.mhWidget === 'ready') (e.source as Window).postMessage({ mhWidget: 'render', html: target.html, style: widgetStyle(), dark: getComputedStyle(document.documentElement).colorScheme === 'dark' }, '*');
  else if (data.mhWidget === 'height' && typeof data.value === 'number' && Number.isFinite(data.value)) target.frame.style.height = `${Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, data.value))}px`;
  else if (data.mhWidget === 'error' && typeof data.value === 'string') {
    target.error.textContent = data.value.slice(0, 500);
    target.error.hidden = false;
  }
});

function mountWidget(box: HTMLElement, html: string, label: string): void {
  const error = box.querySelector<HTMLElement>('.mh-widget-error')!;
  error.hidden = true;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = label;
  frame.src = WIDGET_URL;
  frame.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
  error.before(frame);
  widgetFrames.set(frame.contentWindow!, { frame, html, error });
}

/** Remplace les blocs `widget` complets par leur cadre isolé ; un bloc non fermé reste affiché comme code. */
export function renderWidgets(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>('.mh-widget[data-widget]:not([data-rendered])')) {
    node.dataset.rendered = '1';
    const label = node.dataset.title || translator.t('render.widget');
    const box = document.createElement('div');
    box.className = 'mh-widget-box';
    const head = document.createElement('div');
    head.className = 'mh-widget-head';
    const icon = document.createElement('i');
    icon.className = 'pi pi-bolt';
    const title = document.createElement('span');
    title.textContent = label;
    const button = (data: string, iconName: string, text: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset[data] = '1';
      b.title = text;
      b.setAttribute('aria-label', text);
      b.innerHTML = `<i class="pi ${iconName}"></i>`;
      return b;
    };
    head.append(icon, title, button('widgetReload', 'pi-refresh', translator.t('render.widgetReload')), button('widgetToggle', 'pi-code', translator.t('render.widgetCode')));
    const error = document.createElement('div');
    error.className = 'mh-widget-error';
    error.setAttribute('role', 'alert');
    box.append(head, error);
    node.prepend(box);
    node.classList.add('rendered');
    mountWidget(box, node.dataset.widget ?? '', label);
  }
}

/** Relance un bloc : nouveau cadre, état remis à zéro. */
export function reloadWidget(from: HTMLElement): void {
  const node = from.closest<HTMLElement>('.mh-widget');
  const box = node?.querySelector<HTMLElement>('.mh-widget-box');
  if (!node || !box) return;
  box.querySelector('iframe')?.remove();
  mountWidget(box, node.dataset.widget ?? '', node.dataset.title || translator.t('render.widget'));
}

// ---------- Badges de fichiers vérifiés ----------
const refCache = new Map<string, { ref: FileReference; at: number }>();
const MISSING_TTL = 10_000;

export async function decorateFileBadges(root: HTMLElement, conversationId: Id): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('code.mh-path:not([data-checked])')];
  if (!nodes.length) return;
  const key = (input: string) => `${conversationId}\u0000${input}`;
  const fresh = (input: string) => {
    const c = refCache.get(key(input));
    return c && (c.ref.exists || Date.now() - c.at < MISSING_TTL) ? c.ref : null;
  };
  const unknown = [...new Set(nodes.map((n) => n.dataset.path ?? '').filter((p) => p && !fresh(p)))];
  if (unknown.length) {
    const refs = await api.call('files.stat', { conversationId, references: unknown }).catch(() => [] as FileReference[]);
    for (const r of refs) refCache.set(key(r.input), { ref: r, at: Date.now() });
  }
  for (const node of nodes) {
    if (!node.isConnected) continue;
    node.dataset.checked = '1';
    const ref = fresh(node.dataset.path ?? '');
    if (!ref?.exists || !ref.path) continue;
    node.classList.add('mh-file-badge');
    node.dataset.file = ref.path;
    node.dataset.type = ref.type ?? 'file';
    if (ref.line) node.dataset.line = String(ref.line);
    if (ref.endLine) node.dataset.endLine = String(ref.endLine);
    node.title = ref.display ?? ref.path;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    const kind = fileIcon(ref.path, ref.type ?? 'file');
    const icon = document.createElement('i');
    icon.className = `pi ${kind.icon}`;
    icon.style.color = kind.color;
    icon.setAttribute('aria-hidden', 'true');
    node.prepend(icon);
  }
}
