import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HarnessError, type AgentMode, type Conversation, type Id, type SubagentItem, type SubagentPreset } from '@monolith/contracts';
import type { ConversationService } from '../services/conversations.ts';
import type { MessageService } from '../services/messages.ts';
import type { ResourceService } from '../services/resources.ts';
import type { SettingsService } from '../services/settings.ts';
import type { GenerationRunner } from '../generation/runner.ts';
import { transcriptText } from '../generation/prompt.ts';
import { repoRoot, runGit } from '../tools/git.ts';
import type { ToolContext, ToolDefinition } from '../tools/types.ts';
import type { Logger } from '../log/logger.ts';

const ORDER: AgentMode[] = ['plan', 'propose', 'execute'];

export interface SubagentTask {
  title: string;
  instructions: string;
  preset?: string;
  worktree?: boolean;
}

/**
 * Sous-agents : chaque tâche devient une conversation enfant exécutée par le moteur normal
 * (outils, autorisations, détection de boucle), avec un budget, un mode jamais plus permissif
 * que celui du parent, et éventuellement un worktree Git dédié. L'annulation du parent se propage.
 */
export class SubagentService {
  constructor(
    private readonly deps: {
      conversations: ConversationService;
      messages: MessageService;
      resources: ResourceService;
      settings: SettingsService;
      generation: () => GenerationRunner;
      worktreesDir: string;
      logger: Logger;
    },
  ) {}

  private async prepareWorktree(parentRoot: string | undefined, childId: Id, title: string): Promise<{ path: string; branch: string }> {
    if (!parentRoot) throw new HarnessError('invalid_argument', 'Aucun dossier pour créer un worktree.');
    const repo = await repoRoot(parentRoot);
    if (!repo) throw new HarnessError('invalid_argument', 'Worktree impossible : la première ressource n’est pas un dépôt Git.');
    mkdirSync(this.deps.worktreesDir, { recursive: true });
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'tache';
    const branch = `monolith/sub-${childId}-${slug}`;
    const path = join(this.deps.worktreesDir, `sub-${childId}`);
    const r = await runGit(repo, ['worktree', 'add', '-b', branch, path, 'HEAD'], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new HarnessError('internal', `git worktree add a échoué : ${(r.stderr || r.stdout).trim()}`);
    return { path, branch };
  }

  /** Lance les tâches (parallélisme borné) et renvoie un rapport par sous-agent. */
  async run(ctx: ToolContext, tasks: SubagentTask[]): Promise<SubagentItem[]> {
    const s = this.deps.settings.get().subagents;
    const parent = this.deps.conversations.get(ctx.conversationId);
    if (parent.depth >= s.maxDepth) throw new HarnessError('permission_denied', `Profondeur maximale de délégation atteinte (${s.maxDepth}).`);
    if (!tasks.length) throw new HarnessError('invalid_argument', 'Aucune tâche à déléguer.');
    if (tasks.length > 12) throw new HarnessError('invalid_argument', '12 tâches maximum par délégation.');
    const items: SubagentItem[] = tasks.map((t) => ({ conversationId: 0, title: t.title.slice(0, 120), role: '', status: 'running', worktree: null, summary: '' }));
    const publish = () => ctx.progress({ kind: 'subagents', items: items.map((i) => ({ ...i })) });
    publish();

    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !ctx.signal.aborted) {
        const index = next++;
        await this.runOne(ctx, parent, tasks[index]!, items[index]!, s, publish).catch((e: Error) => {
          items[index]!.status = ctx.signal.aborted ? 'cancelled' : 'error';
          items[index]!.summary = e.message;
          publish();
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(s.maxParallel, tasks.length) }, worker));
    for (const i of items) if (i.status === 'running') i.status = 'cancelled';
    publish();
    return items;
  }

