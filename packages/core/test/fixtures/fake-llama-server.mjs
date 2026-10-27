// Faux llama-server pour les tests : --version, /health, /v1/chat/completions (flux SSE).
import { createServer } from 'node:http';
import { basename } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('version: 9999 (test)');
  process.exit(0);
}
const arg = (name) => args[args.indexOf(name) + 1];
const model = basename(arg('-m') ?? 'inconnu');
const port = Number(arg('--port'));
const started = Date.now();
createServer((req, res) => {
  if (req.url === '/health') {
    // Simule un chargement de 300 ms.
    res.writeHead(Date.now() - started > 300 ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: Date.now() - started > 300 ? 'ok' : 'loading model' }));
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = `Bonjour depuis ${model} (ctx ${arg('-c')}, ngl ${arg('-ngl')})`;
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1');
