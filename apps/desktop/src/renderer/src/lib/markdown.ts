import MarkdownIt from 'markdown-it';
import { ref } from 'vue';
import type { HighlighterCore } from 'shiki/core';

/**
 * Rendu Markdown incrémental : le texte est découpé en blocs de premier niveau ; chaque bloc
 * terminé est rendu une seule fois (cache), seul le dernier bloc est recalculé pendant le streaming.
 * HTML brut désactivé : le contenu du modèle est une donnée non fiable.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

// Liens : jamais ouverts dans la fenêtre ; l'interface intercepte le clic (http/https uniquement).
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('rel', 'noopener noreferrer');
  tokens[idx]!.attrSet('data-external', '1');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** Options de rendu enrichi (réglages « Rendu enrichi »). */
export const renderOptions = { latex: true, mermaid: true, htmlPreview: true, fileBadges: true };

export function setRenderOptions(next: typeof renderOptions): void {
  if (Object.entries(next).every(([k, v]) => renderOptions[k as keyof typeof renderOptions] === v)) return;
  Object.assign(renderOptions, next);
  clearCache();
  highlightVersion.value++;
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // Diagramme : le code reste dans la page (repli) ; MarkdownView le remplace par le SVG rendu.
  if (lang === 'mermaid' && renderOptions.mermaid) return `<div class="mh-mermaid" data-mermaid="${encodeURIComponent(token.content)}">${renderCode(token.content, lang)}</div>`;
  return renderCode(token.content, lang);
};

// ---------- Chemins cités : candidats aux badges de fichiers (vérifiés ensuite sur le disque) ----------
const defaultCodeInline = md.renderer.rules.code_inline!;
const PATHLIKE = /^(?![a-z][\w+.-]*:\/\/)(?!-)[^\s<>|"*?`]{2,300}$/i;
export function looksLikePath(s: string): boolean {
  if (!PATHLIKE.test(s)) return false;
  if (/[\\/]/.test(s)) return /[\w.-]/.test(s.replace(/[\\/]/g, ''));
  return /^[\w.-]+\.[a-z0-9]{1,8}(:\d+(:\d+)?|#L\d+)?$/i.test(s) && !/^\d+(\.\d+)+$/.test(s);
}
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const content = tokens[idx]!.content;
  if (renderOptions.fileBadges && looksLikePath(content)) return `<code class="mh-path" data-path="${escapeHtml(content)}">${escapeHtml(content)}</code>`;
  return defaultCodeInline(tokens, idx, options, env, self);
};

// ---------- Formules LaTeX (KaTeX chargé à la demande) ----------
type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let katexLoading: Promise<void> | null = null;
function loadKatex(): void {
  katexLoading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([k]) => {
      katex = k.default;
      clearCache();
      highlightVersion.value++;
    })
    .catch(() => undefined);
}
function renderMath(tex: string, display: boolean): string {
  if (!katex) {
    loadKatex();
    return display ? `<div class="mh-math-pending"><code>${escapeHtml(tex)}</code></div>` : `<code>${escapeHtml(tex)}</code>`;
  }
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', trust: false, strict: 'ignore', maxSize: 50, maxExpand: 500 });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  if (!renderOptions.latex) return false;
  const src = state.src;
  const pos = state.pos;
  let open: string;
  let close: string;
  if (src.startsWith('\\(', pos)) [open, close] = ['\\(', '\\)'];
  else if (src[pos] === '$' && src[pos + 1] !== '$') [open, close] = ['$', '$'];
  else return false;
  const start = pos + open.length;
  if (open === '$' && (!src[start] || /\s/.test(src[start]!))) return false;
  let end = src.indexOf(close, start);
  while (end !== -1 && open === '$' && src[end - 1] === '\\') end = src.indexOf(close, end + 1);
  if (end === -1 || end === start) return false;
  // « 5 $ et 10 $ » ne sont pas des formules : pas d'espace avant le « $ » fermant ni de chiffre après.
  if (open === '$' && (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? ''))) return false;
  if (!silent) state.push('math_inline', 'math', 0).content = src.slice(start, end);
  state.pos = end + close.length;
  return true;
});

md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  if (!renderOptions.latex) return false;
  const first = state.src.slice(state.bMarks[startLine]! + state.tShift[startLine]!, state.eMarks[startLine]).trim();
  const close = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\]' : null;
  if (!close) return false;
  if (silent) return true;
  let content = first.slice(2);
  let line = startLine;
  let found = content.trimEnd().endsWith(close);
  if (found) content = content.trimEnd().slice(0, -close.length);
  while (!found && ++line < endLine) {
    const l = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]).trimEnd();
    if (l.endsWith(close)) {
      content += `\n${l.slice(0, -close.length)}`;
      found = true;
    } else content += `\n${l}`;
  }
  state.line = Math.min(line, endLine) + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, state.line];
  return true;
});
md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx]!.content, false);
md.renderer.rules.math_block = (tokens, idx) => `<div class="mh-math">${renderMath(tokens[idx]!.content, true)}</div>`;
md.renderer.rules.code_block = (tokens, idx) => renderCode(tokens[idx]!.content, '');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Incrémenté quand une grammaire de coloration devient disponible : invalide le cache. */
export const highlightVersion = ref(0);
let highlighter: HighlighterCore | null = null;
let highlighterLoading: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const loadingLangs = new Set<string>();
const unknownLangs = new Set<string>();
let darkCode = false;

