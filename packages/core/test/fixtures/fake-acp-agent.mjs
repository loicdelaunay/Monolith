// Agent ACP de test : protocole JSON-RPC sur stdio, sans réseau ni modèle.
// Scénario d'un prompt : réflexion, appel d'outil « edit » avec demande d'autorisation,
// écriture via fs/write_text_file si autorisé, mise à jour de l'appel, message final.
import { createInterface } from 'node:readline';
import { join } from 'node:path';

let nextId = 1000;
const pending = new Map();
let cwd = process.cwd();
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let cancelled = false;

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/cancel') {
    cancelled = true;
    return;
  }
  // Compte ChatGPT simulé : méthode annoncée seulement si FAKE_CHATGPT=1 ; la clé d'API ne doit jamais arriver.
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } }, agentInfo: { name: 'fake-agent', version: '1.0' }, authMethods: process.env.FAKE_CHATGPT === '1' ? [{ id: 'chat-gpt', name: 'ChatGPT' }] : [] } });
  if (msg.method === 'authenticate') {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return send({ id: msg.id, error: { code: -32000, message: 'clé d’API reçue' } });
    return msg.params.methodId === 'chat-gpt' ? send({ id: msg.id, result: {} }) : send({ id: msg.id, error: { code: -32602, message: 'méthode inconnue' } });
  }
  if (msg.method === 'session/new') {
    cwd = msg.params.cwd;
    return send({ id: msg.id, result: { sessionId: 'sess-1' } });
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = msg.params.prompt.map((p) => p.text ?? '').join(' ');
    cancelled = false;
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Je réfléchis.' } });
    update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Écrire le fichier', priority: 'high', status: 'in_progress' }] });
    const target = join(cwd, 'agent.txt');
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Écrire agent.txt', kind: 'edit', status: 'pending', locations: [{ path: target }], rawInput: { path: target } });
    const perm = await request('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'tc1', title: 'Écrire agent.txt', kind: 'edit', locations: [{ path: target }] },
      options: [
        { optionId: 'ok', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'no', name: 'Refuser', kind: 'reject_once' },
      ],
    });
    const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId === 'ok';
    let result = 'refusé';
    if (allowed) {
      try {
        await request('fs/write_text_file', { sessionId: sid, path: target, content: `écrit par l'agent : ${text}` });
        const back = await request('fs/read_text_file', { sessionId: sid, path: target });
        result = back.content;
      } catch (e) {
        result = `erreur : ${e.message}`;
      }
    }
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: allowed && !result.startsWith('erreur') ? 'completed' : 'failed',
      content: allowed ? [{ type: 'diff', path: target, oldText: null, newText: result }] : [{ type: 'content', content: { type: 'text', text: result } }],
    });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Terminé (${result}).` } });
    return send({ id: msg.id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'unknown' } });
});
