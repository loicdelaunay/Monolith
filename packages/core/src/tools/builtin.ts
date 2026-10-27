import { readFileSync, statSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ActionProposal, FileChange, PlanItem, Question, QuestionAnswer, ToolDisplay } from '@monolith/contracts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';
import { bool, limit, num, str } from './types.ts';
import { applyChanges, currentContent, isBinary, readText, replaceInText, walk } from './files.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Ressources d'un chemin pour les règles : absolu et relatif à la racine. */
function pathTarget(args: Record<string, unknown>, ctx: ToolContext, key = 'path'): { label: string | null; resources: string[] } {
  try {
    const full = ctx.scope.resolve(args[key], { write: true });
    const display = ctx.scope.display(full);
    return { label: display, resources: [full, display] };
  } catch {
    const raw = typeof args[key] === 'string' ? (args[key] as string) : null;
    return { label: raw, resources: raw ? [raw] : [] };
  }
}

/** Calcule les changements d'un outil d'écriture sans rien écrire. */
function planWrite(args: Record<string, unknown>, ctx: ToolContext, mode: 'write' | 'edit'): FileChange & { full: string } {
  const full = ctx.scope.resolve(args.path, { write: true });
  const cur = currentContent(full);
  if (mode === 'write') {
    const content = str(args, 'content', false);
    return { full, path: ctx.scope.display(full), status: cur.exists ? 'modified' : 'created', before: cur.content, after: content };
  }
  if (!cur.exists) throw new Error(`Fichier introuvable : ${ctx.scope.display(full)} (utilisez write_file pour le créer)`);
  const after = replaceInText(cur.content, str(args, 'old_string'), str(args, 'new_string', false), bool(args, 'replace_all'), ctx.scope.display(full));
  return { full, path: ctx.scope.display(full), status: 'modified', before: cur.content, after };
}

interface PatchEntry {
  path?: unknown;
  action?: unknown;
  content?: unknown;
  edits?: { old_string?: unknown; new_string?: unknown; replace_all?: unknown }[];
}

function planPatch(args: Record<string, unknown>, ctx: ToolContext): (FileChange & { full: string })[] {
  const entries = args.changes;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('« changes » doit être une liste non vide');
  if (entries.length > 50) throw new Error('50 fichiers maximum par patch');
  const seen = new Set<string>();
  return (entries as PatchEntry[]).map((e, i) => {
    const full = ctx.scope.resolve(e.path, { write: true });
    if (seen.has(full)) throw new Error(`changes[${i}] : fichier présent deux fois dans le patch`);
    seen.add(full);
    const cur = currentContent(full);
    const display = ctx.scope.display(full);
    const action = String(e.action ?? 'update');
    if (action === 'delete') {
      if (!cur.exists) throw new Error(`changes[${i}] : fichier à supprimer introuvable (${display})`);
      return { full, path: display, status: 'deleted', before: cur.content, after: '' };
    }
    if (action === 'create') {
      if (cur.exists) throw new Error(`changes[${i}] : ${display} existe déjà (utilisez action « update »)`);
      return { full, path: display, status: 'created', before: '', after: typeof e.content === 'string' ? e.content : '' };
    }
    if (action !== 'update') throw new Error(`changes[${i}] : action « ${action} » inconnue (create, update, delete)`);
    if (!cur.exists) throw new Error(`changes[${i}] : fichier introuvable (${display})`);
    let after = cur.content;
    if (typeof e.content === 'string') after = e.content;
    for (const [j, ed] of (e.edits ?? []).entries()) {
      try {
        after = replaceInText(after, String(ed.old_string ?? ''), String(ed.new_string ?? ''), ed.replace_all === true, display);
      } catch (err) {
        throw new Error(`changes[${i}].edits[${j}] : ${(err as Error).message}`);
      }
    }
    return { full, path: display, status: 'modified', before: cur.content, after };
  });
}