export function setCodeTheme(dark: boolean): void {
  if (darkCode === dark) return;
  darkCode = dark;
  clearCache();
  highlightVersion.value++;
}

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterLoading ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark-default.mjs'),
    ]);
    highlighter = await createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
    return highlighter;
  })();
  return highlighterLoading;
}

const ALIASES: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', ps1: 'powershell', ps: 'powershell', yml: 'yaml', md: 'markdown', 'c++': 'cpp', cs: 'csharp', rs: 'rust', kt: 'kotlin', rb: 'ruby', vue: 'vue', html: 'html', jsonc: 'jsonc' };

async function ensureLang(lang: string): Promise<void> {
  if (loadedLangs.has(lang) || loadingLangs.has(lang) || unknownLangs.has(lang)) return;
  loadingLangs.add(lang);
  try {
    const [{ bundledLanguages }, h] = await Promise.all([import('shiki/langs'), getHighlighter()]);
    const loader = (bundledLanguages as Record<string, unknown>)[lang] as (() => Promise<{ default: unknown }>) | undefined;
    if (!loader) {
      unknownLangs.add(lang);
      return;
    }
    await h.loadLanguage((await loader()).default as never);
    loadedLangs.add(lang);
    clearCache();
    highlightVersion.value++;
  } catch {
    unknownLangs.add(lang);
  } finally {
    loadingLangs.delete(lang);
  }
}

export function normalizeLang(lang: string): string {
  return ALIASES[lang] ?? lang;
}

function renderCode(code: string, rawLang: string): string {
  const lang = normalizeLang(rawLang);
  const label = escapeHtml(rawLang || 'texte');
  let body: string | null = null;
  if (lang && highlighter && loadedLangs.has(lang)) {
    try {
      body = highlighter.codeToHtml(code.replace(/\n$/, ''), { lang, theme: darkCode ? 'github-dark-default' : 'github-light' });
    } catch {
      body = null;
    }
  } else if (lang && lang !== 'text' && lang !== 'plaintext') {
    void ensureLang(lang);
  }
  if (!body) body = `<pre class="shiki"><code>${escapeHtml(code.replace(/\n$/, '')).replace(/^/gm, '<span class="line">').replace(/$/gm, '</span>')}</code></pre>`;
  const previewable = renderOptions.htmlPreview && (lang === 'html' || lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/.test(code)));
  const preview = previewable ? `<button type="button" class="mh-copy" data-preview="${lang === 'html' ? 'html' : 'svg'}" aria-label="Aperçu"><i class="pi pi-eye"></i></button>` : '';
  return `<div class="mh-code" data-lang="${label}"><div class="mh-code-head"><span>${label}</span>${preview}<button type="button" class="mh-copy" data-copy="1" aria-label="Copier le code"><i class="pi pi-copy"></i></button></div>${body}</div>`;
}

const cache = new Map<string, string>();
function clearCache() {
  cache.clear();
}

export function renderBlock(block: string): string {
  let html = cache.get(block);
  if (html === undefined) {
    html = md.render(block);
    if (cache.size > 800) cache.delete(cache.keys().next().value!);
    cache.set(block, html);
  }
  return html;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])\s/;

/** Découpe en blocs de premier niveau sans couper un bloc de code, une liste ou une continuation indentée. */
export function splitBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const push = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      current.push(line);
      if (f && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      push();
      continue;
    }
    if (current.length === 0 && blocks.length > 0) {
      const prev = blocks[blocks.length - 1]!;
      const prevIsList = LIST.test(prev.split('\n')[0]!);
      // Continuation indentée ou élément suivant d'une liste aérée : rattaché au bloc précédent.
      if (/^\s{2,}\S/.test(line) || (prevIsList && LIST.test(line))) {
        current = [blocks.pop()!, ''];
      }
    }
    current.push(line);
  }
  push();
  return blocks;
}

/** Bloc de code Markdown sûr : la clôture est plus longue que toute suite d'accents graves du texte. */
export function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang.replace(/[^\w+#-]/g, '')}\n${text}\n${fence}`;
}

export function renderMarkdown(text: string): string {
  return splitBlocks(text).map(renderBlock).join('');
}
