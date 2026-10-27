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

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return renderCode(token.content, lang);
};
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
  return `<div class="mh-code" data-lang="${label}"><div class="mh-code-head"><span>${label}</span><button type="button" class="mh-copy" data-copy="1" aria-label="Copier le code"><i class="pi pi-copy"></i></button></div>${body}</div>`;
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

export function renderMarkdown(text: string): string {
  return splitBlocks(text).map(renderBlock).join('');
}
