import { describe, expect, it } from 'vitest';
import { renderOptions, renderBlock, setRenderOptions, splitBlocks } from '../src/renderer/src/lib/markdown.ts';
import { WIDGET_POLICY, widgetResponse } from '../src/main/widget-frame.ts';

const source = '<button id="b">+1</button>\n<script>let n = "</div>";</script>';

describe('politique du cadre des blocs interactifs', () => {
  it('aucun réseau et aucun accès à l’application', () => {
    const directives = new Map(WIDGET_POLICY.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]));
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.has('connect-src')).toBe(false);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    // Aucune source distante : seules les données en ligne sont acceptées.
    expect(WIDGET_POLICY).not.toMatch(/https?:|\*|'self'/);
    expect(directives.get('script-src')).toEqual(["'unsafe-inline'", "'unsafe-eval'", 'monolith-widget:']);
    expect(directives.get('sandbox')).toEqual(['allow-scripts', 'allow-forms']);
  });

  it('le protocole sert le cadre vide avec cette politique, et rien d’autre', async () => {
    const ok = widgetResponse('monolith-widget://frame/');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toBe(WIDGET_POLICY);
    expect(await ok.text()).toContain("post('ready')");
    expect(widgetResponse('monolith-widget://frame/autre').status).toBe(404);
    expect(widgetResponse('monolith-widget://ailleurs/').status).toBe(404);
  });

  it('Tailwind et Chart.js sont servis depuis l’application, seuls scripts disponibles', async () => {
    for (const [name, marker] of [['tailwind', 'tailwindcss'], ['chart', 'Chart.js']] as const) {
      const lib = widgetResponse(`monolith-widget://frame/lib/${name}.js`);
      expect(lib.status).toBe(200);
      expect(lib.headers.get('content-type')).toContain('text/javascript');
      expect(lib.headers.get('x-content-type-options')).toBe('nosniff');
      const code = await lib.text();
      expect(code.length).toBeGreaterThan(100_000);
      expect(code).toContain(marker);
    }
    expect(widgetResponse('monolith-widget://frame/lib/autre.js').status).toBe(404);
    expect(widgetResponse('monolith-widget://ailleurs/lib/chart.js').status).toBe(404);
  });

  it('bibliothèques chargées seulement si le bloc s’en sert', async () => {
    const shell = await widgetResponse('monolith-widget://frame/').text();
    expect(shell).toContain("if (/class/i.test(html))");
    expect(shell).toContain('if (/\\bChart\\b/.test(html))');
    // Le script du cadre ne se referme pas sur ses propres chaînes.
    expect(shell.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe('bloc `widget` dans le Markdown', () => {
  const render = (text: string) => splitBlocks(text).map(renderBlock).join('');

  it('fermé : prêt à être exécuté, avec son titre et son code intact', () => {
    const html = render(`Voici :\n\n\`\`\`widget Mon <titre>\n${source}\n\`\`\`\n\nSuite.`);
    const dom = new Map([...html.matchAll(/data-(title|widget)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(dom.get('title')).toBe('Mon &lt;titre&gt;');
    expect(dom.get('widget')).toContain('&lt;script&gt;let n = &quot;&lt;/div&gt;&quot;;&lt;/script&gt;');
    expect(html).not.toContain('pending');
    expect(html).not.toMatch(/<script/);
  });

  it('en cours d’écriture : jamais exécuté, y compris sur une clôture partielle', () => {
    for (const text of [`\`\`\`widget\n${source}`, `\`\`\`widget\n${source}\n\`\``, '```widget']) {
      const html = render(text);
      expect(html).toContain('mh-widget pending');
      expect(html).not.toContain('data-widget=');
    }
  });

  it('en cours d’écriture : carte dépliable avec titre, nombre de lignes et code déjà reçu', () => {
    const html = render(`\`\`\`widget Mon bloc\n${source}\n`);
    expect(html).toContain('data-widget-live="1"');
    expect(html).toContain('<span>Mon bloc</span>');
    expect(html).toContain('<span>2 lignes</span>');
    expect(html).toContain('let n =');
  });

  it('clôture plus longue, tildes et bloc imbriqué dans une citation', () => {
    expect(render(`\`\`\`\`widget\n${source}\n\`\`\`\`\`\n`)).toContain('data-widget');
    expect(render(`~~~widget\n${source}\n~~~\n`)).toContain('data-widget');
    expect(render(`\`\`\`widget\n${source}\n~~~\n`)).not.toContain('data-widget=');
    expect(render(`> \`\`\`widget\n> ${source.split('\n')[0]}\n> \`\`\`\n`)).toContain('data-widget');
  });

  it('réglage coupé : simple bloc de code', () => {
    const before = { ...renderOptions };
    setRenderOptions({ ...before, interactiveHtml: false });
    const html = render(`\`\`\`widget\n${source}\n\`\`\`\n`);
    setRenderOptions(before);
    expect(html).toContain('mh-code');
    expect(html).not.toContain('mh-widget');
  });
});
