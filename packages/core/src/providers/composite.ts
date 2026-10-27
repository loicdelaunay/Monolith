import { HarnessError, type CatalogModel, type ConnectionTestResult, type Id } from '@monolith/contracts';
import type { ChatMessage, ChatRequest, ProviderAdapter, ProviderConnection, StreamEvent, ToolCallRequest, ToolSpec } from './adapter.ts';

type Resolver = (providerId: Id) => Promise<{ adapter: ProviderAdapter; conn: ProviderConnection; providerName: string }>;
type Usage = Extract<StreamEvent, { type: 'usage' }>;

const CONSULT = 'consult_specialist';

/**
 * Modèle composé : un orchestrateur répond à l'utilisateur et peut consulter des spécialistes
 * (autres connexions/modèles) via l'outil `consult_specialist`. Les consultations sont exécutées
 * ici, affichées comme actions externes, et leur coût est cumulé dans la consommation du tour.
 */
export class CompositeAdapter implements ProviderAdapter {
  readonly kind = 'composite' as const;
  resolver: Resolver | null = null;

  private resolve(providerId: Id) {
    if (!this.resolver) throw new HarnessError('unavailable', 'Modèle composé indisponible');
    return this.resolver(providerId);
  }

  async listModels(conn: ProviderConnection): Promise<CatalogModel[]> {
    const n = conn.options.composite.specialists.length;
    return [{ id: 'composite', label: `Orchestrateur + ${n} spécialiste(s)`, owner: null, contextWindow: null, maxOutputTokens: null, capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: true } }];
  }

  async test(conn: ProviderConnection): Promise<ConnectionTestResult> {
    const started = performance.now();
    const c = conn.options.composite;
    try {
      if (!c.orchestrator) throw new HarnessError('invalid_argument', 'Choisissez le modèle orchestrateur.');
      const names = new Set<string>();
      for (const s of c.specialists) {
        if (names.has(s.name)) throw new HarnessError('invalid_argument', `Nom de spécialiste en double : ${s.name}`);
        names.add(s.name);
      }
      for (const ref of [c.orchestrator, ...c.specialists]) {
        const r = await this.resolve(ref.providerId);
        if (r.conn.kind === 'composite') throw new HarnessError('invalid_argument', 'Un modèle composé ne peut pas en contenir un autre.');
      }
      return { ok: true, status: null, latencyMs: Math.round(performance.now() - started), modelCount: 1, code: 'ok', message: `Orchestrateur et ${c.specialists.length} spécialiste(s) disponibles`, usedCompletion: false };
    } catch (e) {
      return { ok: false, status: null, latencyMs: Math.round(performance.now() - started), modelCount: null, code: e instanceof HarnessError ? e.code : 'internal', message: (e as Error).message, usedCompletion: false };
    }
  }

  async *stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const c = conn.options.composite;
    if (!c.orchestrator) throw new HarnessError('invalid_argument', 'Modèle composé sans orchestrateur (Réglages › Fournisseurs).');
    const orch = await this.resolve(c.orchestrator.providerId);
    if (orch.conn.kind === 'composite') throw new HarnessError('invalid_argument', 'Un modèle composé ne peut pas en contenir un autre.');
    const total = { input: 0, output: 0, cached: 0, reasoning: 0, any: false };
    const add = (u: Usage) => {
      total.any = true;
      total.input += u.inputTokens ?? 0;
      total.output += u.outputTokens ?? 0;
      total.cached += u.cachedInputTokens ?? 0;
      total.reasoning += u.reasoningTokens ?? 0;
    };
    const tools: ToolSpec[] = [...(request.tools ?? [])];
    if (c.specialists.length) {
      tools.push({
        name: CONSULT,
        description: `Consulte un spécialiste et renvoie sa réponse. Spécialistes : ${c.specialists.map((s) => `« ${s.name} » (${s.description || 'généraliste'})`).join(', ')}. La tâche doit être autonome : le spécialiste ne voit pas la conversation.`,
        parameters: { type: 'object', properties: { specialist: { type: 'string', enum: c.specialists.map((s) => s.name) }, task: { type: 'string', description: 'Consigne complète et autonome' } }, required: ['specialist', 'task'], additionalProperties: false },
      });
    }
    const messages: ChatMessage[] = [...request.messages];
    let consultations = 0;

    for (let round = 0; ; round++) {
      const consults: ToolCallRequest[] = [];
      const passthrough: ToolCallRequest[] = [];
      let text = '';
      let finish: Extract<StreamEvent, { type: 'finish' }> | null = null;
      const allowConsult = consultations < c.maxConsultations;
      for await (const ev of orch.adapter.stream(orch.conn, { ...request, model: c.orchestrator.model, messages, tools: allowConsult ? tools : tools.filter((t) => t.name !== CONSULT) }, signal)) {
        if (ev.type === 'tool_call') (ev.call.name === CONSULT ? consults : passthrough).push(ev.call);
        else if (ev.type === 'usage') add(ev);
        else if (ev.type === 'finish') finish = ev;
        else {
          if (ev.type === 'text') text += ev.text;
          yield ev;
        }
      }
      if (!consults.length || round > c.maxConsultations) {
        for (const call of passthrough) yield { type: 'tool_call', call };
        if (total.any) yield { type: 'usage', inputTokens: total.input, outputTokens: total.output, cachedInputTokens: total.cached || null, reasoningTokens: total.reasoning || null };
        if (finish) yield finish;
        return;
      }
      // Consultations en parallèle, affichées comme actions externes.
      const results = await Promise.all(
        consults.map(async (call) => {
          consultations++;
          let args: { specialist?: string; task?: string } = {};
          try {
            args = JSON.parse(call.arguments || '{}') as typeof args;
          } catch {
            /* arguments invalides */
          }
          const spec = c.specialists.find((s) => s.name === args.specialist);
          const title = `Consultation de « ${args.specialist ?? '?'} »`;
          if (!spec || !args.task) return { call, title, status: 'error' as const, text: `Spécialiste inconnu ou tâche vide. Spécialistes : ${c.specialists.map((s) => s.name).join(', ')}.` };
          try {
            const target = await this.resolve(spec.providerId);
            let out = '';
            for await (const ev of target.adapter.stream(target.conn, { model: spec.model, messages: [{ role: 'system', content: `Tu es le spécialiste « ${spec.name} » (${spec.description || 'généraliste'}). Réponds de façon complète et précise à la tâche.` }, { role: 'user', content: args.task }], reasoningLevel: 'auto', temperature: null, maxOutputTokens: null }, signal)) {
              if (ev.type === 'text') out += ev.text;
              else if (ev.type === 'usage') add(ev);
            }
            return { call, title: `${title} — ${target.providerName} · ${spec.model}`, status: 'done' as const, text: out.trim() || '(réponse vide)' };
          } catch (e) {
            if (signal.aborted) throw e;
            return { call, title, status: 'error' as const, text: `Erreur du spécialiste : ${(e as Error).message}` };
          }
        }),
      );
      for (const r of results) yield { type: 'external_tool', call: { id: r.call.id, name: CONSULT, family: 'composite', title: r.title, status: r.status, arguments: r.call.arguments, result: r.text } };
      messages.push({ role: 'assistant', content: text, toolCalls: consults });
      for (const r of results) messages.push({ role: 'tool', toolCallId: r.call.id, content: r.text });
      if (passthrough.length) {
        // Appels d'outils du moteur dans le même tour : exécutés par le moteur, puis l'orchestrateur reprend.
        for (const call of passthrough) yield { type: 'tool_call', call };
        if (total.any) yield { type: 'usage', inputTokens: total.input, outputTokens: total.output, cachedInputTokens: total.cached || null, reasoningTokens: total.reasoning || null };
        yield { type: 'finish', reason: 'tool_calls', raw: 'tool_calls' };
        return;
      }
    }
  }
}
