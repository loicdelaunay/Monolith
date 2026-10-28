// Faux Chrome DevTools MCP (stdio) : outils de navigation simulés, sans navigateur.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chrome_devtools', version: '0.0-test' } } });
    case 'tools/list':
      return send({
        id: msg.id,
        result: {
          tools: [
            { name: 'list_pages', description: 'Liste les pages ouvertes', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
            { name: 'navigate_page', description: 'Ouvre une adresse', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
          ],
        },
      });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'navigate_page') return send({ id: msg.id, result: { content: [{ type: 'text', text: `Page ouverte : ${args.url}` }] } });
      return send({ id: msg.id, result: { content: [{ type: 'text', text: '1: about:blank [selected]' }] } });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