  private async runOne(ctx: ToolContext, parent: Conversation, task: SubagentTask, item: SubagentItem, s: ReturnType<SettingsService['get']>['subagents'], publish: () => void): Promise<void> {
    const preset: SubagentPreset | undefined = s.presets.find((p) => p.id === task.preset || p.name.toLowerCase() === task.preset?.toLowerCase()) ?? s.presets[0];
    // Le sous-agent n'est jamais plus permissif que son parent.
    const parentMode = parent.mode === 'chat' ? 'plan' : parent.agentMode;
    const mode = ORDER[Math.min(ORDER.indexOf(preset?.agentMode ?? 'plan'), ORDER.indexOf(parentMode))]!;
    const child = this.deps.conversations.create(parent.projectId, `↳ ${task.title}`.slice(0, 200), { providerId: preset?.providerId ?? parent.providerId, model: preset?.providerId ? preset.model : parent.model, reasoningLevel: parent.reasoningLevel }, {
      titleSource: 'user',
      parent: { id: parent.id, depth: parent.depth + 1, role: preset?.name ?? 'général', budget: { maxRounds: s.maxRounds, maxOutputTokens: s.maxOutputTokens, timeoutSec: s.timeoutSec } },
    });
    this.deps.conversations.update(child.id, { mode: 'agent', agentMode: mode });
    item.conversationId = child.id;
    item.role = preset?.name ?? 'général';
    publish();

    // Ressources : celles du parent, ou un worktree Git dédié.
    const parentScope = this.deps.resources.scope(parent.id).info;
    if (task.worktree) {
      item.worktree = await this.prepareWorktree(parentScope.roots[0], child.id, task.title);
      this.deps.resources.setCustom(child.id, [item.worktree.path]);
      publish();
    } else if (parentScope.mode === 'custom') {
      this.deps.resources.setCustom(child.id, parentScope.roots.filter((r) => r !== parentScope.privateDir), parentScope.files);
    }

    const generation = this.deps.generation();
    const prompt = [preset?.instructions, `Tâche : ${task.title}`, task.instructions, item.worktree ? `Tu travailles dans un worktree Git dédié (${item.worktree.path}, branche ${item.worktree.branch}) : tes modifications n’affectent pas le dossier principal.` : ''].filter(Boolean).join('\n\n');
    await generation.send(child.id, { text: prompt });
    const onAbort = () => generation.cancel(child.id);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      generation.cancel(child.id);
    }, s.timeoutSec * 1000);
    try {
      const final = await generation.waitFor(child.id);
      const last = this.deps.messages.list(child.id).filter((m) => m.role === 'assistant').at(-1);
      const budgetHit = last?.parts.some((p) => p.type === 'notice' && p.code.startsWith('budget_'));
      item.status = timedOut || budgetHit ? 'budget' : final === 'complete' ? 'done' : final === 'cancelled' ? 'cancelled' : final === 'error' ? 'error' : 'interrupted';
      const report = last ? transcriptText(last).trim() : '';
      item.summary = (timedOut ? `Délai du sous-agent dépassé (${s.timeoutSec} s). ` : '') + (report.length > 6000 ? `${report.slice(0, 6000)}…` : report || '(aucun rapport)');
      if (item.worktree) {
        const st = await runGit(item.worktree.path, ['status', '--porcelain']);
        const changed = st.stdout.split('\n').filter(Boolean).length;
        item.summary += `\n\n[Worktree ${item.worktree.path} — branche ${item.worktree.branch} — ${changed} fichier(s) modifié(s) non commités]`;
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      publish();
    }
  }

  /** Supprime le worktree d'un sous-agent (la branche est conservée). */
  async removeWorktree(conversationId: Id): Promise<void> {
    const c = this.deps.conversations.get(conversationId);
    if (c.parentId === null) throw new HarnessError('invalid_argument', 'Ce n’est pas un sous-agent');
    const path = join(this.deps.worktreesDir, `sub-${conversationId}`);
    if (!existsSync(path)) throw new HarnessError('not_found', 'Aucun worktree pour ce sous-agent');
    // Exécuté depuis le dépôt principal : un processus dont le dossier courant est le worktree empêcherait sa suppression.
    const common = await runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const main = common.code === 0 ? dirname(common.stdout.trim()) : null;
    if (!main) throw new HarnessError('internal', 'Dépôt principal du worktree introuvable');
    const r = await runGit(main, ['worktree', 'remove', '--force', path], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new HarnessError('internal', `git worktree remove a échoué : ${(r.stderr || r.stdout).trim()}`);
  }
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function delegateTool(service: () => SubagentService, presets: () => SubagentPreset[]): ToolDefinition {
  return {
    name: 'delegate_tasks',
    family: 'subagents',
    skill: 'subagents',
    description: 'Confie des sous-tâches indépendantes à des sous-agents exécutés en parallèle (chacun avec son propre contexte et un budget) et renvoie leurs rapports. Chaque consigne doit être autonome. worktree=true : branche Git isolée pour les modifications.',
    parameters: obj(
      {
        tasks: {
          type: 'array',
          items: obj({ title: { type: 'string' }, instructions: { type: 'string' }, preset: { type: 'string', description: `Rôle : ${presets().map((p) => `${p.id} (${p.description})`).join(', ')}` }, worktree: { type: 'boolean' } }, ['title', 'instructions']),
        },
      },
      ['tasks'],
    ),
    effects: ['interact'],
    target: (a) => ({ label: `${Array.isArray(a.tasks) ? a.tasks.length : 0} sous-agent(s)`, resources: [] }),
    async execute(args, ctx) {
      const tasks = (Array.isArray(args.tasks) ? args.tasks : []).map((t: Record<string, unknown>) => ({ title: String(t.title ?? 'Tâche'), instructions: String(t.instructions ?? ''), preset: typeof t.preset === 'string' ? t.preset : undefined, worktree: t.worktree === true }));
      const items = await service().run(ctx, tasks);
      const text = items.map((i, n) => `## ${n + 1}. ${i.title} — ${i.role} — ${i.status}\n${i.summary}`).join('\n\n');
      return { result: text, display: { kind: 'subagents', items }, status: items.every((i) => i.status === 'done') ? 'done' : 'error' };
    },
  };
}
