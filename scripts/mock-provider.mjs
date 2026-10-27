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
    const last = request.messages?.at(-1)?.content ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const reasoning = request.model === 'mock-reasoner';
    if (reasoning) {
      for (const word of 'Je lis la demande, je structure la réponse puis je vérifie le Markdown.'.split(' ')) {
        res.write(chunk({ reasoning_content: word + ' ' }));
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const text = last.toLowerCase().includes('court') ? 'Réponse courte.' : REPLY;
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
