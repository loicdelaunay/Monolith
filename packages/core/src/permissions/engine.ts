import { randomUUID } from 'node:crypto';
import {
  HarnessError,
  type Id,
  type PermissionDecisionLog,
  type PermissionPolicy,
  type PermissionRecord,
  type PermissionRequest,
  type PermissionRule,
  type PermissionScope,
  type ToolEffect,
} from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface RuleRow {
  id: number;
  scope: string;
  project_id: number | null;
  conversation_id: number | null;
  tool: string;
  family: string;
  resource: string;
  decision: string;
  origin: string;
  created_at: string;
}

const mapRule = (r: RuleRow): PermissionRule => ({
  id: r.id,
  scope: r.scope as PermissionRule['scope'],
  projectId: r.project_id,
  conversationId: r.conversation_id,
  tool: r.tool,
  family: r.family,
  resource: r.resource,
  decision: r.decision as PermissionRule['decision'],
  origin: r.origin as PermissionRule['origin'],
  createdAt: r.created_at,
});

/** Motif glob simple : `**` (tout), `*` (hors séparateur), `?` (un caractère). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++;
      } else re += '[^/\\\\]*';
    } else if (c === '?') re += '.';
    else if (c === '/' || c === '\\') re += '[/\\\\]';
    else re += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export interface PermissionQuery {
  conversationId: Id;
  projectId: Id | null;
  tool: string;
  family: string;
  effects: ToolEffect[];
  /** Ressources visées, sous plusieurs formes (absolue, relative, commande…). */
  resources: string[];
  /** Ressource d'un accord permanent (ex. keyboard:uia) ; absente : l'accord couvre l'outil. */
  grant?: string;
}

export interface Evaluation {
  decision: 'allow' | 'deny' | 'ask';
  source: PermissionRecord['source'];
  ruleId: Id | null;
  scope: PermissionScope | null;
  reason: string;
}

interface Pending {
  request: PermissionRequest;
  query: PermissionQuery;
  resolve: (r: { decision: 'allow' | 'deny'; scope: PermissionScope; reason: string }) => void;
}

/**
 * Autorisations : politique globale, règles (outil, famille, ressource ; globales, par projet ou
 * par conversation), demandes interactives et historique. Un refus explicite l'emporte toujours ;
 * sinon la règle la plus spécifique décide. Une annulation ou une fermeture vaut refus.
 */
export class PermissionEngine {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  rules(projectId?: Id | null): PermissionRule[] {
    const rows =
      projectId === undefined
        ? this.db.all<RuleRow>('SELECT * FROM permission_rules ORDER BY id')
        : this.db.all<RuleRow>("SELECT * FROM permission_rules WHERE scope = 'global' OR (scope = 'project' AND project_id IS ?) ORDER BY id", projectId);
    return rows.map(mapRule);
  }

  addRule(input: Omit<PermissionRule, 'id' | 'createdAt' | 'origin'> & { origin?: PermissionRule['origin'] }): PermissionRule {
    if (!['allow', 'deny', 'ask'].includes(input.decision)) throw new HarnessError('invalid_argument', 'Décision inconnue');
    if (!['global', 'project', 'conversation'].includes(input.scope)) throw new HarnessError('invalid_argument', 'Portée inconnue');
    if (input.scope === 'project' && input.projectId == null) throw new HarnessError('invalid_argument', 'Projet requis pour une règle de projet');
    if (input.scope === 'conversation' && input.conversationId == null) throw new HarnessError('invalid_argument', 'Conversation requise');
    const tool = (input.tool || '*').trim().slice(0, 100);
    const family = (input.family || '*').trim().slice(0, 100);
    const resource = (input.resource ?? '').trim().slice(0, 500);
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO permission_rules (scope, project_id, conversation_id, tool, family, resource, decision, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.scope,
      input.scope === 'project' ? input.projectId : null,
      input.scope === 'conversation' ? input.conversationId : null,
      tool,
      family,
      resource,
      input.decision,
      input.origin ?? 'user',
      now(),
    );
    this.events.emit('rules.changed', { rules: this.rules() });
    return mapRule(this.db.get<RuleRow>('SELECT * FROM permission_rules WHERE id = ?', lastInsertRowid)!);
  }

  removeRule(id: Id): void {
    if (!this.db.run('DELETE FROM permission_rules WHERE id = ?', id).changes) throw new HarnessError('not_found', 'Règle introuvable');
    this.events.emit('rules.changed', { rules: this.rules() });
  }

