import { fileIcon } from './file-icons.ts';
import type { FileReference, Id } from '@monolith/contracts';
import { api } from '../api.ts';

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
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' });
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
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mh-mermaid-toggle';
    toggle.dataset.mermaidToggle = '1';
    toggle.setAttribute('aria-label', 'Code');
    toggle.innerHTML = '<i class="pi pi-code"></i>';
    wrap.append(toggle);
    node.prepend(wrap);
    node.classList.add('rendered');
  }
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
