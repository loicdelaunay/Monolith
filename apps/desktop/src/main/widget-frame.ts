import tailwind from '@tailwindcss/browser?raw';
// Chart.js n'exporte pas son fichier UMD, le seul utilisable sans module dans le cadre.
import chartjs from '../../../../node_modules/chart.js/dist/chart.umd.min.js?raw';

/**
 * Cadre des blocs interactifs du chat. Leur code vient du modèle : c'est une donnée non fiable, exécutée
 * ici dans un document à part, servi par un protocole dédié parce qu'un `srcdoc` hériterait de la politique
 * de l'interface (scripts en ligne refusés). Origine opaque (sandbox sans allow-same-origin) : aucun accès
 * à l'application ; politique sans réseau : rien ne sort du cadre et aucune ressource externe n'entre.
 * Tailwind et Chart.js, embarqués dans l'application, sont les seuls scripts que le cadre peut charger.
 */
export const WIDGET_SCHEME = 'monolith-widget';

export const WIDGET_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${WIDGET_SCHEME}:`,
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts allow-forms',
].join('; ');

const LIBRARIES: Record<string, string> = { '/lib/tailwind.js': tailwind, '/lib/chart.js': chartjs };

/** Variante `dark:` calée sur le thème de l'application, couleurs du thème en classes (text-mh-text…). */
const TAILWIND_CONFIG = `@custom-variant dark (&:where(.dark, .dark *));
@theme {
  --color-mh-text: var(--mh-text);
  --color-mh-muted: var(--mh-muted);
  --color-mh-border: var(--mh-border);
  --color-mh-surface: var(--mh-surface);
  --color-mh-hover: var(--mh-hover);
  --color-mh-accent: var(--mh-accent);
  --color-mh-accent-text: var(--mh-accent-text);
}`;

/** Graphiques lisibles sur le thème de l'application sans réglage dans chaque bloc. */
const CHART_DEFAULTS = `(function () {
  var css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--mh-muted').trim();
  Chart.defaults.borderColor = css.getPropertyValue('--mh-border').trim();
  Chart.defaults.font.family = css.getPropertyValue('--mh-font').trim();
})();`;

/**
 * Le code du bloc arrive par message de la fenêtre parente : le processus principal ne garde rien.
 * document.open() efface les écouteurs de la fenêtre, d'où leur pose juste après. Le stockage web,
 * interdit à une origine opaque, est remplacé par une mémoire volatile pour ne pas casser le bloc.
 * Un formulaire validé reste sur place : son événement arrive au bloc, mais l'envoi remplacerait le
 * cadre par une page d'erreur. Les bibliothèques ne sont chargées que si le bloc peut s'en servir : le
 * reset de Tailwind laisse ainsi intact un bloc sans classe, et un bloc simple reste léger.
 */
const SHELL = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(function () {
  var post = function (type, value) { parent.postMessage({ mhWidget: type, value: value }, '*'); };
  var volatileStorage = function () {
    var items = new Map();
    return {
      get length() { return items.size; },
      key: function (i) { return Array.from(items.keys())[i] ?? null; },
      getItem: function (k) { k = String(k); return items.has(k) ? items.get(k) : null; },
      setItem: function (k, v) { items.set(String(k), String(v)); },
      removeItem: function (k) { items.delete(String(k)); },
      clear: function () { items.clear(); },
    };
  };
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    Object.defineProperty(window, name, { value: volatileStorage(), configurable: true });
  });
  addEventListener('message', function render(event) {
    if (event.source !== parent || !event.data || event.data.mhWidget !== 'render') return;
    removeEventListener('message', render);
    document.open();
    addEventListener('error', function (e) { post('error', String(e.message) + (e.lineno ? ' (' + e.lineno + ')' : '')); });
    addEventListener('unhandledrejection', function (e) { post('error', String(e.reason)); });
    addEventListener('submit', function (e) { e.preventDefault(); });
    var end = '<' + '/script>';
    var library = function (name) { return '<script src="${WIDGET_SCHEME}://frame/lib/' + name + '.js">' + end; };
    var html = String(event.data.html);
    var head = '<!doctype html><html class="' + (event.data.dark ? 'dark' : 'light') + '"><meta charset="utf-8"><style>' + event.data.style + '</style>';
    if (/class/i.test(html)) head += '<style type="text/tailwindcss">' + ${JSON.stringify(TAILWIND_CONFIG)} + '</style>' + library('tailwind');
    if (/\\bChart\\b/.test(html)) head += library('chart') + '<script>' + ${JSON.stringify(CHART_DEFAULTS)} + end;
    document.write(head + html);
    document.close();
    var measure = function () {
      var body = document.body ? document.body.scrollHeight : 0;
      post('height', Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body)));
    };
    var observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    addEventListener('load', measure);
    measure();
  });
  post('ready');
})();
</script></body></html>`;

/** Réponse du protocole : le cadre vide et sa politique, les bibliothèques embarquées, rien d'autre. */
export function widgetResponse(url: string): Response {
  const { hostname, pathname } = new URL(url);
  const library = hostname === 'frame' ? LIBRARIES[pathname] : undefined;
  if (library) return new Response(library, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  if (hostname !== 'frame' || pathname !== '/') return new Response(null, { status: 404 });
  return new Response(SHELL, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': WIDGET_POLICY,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
}