  evaluate(q: PermissionQuery, policy: PermissionPolicy): Evaluation {
    if (q.effects.every((e) => e === 'interact')) return { decision: 'allow', source: 'automatic', ruleId: null, scope: null, reason: 'Interaction avec l’utilisateur, sans effet sur le système.' };
    if (policy === 'deny_all') return { decision: 'deny', source: 'policy', ruleId: null, scope: null, reason: 'Politique « Refuser tout ».' };

    const rows = this.db.all<RuleRow>(
      "SELECT * FROM permission_rules WHERE scope = 'global' OR (scope = 'project' AND project_id IS ?) OR (scope = 'conversation' AND conversation_id = ?)",
      q.projectId,
      q.conversationId,
    );
    const matching = rows.filter((r) => {
      if (r.tool !== '*' && r.tool !== q.tool) return false;
      if (r.family !== '*' && r.family !== q.family) return false;
      if (!r.resource) return true;
      const re = globToRegExp(r.resource);
      return q.resources.some((res) => re.test(res) || res.startsWith(r.resource));
    });
    const scopeOf = (r: RuleRow): PermissionScope => (r.scope === 'conversation' ? 'conversation' : r.scope === 'project' ? 'project' : 'global');
    const describe = (r: RuleRow) => `Règle n° ${r.id} (${r.scope === 'global' ? 'globale' : r.scope === 'project' ? 'projet' : 'conversation'} : ${r.tool === '*' ? 'tout outil' : r.tool}${r.family !== '*' ? `, famille ${r.family}` : ''}${r.resource ? `, ressource ${r.resource}` : ''})`;

    const deny = matching.find((r) => r.decision === 'deny');
    if (deny) return { decision: 'deny', source: 'rule', ruleId: deny.id, scope: scopeOf(deny), reason: `${describe(deny)} : refus explicite (prioritaire).` };
    const score = (r: RuleRow) => (r.resource ? 8 : 0) + (r.tool !== '*' ? 4 : 0) + (r.family !== '*' ? 2 : 0) + (r.scope === 'conversation' ? 1 : r.scope === 'project' ? 0.5 : 0);
    const best = matching.sort((a, b) => score(b) - score(a))[0];
    if (best) return { decision: best.decision === 'allow' ? 'allow' : 'ask', source: 'rule', ruleId: best.id, scope: scopeOf(best), reason: describe(best) };

    if (policy === 'rules' && q.effects.every((e) => e === 'read' || e === 'interact')) {
      return { decision: 'allow', source: 'automatic', ruleId: null, scope: null, reason: 'Lecture dans la portée de la conversation (politique « Selon les règles »).' };
    }
    return { decision: 'ask', source: 'policy', ruleId: null, scope: null, reason: policy === 'ask' ? 'Politique « Demander ».' : 'Aucune règle ne couvre cet effet.' };
  }

  /** Demande interactive : résolue par `respond`, ou refusée si la génération est annulée. */
  request(request: Omit<PermissionRequest, 'requestId'>, query: PermissionQuery, signal: AbortSignal): Promise<{ decision: 'allow' | 'deny'; scope: PermissionScope; reason: string }> {
    const requestId = randomUUID();
    const full: PermissionRequest = { ...request, requestId };
    return new Promise((resolve) => {
      const finish = (r: { decision: 'allow' | 'deny'; scope: PermissionScope; reason: string }) => {
        if (!this.pending.delete(requestId)) return;
        signal.removeEventListener('abort', onAbort);
        this.events.emit('permission.resolved', { requestId, decision: r.decision });
        resolve(r);
      };
      const onAbort = () => finish({ decision: 'deny', scope: 'once', reason: 'Génération annulée avant la réponse (l’annulation ne vaut pas approbation).' });
      this.pending.set(requestId, { request: full, query, resolve: finish });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.events.emit('permission.requested', full);
    });
  }

