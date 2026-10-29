#!/usr/bin/env node
// Faux fournisseur compatible OpenAI pour le développement et les tests de parcours.
// Aucune requête vers un service réel, aucun coût. Usage : node scripts/mock-provider.mjs [--port 11500]
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 11500;

const REPLY = `Voici une réponse de démonstration **en Markdown**.

| Élément | État |
| --- | --- |
| Streaming | ✅ |
| Tableaux | ✅ |

1. Premier point
2. Second point avec du \`code en ligne\`

\`\`\`ts
export function greet(name: string): string {
  return \`Bonjour, \${name} !\`;
}
\`\`\`

> Une citation pour vérifier le style.

Fin de la réponse.`;

const RICH = [
  'Rendu enrichi : la formule $E = mc^2$ en ligne, puis un bloc :',
  '',
  '$$',
  String.raw`\int_0^1 x^2\,dx = \frac{1}{3}`,
  '$$',
  '',
  'Fichier cité : `README.md` (le badge n’apparaît que s’il existe) et `absent.ts`.',
  '',
  '```mermaid',
  'graph LR',
  '  A[Demande] --> B{Outil ?}',
  '  B -->|oui| C[Exécution]',
  '  B -->|non| D[Réponse]',
  '```',
  '',
  '```html',
  '<h1 style="color:#5b5bd6">Aperçu HTML</h1><p>Scripts désactivés.</p>',
  '```',
].join(String.fromCharCode(10));

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-fast', context_length: 32768 }, { id: 'mock-reasoner', context_length: 131072 }] }));
      return;
    }
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body || '{}');
    const system = String(request.messages?.[0]?.content ?? '');
    const lastContent = request.messages?.at(-1)?.content ?? '';
    const last = typeof lastContent === 'string' ? lastContent : JSON.stringify(lastContent);
    // Sous-agent : rapport immédiat, sans outil.
    if (system.includes('Tu es un sous-agent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'Rapport du sous-agent : tâche terminée, 2 fichiers examinés.' }));
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    // Requêtes auxiliaires du moteur : nommage et compactage.
    if (system.includes('titre court') || system.includes('Tu résumes')) {
      // MOCK_SLOW_COMPACT=ms : compactage ralenti (vérification de l'indicateur « compactage en cours »).
      if (system.includes('Tu résumes') && Number(process.env.MOCK_SLOW_COMPACT) > 0) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_SLOW_COMPACT)));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const out = system.includes('titre court') ? 'Démonstration Markdown complète' : 'Résumé : l’utilisateur explore la démonstration Markdown.';
      res.write(chunk({ content: out }));
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 12 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    // Démonstration des outils : le faux modèle appelle un outil selon la demande, puis résume son résultat.
    const lastMessage = request.messages?.at(-1);
    if (Array.isArray(request.tools) && request.tools.length) {
      const names = request.tools.map((t) => t.function?.name);
      let call = null;
      if (lastMessage?.role === 'user') {
        const q = last.toLowerCase();
        if (q.includes('écris') && names.includes('write_file')) call = { name: 'write_file', arguments: { path: 'NOTES.md', content: '# Notes\n\n- Créé par la démonstration.\n' } };
        else if (q.includes('liste') && names.includes('list_files')) call = { name: 'list_files', arguments: {} };
        else if (q.includes('délègue') && names.includes('delegate_tasks')) call = { name: 'delegate_tasks', arguments: { tasks: [{ title: 'Inventaire', instructions: 'Liste les fichiers du projet', preset: 'explorer' }, { title: 'Relecture', instructions: 'Relis le README', preset: 'reviewer' }] } };
        else if (q.includes('capture') && names.includes('browser_screenshot')) call = { name: 'browser_screenshot', arguments: {} };
        else if (q.includes('question') && names.includes('ask_user')) call = { name: 'ask_user', arguments: { questions: [{ prompt: 'Quel style préférez-vous ?', options: ['Sobre', 'Coloré', 'Rétro'] }, { prompt: 'Un nom pour la page ?' }] } };
      }
      if (call) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: 'Je m’en occupe.' }));
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }));
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 300, completion_tokens: 30 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (lastMessage?.role === 'tool') {
        const result = String(lastMessage.content ?? '').split('\n').slice(0, 4).join(' ').slice(0, 160);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: `C’est fait. Résultat de l’outil : ${result}` }));
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 350, completion_tokens: 25 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const reasoning = request.model === 'mock-reasoner';
    if (reasoning) {
      for (const word of 'Je lis la demande, je structure la réponse puis je vérifie le Markdown.'.split(' ')) {
        res.write(chunk({ reasoning_content: word + ' ' }));
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const text = last.toLowerCase().includes('court') ? 'Réponse courte.' : last.toLowerCase().includes('rendu') ? RICH : REPLY;
    for (let i = 0; i < text.length; i += 6) {
      if (res.destroyed) return;
      res.write(chunk({ content: text.slice(i, i + 6) }));
      await new Promise((r) => setTimeout(r, 12));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: Math.ceil(text.length / 4), prompt_tokens_details: { cached_tokens: 64 } } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}).listen(port, '127.0.0.1', () => console.log(`Faux fournisseur sur http://127.0.0.1:${port}/v1`));