/** Écriture réelle, ou proposition en mode Proposition. */
function commit(changes: (FileChange & { full: string })[], ctx: ToolContext): ToolResult {
  const display: ToolDisplay = { kind: 'changes', changes: changes.map(({ full: _f, ...c }) => c), applied: false };
  if (ctx.mode === 'agent' && ctx.agentMode === 'propose') {
    const ids = ctx.propose(changes);
    return {
      status: 'proposed',
      display: { ...display, proposalIds: ids },
      result: `Proposition enregistrée, NON appliquée (mode Proposition) : ${changes.map((c) => `${c.status} ${c.path}`).join(', ')}. L’utilisateur l’examinera et décidera de l’appliquer.`,
    };
  }
  applyChanges(changes);
  return { display: { ...display, applied: true }, result: `Appliqué : ${changes.map((c) => `${c.status === 'created' ? 'créé' : c.status === 'deleted' ? 'supprimé' : 'modifié'} ${c.path}`).join(', ')}.` };
}

const sourcesTools: ToolDefinition[] = [
  {
    name: 'list_files',
    family: 'sources',
    skill: 'sources',
    description: 'Liste les fichiers et dossiers d’un dossier accessible (récursif, dossiers lourds comme node_modules ignorés).',
    parameters: obj({ path: { type: 'string', description: 'Dossier (relatif à la racine). Par défaut : la racine.' }, recursive: { type: 'boolean' }, max: { type: 'number' } }),
    effects: ['read'],
    target: (a, ctx) => pathTarget({ path: a.path ?? '.' }, ctx),
    async execute(args, ctx) {
      const dir = ctx.scope.resolve(args.path ?? '.');
      const max = Math.min(2000, num(args, 'max', 400));
      const { paths, truncated } = bool(args, 'recursive', true) ? walk(dir, { max, includeDirs: true }) : walk(dir, { max, includeDirs: true, pattern: '*' });
      const roots = ctx.scope.roots.length > 1 ? `Racines accessibles : ${ctx.scope.roots.join(', ')}\n` : '';
      return {
        display: { kind: 'list', title: ctx.scope.display(dir), items: paths, truncated },
        result: `${roots}${ctx.scope.display(dir)} :\n${paths.join('\n') || '(vide)'}${truncated ? `\n[… liste tronquée à ${max} entrées]` : ''}`,
      };
    },
  },
  {
    name: 'read_file',
    family: 'sources',
    skill: 'sources',
    description: 'Lit un fichier texte, éventuellement une plage de lignes (numérotées à partir de 1).',
    parameters: obj({ path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, ['path']),
    effects: ['read'],
    target: (a, ctx) => pathTarget(a, ctx),
    async execute(args, ctx) {
      const full = ctx.scope.resolve(args.path);
      const lines = readText(full).split(/\r?\n/);
      const start = Math.max(1, Math.floor(num(args, 'start_line', 1)));
      const end = Math.min(lines.length, Math.floor(num(args, 'end_line', Math.min(lines.length, start + 1999))));
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join('\n');
      return {
        display: { kind: 'file', path: ctx.scope.display(full), startLine: start, endLine: end, totalLines: lines.length, content: slice.join('\n') },
        result: limit(`${ctx.scope.display(full)} (lignes ${start}-${end} sur ${lines.length}) :\n${numbered}`, ctx.settings.agent.maxResultChars),
      };
    },
  },
  {
    name: 'glob_files',
    family: 'sources',
    skill: 'sources',
    description: 'Trouve des fichiers par motif glob (ex. « src/**/*.ts », « **/package.json »).',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    effects: ['read'],
    target: (a, ctx) => ({ label: str(a, 'pattern', false), resources: pathTarget({ path: a.path ?? '.' }, ctx).resources }),
    async execute(args, ctx) {
      const dir = ctx.scope.resolve(args.path ?? '.');
      const { paths, truncated } = walk(dir, { pattern: str(args, 'pattern'), max: 1000 });
      return { display: { kind: 'list', title: str(args, 'pattern'), items: paths, truncated }, result: `${paths.length} fichier(s)${truncated ? ' (liste tronquée)' : ''} :\n${paths.join('\n')}` };
    },
  },
  {
    name: 'grep_files',
    family: 'sources',
    skill: 'sources',
    description: 'Recherche une expression régulière dans les fichiers texte ; renvoie chemin:ligne: texte.',
    parameters: obj({ pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string', description: 'Filtre de fichiers, ex. « **/*.ts »' }, ignore_case: { type: 'boolean' }, max: { type: 'number' } }, ['pattern']),
    effects: ['read'],
    target: (a, ctx) => ({ label: str(a, 'pattern', false), resources: pathTarget({ path: a.path ?? '.' }, ctx).resources }),
    async execute(args, ctx) {
      const dir = ctx.scope.resolve(args.path ?? '.');
      let re: RegExp;
      try {
        re = new RegExp(str(args, 'pattern'), bool(args, 'ignore_case') ? 'i' : '');
      } catch (e) {
        throw new Error(`Expression régulière invalide : ${(e as Error).message}`);
      }
      const max = Math.min(1000, num(args, 'max', 200));
      const files = walk(dir, { pattern: typeof args.glob === 'string' ? args.glob : undefined, max: 20_000 }).paths;
      const hits: string[] = [];
      let scanned = 0;
      for (const rel of files) {
        if (ctx.signal.aborted || hits.length >= max) break;
        const full = `${dir}/${rel}`;
        let buf: Buffer;
        try {
          if (statSync(full).size > 2 * 1024 * 1024) continue;
          buf = readFileSync(full);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        scanned++;
        buf
          .toString('utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (hits.length < max && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
          });
      }
      return {
        display: { kind: 'list', title: str(args, 'pattern'), items: hits, truncated: hits.length >= max },
        result: limit(`${hits.length} occurrence(s) dans ${scanned} fichier(s) analysé(s)${hits.length >= max ? ' (limite atteinte)' : ''} :\n${hits.join('\n')}`, ctx.settings.agent.maxResultChars),
      };
    },
  },
];

const editTools: ToolDefinition[] = [
  {
    name: 'write_file',
    family: 'edit',
    skill: 'editing',
    description: 'Crée ou remplace entièrement un fichier texte.',
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    effects: ['write'],
    target: (a, ctx) => pathTarget(a, ctx),
    preview: (a, ctx) => {
      const c = planWrite(a, ctx, 'write');
      return { kind: 'changes', changes: [{ path: c.path, status: c.status, before: c.before, after: c.after }], applied: false };
    },
    async execute(args, ctx) {
      return commit([planWrite(args, ctx, 'write')], ctx);
    },
  },
  {
    name: 'edit_file',
    family: 'edit',
    skill: 'editing',
    description: 'Remplace un passage exact d’un fichier (old_string doit être unique, sauf replace_all).',
    parameters: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
    effects: ['write'],
    target: (a, ctx) => pathTarget(a, ctx),
    preview: (a, ctx) => {
      const c = planWrite(a, ctx, 'edit');
      return { kind: 'changes', changes: [{ path: c.path, status: c.status, before: c.before, after: c.after }], applied: false };
    },
    async execute(args, ctx) {
      return commit([planWrite(args, ctx, 'edit')], ctx);
    },
  },
  {
    name: 'apply_patch',
    family: 'edit',
    skill: 'patch',
    description:
      'Applique un lot de modifications sur plusieurs fichiers, de façon atomique (tout ou rien). changes: [{ path, action: "create"|"update"|"delete", content?, edits?: [{ old_string, new_string, replace_all? }] }].',
    parameters: obj(
      {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              action: { type: 'string', enum: ['create', 'update', 'delete'] },
              content: { type: 'string' },
              edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } },
            },
            required: ['path', 'action'],
          },
        },
      },
      ['changes'],
    ),
    effects: ['write'],
    target: (a, ctx) => {
      const list = Array.isArray(a.changes) ? (a.changes as PatchEntry[]) : [];
      const res = list.flatMap((c) => pathTarget({ path: c.path }, ctx).resources);
      return { label: `${list.length} fichier(s)`, resources: res };
    },
    preview: (a, ctx) => ({ kind: 'changes', changes: planPatch(a, ctx).map(({ full: _f, ...c }) => c), applied: false }),
    async execute(args, ctx) {
      return commit(planPatch(args, ctx), ctx);
    },
  },
];

const terminalTools: ToolDefinition[] = [
  {
    name: 'run_command',
    family: 'terminal',
    skill: 'terminal',
    description: `Exécute une commande shell (${process.platform === 'win32' ? 'PowerShell' : 'bash'}) dans un dossier accessible. Au-delà du délai, la commande continue en arrière-plan : utilisez read_terminal.`,
    parameters: obj({ command: { type: 'string' }, cwd: { type: 'string', description: 'Dossier (relatif à la racine)' }, timeout_sec: { type: 'number' } }, ['command']),
    effects: ['exec'],
    target: (a, ctx) => ({ label: str(a, 'command', false), resources: [str(a, 'command', false), ...pathTarget({ path: a.cwd ?? '.' }, ctx).resources] }),
    preview: (a, ctx) => ({ kind: 'command', command: str(a, 'command', false), cwd: pathTarget({ path: a.cwd ?? '.' }, ctx).label ?? '.', output: '', exitCode: null, status: 'running', terminalId: '' }),
    async execute(args, ctx) {
      const cwd = ctx.scope.resolve(args.cwd ?? '.');
      if (!statSync(cwd).isDirectory()) throw new Error('cwd doit être un dossier');
      const command = str(args, 'command');
      const timeout = Math.min(ctx.settings.agent.commandTimeoutSec, Math.max(1, num(args, 'timeout_sec', ctx.settings.agent.commandTimeoutSec))) * 1000;
      const session = ctx.terminals.start(ctx.conversationId, command, cwd);
      await ctx.terminals.wait(session.info.id, timeout, ctx.signal);
      const output = ctx.terminals.readNew(session.info.id);
      const info = session.info;
      const status = info.status === 'running' ? 'running' : info.status;
      const header =
        status === 'running'
          ? `La commande continue en arrière-plan (terminal ${info.id}) après ${Math.round(timeout / 1000)} s. Utilisez read_terminal pour la suite.`
          : status === 'killed'
            ? `Commande arrêtée (terminal ${info.id}).`
            : `Code de sortie : ${info.exitCode}.`;
      return {
        status: info.exitCode !== null && info.exitCode !== 0 ? 'error' : 'done',
        display: { kind: 'command', command, cwd: ctx.scope.display(cwd), output: limit(output, 60_000), exitCode: info.exitCode, status: status === 'running' ? 'running' : status === 'killed' ? 'killed' : 'exited', terminalId: info.id },
        result: limit(`${header}\n${output || '(aucune sortie)'}`, ctx.settings.agent.maxResultChars),
      };
    },
  },
  {
    name: 'read_terminal',
    family: 'terminal',
    skill: 'terminal',
    description: 'Lit la nouvelle sortie d’un terminal lancé par run_command et son état.',
    parameters: obj({ terminal_id: { type: 'string' }, wait_sec: { type: 'number' } }, ['terminal_id']),
    effects: ['read'],
    target: (a) => ({ label: str(a, 'terminal_id', false), resources: [] }),
    async execute(args, ctx) {
      const id = str(args, 'terminal_id');
      const s = ctx.terminals.get(id);
      if (s.info.conversationId !== ctx.conversationId) throw new Error('Terminal d’une autre conversation');
      if (s.info.status === 'running') await ctx.terminals.wait(id, Math.min(60, Math.max(0, num(args, 'wait_sec', 0))) * 1000, ctx.signal);
      const out = ctx.terminals.readNew(id);
      return { result: limit(`État : ${s.info.status}${s.info.exitCode !== null ? `, code ${s.info.exitCode}` : ''}\n${out || '(aucune nouvelle sortie)'}`, ctx.settings.agent.maxResultChars) };
    },
  },
  {
    name: 'kill_terminal',
    family: 'terminal',
    skill: 'terminal',
    description: 'Arrête une commande encore en cours.',
    parameters: obj({ terminal_id: { type: 'string' } }, ['terminal_id']),
    effects: ['exec'],
    target: (a) => ({ label: str(a, 'terminal_id', false), resources: [] }),
    async execute(args, ctx) {
      const id = str(args, 'terminal_id');
      if (ctx.terminals.get(id).info.conversationId !== ctx.conversationId) throw new Error('Terminal d’une autre conversation');
      ctx.terminals.kill(id);
      return { result: `Terminal ${id} arrêté.` };
    },
  },
];

const interactTools: ToolDefinition[] = [
  {
    name: 'get_info',
    family: 'info',
    skill: 'info',
    description: 'Donne la date et l’heure actuelles, des informations sur le système et sur la conversation (selon les catégories activées).',
    parameters: obj({}),
    effects: ['interact'],
    target: () => ({ label: null, resources: [] }),
    async execute(_args, ctx) {
      const c = ctx.settings.skills.info;
      const entries: { label: string; value: string }[] = [];
      if (c.date) {
        const d = new Date();
        entries.push({ label: 'Date et heure', value: `${d.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'long' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}, ISO ${d.toISOString()})` });
      }
      if (c.system) {
        entries.push({ label: 'Système', value: `${platform()} ${release()} ${arch()}` });
        entries.push({ label: 'Shell des commandes', value: process.platform === 'win32' ? 'Windows PowerShell' : 'bash' });
        entries.push({ label: 'Poste', value: hostname() });
      }
      if (c.conversation) {
        entries.push({ label: 'Conversation', value: ctx.info.conversationTitle });
        entries.push({ label: 'Projet', value: ctx.info.projectName ?? 'Espace personnel' });
        entries.push({ label: 'Modèle', value: `${ctx.info.provider} / ${ctx.info.model}` });
        entries.push({ label: 'Dossiers accessibles', value: ctx.scope.describe() });
      }
      if (entries.length === 0) return { result: 'Toutes les catégories d’information sont désactivées par l’utilisateur.' };
      return { display: { kind: 'info', entries }, result: entries.map((e) => `${e.label} : ${e.value}`).join('\n') };
    },
  },
  {
    name: 'ask_user',
    family: 'questions',
    skill: 'questions',
    description:
      'Pose une ou plusieurs questions à l’utilisateur et attend ses réponses. kind: "single" (par défaut avec options), "multiple" (uniquement si plusieurs choix sont explicitement attendus) ou "text". allow_custom autorise une réponse libre en plus des options.',
    parameters: obj(
      {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              kind: { type: 'string', enum: ['single', 'multiple', 'text'] },
              options: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' } }, required: ['label'] }] } },
              allow_custom: { type: 'boolean' },
            },
            required: ['prompt'],
          },
        },
      },
      ['questions'],
    ),
    effects: ['interact'],
    target: () => ({ label: null, resources: [] }),
    async execute(args, ctx) {
      const raw = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[]) : [];
      if (raw.length === 0 || raw.length > 10) throw new Error('Entre 1 et 10 questions');
      const questions: Question[] = raw.map((q, i) => {
        const options = Array.isArray(q.options)
          ? (q.options as unknown[]).slice(0, 12).map((o, j) => (typeof o === 'string' ? { id: `o${j + 1}`, label: o } : { id: `o${j + 1}`, label: String((o as Record<string, unknown>).label ?? ''), ...((o as Record<string, unknown>).description ? { description: String((o as Record<string, unknown>).description) } : {}), ...((o as Record<string, unknown>).icon ? { icon: String((o as Record<string, unknown>).icon) } : {}) }))
          : [];
        const kind = q.kind === 'multiple' || q.kind === 'text' ? q.kind : options.length ? 'single' : 'text';
        return { id: `q${i + 1}`, prompt: String(q.prompt ?? ''), kind, ...(options.length ? { options } : {}), ...(q.allow_custom === true ? { allowCustom: true } : {}) };
      });
      const answers = await ctx.ask(questions);
      if (!answers) return { display: { kind: 'question', questions, answers: null, cancelled: true }, result: 'L’utilisateur a annulé les questions sans répondre (ce n’est pas une approbation). Ne présumez pas de sa réponse.' };
      const lines = questions.map((q) => {
        const a = answers.find((x) => x.questionId === q.id);
        const chosen = (a?.optionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label).filter(Boolean);
        return `${q.prompt}\n→ ${[...chosen, ...(a?.text ? [a.text] : [])].join(', ') || '(sans réponse)'}`;
      });
      return { display: { kind: 'question', questions, answers, cancelled: false }, result: `Réponses de l’utilisateur :\n${lines.join('\n\n')}` };
    },
  },
  {
    name: 'propose_actions',
    family: 'actions',
    skill: 'actions',
    description:
      'Propose à l’utilisateur des boutons d’action. kind: "continue" (poursuivre ici), "agent" (lancer un agent dans une nouvelle discussion), "new_chat" (nouvelle discussion), "queue" (mettre une tâche en file). Chaque proposition contient une consigne autonome. Rien ne démarre avant le clic.',
    parameters: obj(
      { actions: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['continue', 'agent', 'new_chat', 'queue'] }, title: { type: 'string' }, instructions: { type: 'string' } }, required: ['kind', 'title', 'instructions'] } } },
      ['actions'],
    ),
    effects: ['interact'],
    target: () => ({ label: null, resources: [] }),
    async execute(args) {
      const raw = Array.isArray(args.actions) ? (args.actions as Record<string, unknown>[]) : [];
      if (raw.length === 0 || raw.length > 6) throw new Error('Entre 1 et 6 propositions');
      const actions: ActionProposal[] = raw.map((a) => ({
        id: randomUUID().slice(0, 8),
        kind: ['continue', 'agent', 'new_chat', 'queue'].includes(String(a.kind)) ? (a.kind as ActionProposal['kind']) : 'continue',
        title: String(a.title ?? '').slice(0, 120),
        instructions: String(a.instructions ?? '').slice(0, 20_000),
        triggered: false,
      }));
      return { display: { kind: 'actions', actions }, result: 'Propositions affichées à l’utilisateur. Rien ne démarre avant son clic ; terminez votre réponse.' };
    },
  },
  {
    name: 'update_plan',
    family: 'planning',
    skill: 'planning',
    description: 'Publie ou met à jour le plan de travail (étapes et statut : pending, in_progress, done).',
    parameters: obj({ items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'] } } }, ['items']),
    effects: ['interact'],
    target: () => ({ label: null, resources: [] }),
    async execute(args) {
      const items: PlanItem[] = (Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : []).slice(0, 50).map((i) => ({
        text: String(i.text ?? '').slice(0, 300),
        status: i.status === 'done' || i.status === 'in_progress' ? i.status : 'pending',
      }));
      return { display: { kind: 'plan', items }, result: `Plan mis à jour (${items.filter((i) => i.status === 'done').length}/${items.length} étapes terminées).` };
    },
  },
];

export const BUILTIN_TOOLS: ToolDefinition[] = [...interactTools, ...sourcesTools, ...editTools, ...terminalTools];

/** Skills d'instructions : pas d'outil, des consignes ajoutées en mode Agent. */
export const INSTRUCTION_SKILLS: Record<string, string> = {
  planning: 'Planification : pour une tâche en plusieurs étapes, publiez d’abord un plan avec update_plan, puis tenez-le à jour.',
  summary: 'Synthèse : terminez une tâche longue par un récapitulatif bref (ce qui a été fait, ce qui reste, comment vérifier).',
  review:
    'Revue de code : lorsque l’on vous demande une revue, lisez les fichiers concernés, signalez les défauts concrets (bugs, sécurité, cas limites) avec fichier et ligne, classés par gravité, sans réécrire le code sans demande.',
  design:
    'Conception complète : pour un nouveau projet, posez d’abord les questions de cadrage (ask_user), proposez des choix techniques et visuels, planifiez, implémentez par étapes, testez et vérifiez le rendu.',
};

export function readSnippet(path: string): string {
  return readText(path).slice(0, 2000);
}

export type { QuestionAnswer };