  respond(requestId: string, decision: 'allow' | 'deny', scope: PermissionScope): void {
    const p = this.pending.get(requestId);
    if (!p) throw new HarnessError('not_found', 'Demande d’autorisation introuvable ou déjà traitée');
    if (decision !== 'allow' && decision !== 'deny') throw new HarnessError('invalid_argument', 'Décision invalide');
    const validScope: PermissionScope = ['once', 'conversation', 'project', 'global'].includes(scope) ? scope : 'once';
    // Accord ou refus persistant : enregistré comme règle sur l'outil, à la portée choisie.
    if (validScope !== 'once') {
      const ruleScope = validScope === 'conversation' ? 'conversation' : validScope === 'project' && p.query.projectId !== null ? 'project' : 'global';
      this.addRule({
        scope: ruleScope,
        projectId: ruleScope === 'project' ? p.query.projectId : null,
        conversationId: ruleScope === 'conversation' ? p.query.conversationId : null,
        tool: p.query.tool,
        family: '*',
        resource: p.query.grant ?? '',
        decision,
        origin: 'prompt',
      });
    }
    p.resolve({ decision, scope: validScope, reason: decision === 'allow' ? 'Autorisé par l’utilisateur.' : 'Refusé par l’utilisateur.' });
  }

  listPending(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  log(conversationId: Id | null, tool: string, target: string | null, record: PermissionRecord): void {
    this.db.run(
      'INSERT INTO permission_decisions (conversation_id, tool, target, decision, source, rule_id, scope, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      conversationId,
      tool,
      target,
      record.decision,
      record.source,
      record.ruleId,
      record.scope,
      record.reason,
      record.decidedAt,
    );
  }

  history(conversationId: Id | undefined, limit: number): PermissionDecisionLog[] {
    const rows =
      conversationId === undefined
        ? this.db.all<Record<string, unknown>>('SELECT * FROM permission_decisions ORDER BY id DESC LIMIT ?', limit)
        : this.db.all<Record<string, unknown>>('SELECT * FROM permission_decisions WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', conversationId, limit);
    return rows.map((r) => ({
      id: r.id as number,
      conversationId: (r.conversation_id as number | null) ?? null,
      tool: r.tool as string,
      target: (r.target as string | null) ?? null,
      decision: r.decision as 'allow' | 'deny',
      source: r.source as PermissionRecord['source'],
      ruleId: (r.rule_id as number | null) ?? null,
      scope: (r.scope as PermissionScope | null) ?? null,
      reason: r.reason as string,
      createdAt: r.created_at as string,
    }));
  }

  /**
   * `permission.json` : `{ "rules": [{ tool, family, resource, decision }] }` ou
   * `{ "allow": ["outil", "outil(ressource)"], "deny": [...], "ask": [...] }`.
   */
  parseImport(projectId: Id, json: string): { rules: Omit<PermissionRule, 'id' | 'createdAt'>[]; errors: string[] } {
    const errors: string[] = [];
    const rules: Omit<PermissionRule, 'id' | 'createdAt'>[] = [];
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch (e) {
      return { rules, errors: [`JSON invalide : ${(e as Error).message}`] };
    }
    const push = (tool: string, family: string, resource: string, decision: string, where: string) => {
      if (!['allow', 'deny', 'ask'].includes(decision)) return errors.push(`${where} : décision « ${decision} » inconnue`);
      rules.push({ scope: 'project', projectId, conversationId: null, tool: tool || '*', family: family || '*', resource: resource || '', decision: decision as PermissionRule['decision'], origin: 'import' });
    };
    const obj = (data ?? {}) as Record<string, unknown>;
    if (Array.isArray(obj.rules)) {
      obj.rules.forEach((r, i) => {
        const x = (r ?? {}) as Record<string, unknown>;
        push(String(x.tool ?? '*'), String(x.family ?? '*'), String(x.resource ?? ''), String(x.decision ?? ''), `rules[${i}]`);
      });
    }
    for (const decision of ['allow', 'deny', 'ask'] as const) {
      const list = obj[decision] ?? (obj.permissions as Record<string, unknown> | undefined)?.[decision];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        errors.push(`« ${decision} » doit être une liste`);
        continue;
      }
      list.forEach((entry, i) => {
        const m = /^\s*([\w.*-]+)\s*(?:\((.*)\))?\s*$/.exec(String(entry));
        if (!m) return errors.push(`${decision}[${i}] : entrée illisible « ${String(entry)} »`);
        push(m[1]!, '*', m[2] ?? '', decision, `${decision}[${i}]`);
      });
    }
    if (rules.length === 0 && errors.length === 0) errors.push('Aucune règle trouvée (clés attendues : rules, allow, deny, ask).');
    return { rules, errors };
  }
}
