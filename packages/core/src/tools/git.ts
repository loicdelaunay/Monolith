import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { HarnessError } from '@monolith/contracts';
import type { ToolContext, ToolDefinition } from './types.ts';
import { limit, str } from './types.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exécute git sans shell (arguments passés tels quels), avec délai et annulation. */
export function runGit(cwd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60_000);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new HarnessError('unavailable', `git introuvable ou inutilisable : ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

let gitAvailable: Promise<boolean> | null = null;
export function hasGit(): Promise<boolean> {
  gitAvailable ??= runGit(process.cwd(), ['--version'], { timeoutMs: 5000 })
    .then((r) => r.code === 0)
    .catch(() => false);
  return gitAvailable;
}

/** Racine du dépôt contenant `dir`, ou null. */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await runGit(dir, ['rev-parse', '--show-toplevel']).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim().replace(/\//g, sep) : null;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const r = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (r.code !== 0) throw new HarnessError('invalid_argument', r.stderr.trim() || 'git status a échoué');
  const status: GitStatus = { root, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]!;
    if (line.startsWith('# branch.head ')) status.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) status.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ');
      status.files.push({ path: parts.slice(8).join(' '), index: parts[1]![0]!, worktree: parts[1]![1]! });
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ');
      status.files.push({ path: parts.slice(9).join(' '), index: parts[1]![0]!, worktree: parts[1]![1]! });
      i++; // chemin d'origine du renommage
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      status.files.push({ path: parts.slice(10).join(' '), index: 'U', worktree: 'U' });
    } else if (line.startsWith('? ')) status.files.push({ path: line.slice(2), index: '?', worktree: '?' });
  }
  return status;
}

/** Contenu d'un fichier à une révision (`HEAD`, index `:`), vide s'il n'existe pas. */
export async function gitShow(root: string, rev: 'HEAD' | 'index', path: string): Promise<string> {
  const spec = rev === 'index' ? `:${path}` : `HEAD:${path}`;
  const r = await runGit(root, ['show', spec]);
  return r.code === 0 ? r.stdout : '';
}

/** Versions avant/après d'un fichier pour l'affichage d'un diff. */
export async function gitFileVersions(root: string, path: string, staged: boolean): Promise<{ before: string; after: string }> {
  if (staged) return { before: await gitShow(root, 'HEAD', path), after: await gitShow(root, 'index', path) };
  const full = join(root, path);
  const index = await gitShow(root, 'index', path);
  const before = index || (await gitShow(root, 'HEAD', path));
  return { before, after: existsSync(full) ? readFileSync(full, 'utf8') : '' };
}

/** Dépôt de la conversation : premier dépôt trouvé parmi les racines (ou celui demandé). */
async function resolveRepo(ctx: ToolContext, path: unknown): Promise<string> {
  const dir = ctx.scope.resolve(path ?? '.');
  const root = await repoRoot(dir);
  if (!root) throw new Error(`Aucun dépôt Git dans ${ctx.scope.display(dir)}`);
  // Le dépôt doit lui-même être dans la portée (pas de remontée vers un dépôt parent hors portée).
  ctx.scope.resolve(root);
  return root;
}

function relPaths(ctx: ToolContext, root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('« paths » doit être une liste non vide');
  return paths.map((p) => relative(root, ctx.scope.resolve(p, { write: true })).split(sep).join('/'));
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const repoArg = { repo: { type: 'string', description: 'Dossier du dépôt (par défaut : la racine)' } };
const target = (a: Record<string, unknown>, ctx: ToolContext) => {
  try {
    const dir = ctx.scope.resolve(a.repo ?? '.');
    return { label: ctx.scope.display(dir), resources: [dir, ctx.scope.display(dir)] };
  } catch {
    return { label: null, resources: [] };
  }
};

async function gitTool(ctx: ToolContext, repo: unknown, args: string[], network = false): Promise<{ result: string }> {
  const root = await resolveRepo(ctx, repo);
  const r = await runGit(root, args, { signal: ctx.signal, timeoutMs: network ? 180_000 : 60_000 });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  if (r.code !== 0) throw new Error(`git ${args[0]} a échoué (code ${r.code}) : ${out || 'aucune sortie'}`);
  return { result: limit(out || `git ${args[0]} : terminé.`, ctx.settings.agent.maxResultChars) };
}

export const GIT_TOOLS: ToolDefinition[] = [
  {
    name: 'git_status',
    family: 'git',
    skill: 'git',
    description: 'État du dépôt Git : branche, avance/retard, fichiers modifiés, indexés, non suivis.',
    parameters: obj(repoArg),
    effects: ['read'],
    target,
    async execute(args, ctx) {
      const s = await gitStatus(await resolveRepo(ctx, args.repo));
      const lines = s.files.map((f) => `${f.index}${f.worktree} ${f.path}`);
      return {
        display: { kind: 'list', title: `${s.branch ?? '(HEAD détachée)'}${s.upstream ? ` → ${s.upstream} (+${s.ahead}/−${s.behind})` : ''}`, items: lines, truncated: false },
        result: `Branche : ${s.branch ?? '(détachée)'}${s.upstream ? `, suivi ${s.upstream}, avance ${s.ahead}, retard ${s.behind}` : ''}\n${lines.join('\n') || 'Arbre de travail propre.'}`,
      };
    },
  },
  {
    name: 'git_diff',
    family: 'git',
    skill: 'git',
    description: 'Différences non indexées (ou indexées avec staged=true), éventuellement pour un chemin.',
    parameters: obj({ ...repoArg, path: { type: 'string' }, staged: { type: 'boolean' } }),
    effects: ['read'],
    target,
    async execute(args, ctx) {
      const root = await resolveRepo(ctx, args.repo);
      const extra = typeof args.path === 'string' ? ['--', relative(root, ctx.scope.resolve(args.path)).split(sep).join('/')] : [];
      return gitTool(ctx, args.repo, ['diff', ...(args.staged === true ? ['--cached'] : []), '--no-ext-diff', ...extra]);
    },
  },
  {
    name: 'git_log',
    family: 'git',
    skill: 'git',
    description: 'Historique récent des commits (hash, auteur, date, message).',
    parameters: obj({ ...repoArg, limit: { type: 'number' }, path: { type: 'string' } }),
    effects: ['read'],
    target,
    async execute(args, ctx) {
      const n = Math.min(200, Math.max(1, Number(args.limit) || 20));
      return gitTool(ctx, args.repo, ['log', `-n${n}`, '--date=iso-strict', '--pretty=format:%h %ad %an : %s', ...(typeof args.path === 'string' ? ['--', str(args, 'path')] : [])]);
    },
  },
  {
    name: 'git_branches',
    family: 'git',
    skill: 'git',
    description: 'Branches locales et distantes.',
    parameters: obj(repoArg),
    effects: ['read'],
    target,
    async execute(args, ctx) {
      return gitTool(ctx, args.repo, ['branch', '-a', '-vv']);
    },
  },
  {
    name: 'git_stage',
    family: 'git',
    skill: 'git',
    description: 'Ajoute des fichiers à l’index (git add).',
    parameters: obj({ ...repoArg, paths: { type: 'array', items: { type: 'string' } } }, ['paths']),
    effects: ['write'],
    target,
    async execute(args, ctx) {
      const root = await resolveRepo(ctx, args.repo);
      return gitTool(ctx, args.repo, ['add', '--', ...relPaths(ctx, root, args.paths)]);
    },
  },
  {
    name: 'git_unstage',
    family: 'git',
    skill: 'git',
    description: 'Retire des fichiers de l’index sans toucher à l’arbre de travail.',
    parameters: obj({ ...repoArg, paths: { type: 'array', items: { type: 'string' } } }, ['paths']),
    effects: ['write'],
    target,
    async execute(args, ctx) {
      const root = await resolveRepo(ctx, args.repo);
      return gitTool(ctx, args.repo, ['restore', '--staged', '--', ...relPaths(ctx, root, args.paths)]);
    },
  },
  {
    name: 'git_commit',
    family: 'git',
    skill: 'git',
    description: 'Crée un commit avec les changements indexés.',
    parameters: obj({ ...repoArg, message: { type: 'string' } }, ['message']),
    effects: ['write'],
    target: (a, ctx) => ({ label: str(a, 'message', false).split('\n')[0]!.slice(0, 80), resources: target(a, ctx).resources }),
    async execute(args, ctx) {
      const message = str(args, 'message').trim();
      if (!message) throw new Error('Message de commit vide');
      const root = await resolveRepo(ctx, args.repo);
      const r = await runGit(root, ['commit', '-F', '-'], { input: message, signal: ctx.signal });
      if (r.code !== 0) throw new Error(`git commit a échoué : ${(r.stdout + r.stderr).trim()}`);
      return { result: r.stdout.trim() };
    },
  },
  {
    name: 'git_switch',
    family: 'git',
    skill: 'git',
    description: 'Change de branche (create=true pour la créer).',
    parameters: obj({ ...repoArg, branch: { type: 'string' }, create: { type: 'boolean' } }, ['branch']),
    effects: ['write'],
    target: (a, ctx) => ({ label: str(a, 'branch', false), resources: target(a, ctx).resources }),
    async execute(args, ctx) {
      const branch = str(args, 'branch');
      if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Nom de branche invalide');
      return gitTool(ctx, args.repo, ['switch', ...(args.create === true ? ['-c'] : []), branch]);
    },
  },
  ...(['fetch', 'pull', 'push'] as const).map(
    (op): ToolDefinition => ({
      name: `git_${op}`,
      family: 'git',
      skill: 'git',
      description: op === 'fetch' ? 'Récupère les références distantes.' : op === 'pull' ? 'Intègre les changements distants (fast-forward uniquement).' : 'Envoie la branche courante vers son dépôt distant.',
      parameters: obj(repoArg),
      effects: op === 'fetch' ? ['network'] : ['network', 'write'],
      target,
      async execute(args, ctx) {
        return gitTool(ctx, args.repo, op === 'pull' ? ['pull', '--ff-only'] : op === 'push' ? ['push'] : ['fetch', '--prune'], true);
      },
    }),
  ),
];
