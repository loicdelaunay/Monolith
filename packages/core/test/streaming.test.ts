import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/providers/sse.ts';
import { ThinkTagSplitter } from '../src/providers/openai-compatible.ts';
import { classifyHttpError, isTruncatedJson400 } from '../src/providers/http.ts';
import { backoff, decideRetry } from '../src/generation/retry.ts';
import { ProviderError } from '../src/providers/http.ts';
import { HarnessError } from '@monolith/contracts';
import { redact, registerSecret } from '../src/security/redact.ts';

function parseAll(chunks: (string | Uint8Array)[]) {
  const p = new SseParser();
  const out = chunks.flatMap((c) => p.push(c));
  return [...out, ...p.end()];
}

describe('SseParser', () => {
  const payload = 'data: {"a":1}\n\n: keep-alive\n\nevent: custom\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';

  it('reconstruit les événements quel que soit le découpage', () => {
    const whole = parseAll([payload]);
    expect(whole.map((e) => e.data)).toEqual(['{"a":1}', 'line1\nline2', '[DONE]']);
    expect(whole[1]!.event).toBe('custom');
    for (let size = 1; size <= 9; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < payload.length; i += size) chunks.push(payload.slice(i, i + size));
      expect(parseAll(chunks).map((e) => e.data)).toEqual(['{"a":1}', 'line1\nline2', '[DONE]']);
    }
  });

  it('gère CRLF coupé entre deux fragments', () => {
    const events = parseAll(['data: x\r', '\n\r', '\ndata: y\r\n\r\n']);
    expect(events.map((e) => e.data)).toEqual(['x', 'y']);
  });

  it('gère un caractère UTF-8 coupé entre deux fragments', () => {
    const bytes = Buffer.from('data: héllo 🚀\n\n', 'utf8');
    const events = parseAll([bytes.subarray(0, 8), bytes.subarray(8, 15), bytes.subarray(15)]);
    expect(events[0]!.data).toBe('héllo 🚀');
  });

  it('émet le dernier événement sans ligne vide finale', () => {
    expect(parseAll(['data: fin']).map((e) => e.data)).toEqual(['fin']);
  });
});

describe('ThinkTagSplitter', () => {
  const run = (chunks: string[]) => {
    const s = new ThinkTagSplitter();
    const out = [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
    const merged: { type: string; text: string }[] = [];
    for (const e of out) {
      if (e.type !== 'text' && e.type !== 'reasoning') continue;
      const last = merged.at(-1);
      if (last && last.type === e.type) last.text += e.text;
      else merged.push({ type: e.type, text: e.text });
    }
    return merged;
  };

  it('sépare un bloc <think> initial même fragmenté', () => {
    expect(run(['<th', 'ink>raison', 'nement</th', 'ink>\n\nRéponse'])).toEqual([
      { type: 'reasoning', text: 'raisonnement' },
      { type: 'text', text: 'Réponse' },
    ]);
  });

  it('laisse le texte intact sans balise initiale', () => {
    expect(run(['Bonjour <think>pas une réflexion</think>'])).toEqual([{ type: 'text', text: 'Bonjour <think>pas une réflexion</think>' }]);
  });
});

describe('classification et retry', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 100, retryTruncatedJson400: true };

  it('détecte le JSON tronqué par une passerelle', () => {
    expect(isTruncatedJson400(400, '{"error":{"message":"Unexpected end of JSON input"}}')).toBe(true);
    expect(isTruncatedJson400(400, 'Failed to parse the request body as JSON: EOF while parsing a string')).toBe(true);
    expect(isTruncatedJson400(400, '{"error":{"message":"Invalid model"}}')).toBe(false);
    expect(isTruncatedJson400(500, 'Unexpected end of JSON input')).toBe(false);
  });

  it('retente les erreurs transitoires mais jamais un 400 ordinaire', () => {
    expect(decideRetry(classifyHttpError(503, 'busy', null), 1, policy, false).retry).toBe(true);
    expect(decideRetry(classifyHttpError(429, 'slow down', '2'), 1, policy, false)).toMatchObject({ retry: true, delayMs: 2000 });
    expect(decideRetry(classifyHttpError(400, '{"error":{"message":"bad param"}}', null), 1, policy, false).retry).toBe(false);
    expect(decideRetry(classifyHttpError(400, 'Unexpected end of JSON input', null), 1, policy, false)).toMatchObject({ retry: true, reason: 'truncated_json_400' });
    expect(decideRetry(classifyHttpError(400, 'Unexpected end of JSON input', null), 1, { ...policy, retryTruncatedJson400: false }, false).retry).toBe(false);
    expect(decideRetry(classifyHttpError(401, 'nope', null), 1, policy, false).retry).toBe(false);
  });

  it('ne retente pas après le début de la réponse, ni au-delà du maximum, ni après annulation', () => {
    const e = classifyHttpError(502, 'gateway', null);
    expect(decideRetry(e, 1, policy, true).retry).toBe(false);
    expect(decideRetry(e, 3, policy, false).retry).toBe(false);
    expect(decideRetry(new HarnessError('cancelled', 'x'), 1, policy, false).retry).toBe(false);
    expect(decideRetry(new ProviderError('provider_unreachable', 'x', null, true), 1, policy, false).retry).toBe(true);
  });

  it('borne l’attente exponentielle', () => {
    expect(backoff(1, 1000, () => 0.5)).toBe(1000);
    expect(backoff(3, 1000, () => 0.5)).toBe(4000);
    expect(backoff(20, 1000, () => 1)).toBe(30_000);
  });
});

describe('expurgation', () => {
  it('masque les secrets connus et les formes courantes', () => {
    registerSecret('ma-cle-ultra-secrete-123');
    expect(redact('clé=ma-cle-ultra-secrete-123')).not.toContain('ultra-secrete');
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [masqué]');
    expect(redact('https://x.test/v1?key=AIzaSyA1234567890abcdefghijk&b=1')).toContain('key=[masqué]&b=1');
    expect(redact('{"api_key":"sk-proj-abcdefghijklmnopqrst"}')).not.toContain('abcdefghijklmnopqrst');
  });
});
