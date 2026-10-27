// Serveur MCP de test (stdio) : deux outils, sans réseau.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.1' } } });
    case 'tools/list':
      return send({
        id: msg.id,
        result: {
          tools: [
            { name: 'echo', description: 'Renvoie le texte', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true, openWorldHint: false } },
            { name: 'secret_env', description: 'Indique si la variable secrète est présente', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') return send({ id: msg.id, result: { content: [{ type: 'text', text: `écho : ${args.text}` }] } });
      if (name === 'secret_env') return send({ id: msg.id, result: { content: [{ type: 'text', text: process.env.FAKE_TOKEN ? `jeton présent (${process.env.FAKE_TOKEN.length} car.)` : 'absent' }] } });
      return send({ id: msg.id, result: { content: [{ type: 'text', text: 'outil inconnu' }], isError: true } });
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown' } });
  }
});
