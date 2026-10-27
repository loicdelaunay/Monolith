import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { CustomSkill, Settings } from '@monolith/contracts';
import type { RagService } from '../services/rag.ts';
import type { ToolContext, ToolDefinition } from './types.ts';
import { limit, num, str } from './types.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ---------------------------------------------------------------------------
// RAG
// ---------------------------------------------------------------------------

export function ragTools(rag: () => RagService): ToolDefinition[] {
  return [
    {
      name: 'rag_search',
      family: 'rag',
      skill: 'rag',
      description: 'Recherche sémantique/lexicale dans l’index RAG des ressources de la conversation ; renvoie des extraits avec chemin et lignes. Indexez d’abord avec rag_index si l’index est vide ou périmé.',
      parameters: obj({ query: { type: 'string' }, k: { type: 'number' } }, ['query']),
      effects: ['read'],
      target: (a) => ({ label: str(a, 'query', false), resources: [] }),
      async execute(args, ctx) {
        const hits = await rag().search(ctx.scope.roots, str(args, 'query'), Math.min(30, Math.max(1, num(args, 'k', ctx.settings.rag.topK))), ctx.signal);
        if (!hits.length) return { result: 'Aucun extrait trouvé (index vide ou sans correspondance : utilisez rag_index puis réessayez).' };
        const text = hits.map((h) => `--- ${ctx.scope.display(join(h.root, h.path))}:${h.startLine}-${h.endLine}\n${h.text}`).join('\n\n');
        return { result: limit(text, ctx.settings.agent.maxResultChars), display: { kind: 'list', title: 'Extraits RAG', items: hits.map((h) => `${h.path}:${h.startLine}-${h.endLine}`), truncated: false } };
      },
    },
    {
      name: 'rag_sources',
      family: 'rag',
      skill: 'rag',
      description: 'État de l’index RAG : dossiers indexés, fichiers, fragments, fichiers modifiés depuis l’indexation.',
      parameters: obj({}),
      effects: ['read'],
      target: () => ({ label: null, resources: [] }),
      async execute(_args, ctx) {
        const s = rag().status(ctx.conversationId, ctx.scope.roots);
        const lines = s.roots.map((r) => `${r.root} : ${r.files} fichier(s), ${r.chunks} fragment(s)${r.stale ? `, ${r.stale} modifié(s) depuis l’indexation` : ''}${r.embeddingModel ? `, embeddings ${r.embeddingModel}` : ', lexical'}${r.indexedAt ? `, indexé le ${r.indexedAt.slice(0, 16)}` : ', jamais indexé'}`);
        return { result: lines.join('\n') || 'Aucune ressource.' };
      },
    },
    {
      name: 'rag_index',
      family: 'rag',
      skill: 'rag',
      description: 'Indexe (ou met à jour) les ressources de la conversation pour rag_search. Seuls les fichiers modifiés sont retraités.',
      parameters: obj({}),
      effects: ['read', 'network'],
      target: (_a, ctx) => ({ label: ctx.scope.roots.map((r) => ctx.scope.display(r)).join(', '), resources: ctx.scope.roots }),
      async execute(_args, ctx) {
        const onAbort = () => rag().cancel(ctx.conversationId);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const s = await rag().index(ctx.conversationId, ctx.scope.roots);
          return { result: s.roots.map((r) => `${ctx.scope.display(r.root)} : ${r.files} fichier(s), ${r.chunks} fragment(s)`).join('\n') };
        } finally {
          ctx.signal.removeEventListener('abort', onAbort);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Skills personnalisés (SKILL.md)
// ---------------------------------------------------------------------------

/** En-tête YAML simple (`name`, `description`) puis instructions Markdown. */
export function parseSkillFile(md: string): { name: string; description: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  const field = (k: string) => {
    const v = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]!)?.[1]?.trim() ?? '';
    return v.replace(/^(["'])([\s\S]*)\1$/, '$2');
  };
  const name = field('name');
  if (!/^[\w.-]{1,64}$/.test(name)) return null;
  return { name, description: field('description').slice(0, 1000), body: m[2]! };
}

const PROJECT_DIRS = [join('.monolith', 'skills'), join('.claude', 'skills')];

/** Skills disponibles : dossier global de l'application puis dossiers des ressources (le projet l'emporte). */
export function discoverSkills(globalDir: string, roots: string[], settings: Settings): CustomSkill[] {
  const found = new Map<string, CustomSkill>();
  const scan = (dir: string, scope: CustomSkill['scope']) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const parsed = parseSkillFile(readFileSync(file, 'utf8'));
        if (parsed) found.set(parsed.name, { name: parsed.name, description: parsed.description, scope, path: join(dir, name), enabled: settings.skills.enabled[`skill:${parsed.name}`] ?? true });
      } catch {
        /* skill illisible : ignoré */
      }
    }
  };
  scan(globalDir, 'global');
  for (const root of roots) for (const d of PROJECT_DIRS) scan(join(root, d), 'project');
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillTools(globalDir: string): ToolDefinition[] {
  const find = (ctx: ToolContext, name: string) => {
    const s = discoverSkills(globalDir, ctx.scope.roots, ctx.settings).find((x) => x.name === name && x.enabled);
    if (!s) throw new Error(`Skill « ${name} » introuvable ou désactivé.`);
    return s;
  };
  return [
    {
      name: 'load_skill',
      family: 'skills',
      skill: 'custom_skills',
      description: 'Charge les instructions complètes d’un skill personnalisé (SKILL.md) et la liste de ses ressources. À faire avant d’appliquer un skill.',
      parameters: obj({ name: { type: 'string' } }, ['name']),
      effects: ['read'],
      target: (a) => ({ label: str(a, 'name', false), resources: [] }),
      async execute(args, ctx) {
        const s = find(ctx, str(args, 'name'));
        const md = readFileSync(join(s.path, 'SKILL.md'), 'utf8');
        const files: string[] = [];
        const visit = (dir: string) => {
          for (const n of readdirSync(dir)) {
            const full = join(dir, n);
            if (statSync(full).isDirectory()) visit(full);
            else if (n !== 'SKILL.md' && files.length < 200) files.push(relative(s.path, full).split(sep).join('/'));
          }
        };
        visit(s.path);
        return { result: limit(`${md}\n\nRessources du skill (read_skill_resource) : ${files.join(', ') || 'aucune'}`, ctx.settings.agent.maxResultChars) };
      },
    },
    {
      name: 'read_skill_resource',
      family: 'skills',
      skill: 'custom_skills',
      description: 'Lit un fichier de ressource d’un skill personnalisé (chemin relatif au dossier du skill).',
      parameters: obj({ name: { type: 'string' }, path: { type: 'string' } }, ['name', 'path']),
      effects: ['read'],
      target: (a) => ({ label: `${str(a, 'name', false)}/${str(a, 'path', false)}`, resources: [] }),
      async execute(args, ctx) {
        const s = find(ctx, str(args, 'name'));
        const full = resolve(s.path, str(args, 'path'));
        if (!full.startsWith(resolve(s.path) + sep)) throw new Error('Chemin hors du dossier du skill.');
        const buf = readFileSync(full);
        if (buf.includes(0)) throw new Error('Fichier binaire : lecture refusée.');
        return { result: limit(buf.toString('utf8'), ctx.settings.agent.maxResultChars) };
      },
    },
    {
      name: 'create_skill',
      family: 'skills',
      skill: 'custom_skills',
      description: 'Crée un skill personnalisé (SKILL.md) réutilisable : portée « project » (dans .monolith/skills de la première ressource) ou « global » (tous les projets).',
      parameters: obj({ name: { type: 'string', description: 'Lettres, chiffres, tirets' }, description: { type: 'string' }, instructions: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] } }, ['name', 'description', 'instructions']),
      effects: ['write'],
      target: (a) => ({ label: `${str(a, 'scope', false) || 'project'} : ${str(a, 'name', false)}`, resources: [] }),
      async execute(args, ctx) {
        const name = str(args, 'name').trim();
        if (!/^[\w.-]{1,64}$/.test(name)) throw new Error('Nom invalide (lettres, chiffres, points, tirets).');
        const scope = str(args, 'scope', false) === 'global' ? 'global' : 'project';
        let dir: string;
        if (scope === 'global') dir = join(globalDir, name);
        else {
          const root = ctx.scope.roots[0];
          if (!root) throw new Error('Aucune ressource pour un skill de projet.');
          dir = ctx.scope.resolve(join(root, '.monolith', 'skills', name), { write: true });
        }
        if (existsSync(join(dir, 'SKILL.md'))) throw new Error(`Le skill « ${name} » existe déjà.`);
        mkdirSync(dir, { recursive: true });
        const desc = str(args, 'description').replace(/[\r\n]+/g, ' ').trim();
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${str(args, 'instructions').trim()}\n`, 'utf8');
        return { result: `Skill « ${name} » créé (${scope}) : ${dir}` };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

let pythonCache: { cmd: string; args: string[]; version: string } | null | undefined;

/** Interpréteur Python du poste (py -3, python3, python), détecté une fois. */
export async function detectPython(): Promise<{ cmd: string; args: string[]; version: string } | null> {
  if (pythonCache !== undefined) return pythonCache;
  const candidates: [string, string[]][] = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidates) {
    const version = await new Promise<string | null>((r) => execFile(cmd, [...args, '--version'], { timeout: 5000, windowsHide: true }, (e, out, err) => r(e ? null : `${out}${err}`.trim())));
    // Le lanceur Microsoft Store affiche un message sans exécuter Python : seule une version valide compte.
    if (version && /^Python 3\.\d+/.test(version)) return (pythonCache = { cmd, args, version });
  }
  return (pythonCache = null);
}

const quote = (s: string) => (process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);

export const PYTHON_TOOLS: ToolDefinition[] = [
  {
    name: 'python_info',
    family: 'python',
    skill: 'python',
    description: 'Indique l’interpréteur Python disponible sur ce poste (version et commande).',
    parameters: obj({}),
    effects: ['read'],
    target: () => ({ label: null, resources: [] }),
    async execute() {
      const py = await detectPython();
      return { result: py ? `${py.version} (${[py.cmd, ...py.args].join(' ')})` : 'Aucun Python 3 détecté (py, python3, python). Installez Python pour utiliser python_run.' };
    },
  },
  {
    name: 'python_run',
    family: 'python',
    skill: 'python',
    description: 'Exécute un script Python (code fourni) dans le dossier de la conversation, avec délai ; renvoie la sortie et le code de retour.',
    parameters: obj({ code: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_sec: { type: 'number' } }, ['code']),
    effects: ['exec'],
    target: (a) => ({ label: str(a, 'code', false).split('\n').find((l) => l.trim())?.slice(0, 80) ?? 'python', resources: ['python'] }),
    async execute(args, ctx) {
      const py = await detectPython();
      if (!py) throw new Error('Aucun Python 3 détecté sur ce poste.');
      const dir = join(tmpdir(), 'monolith-python');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `script-${ctx.conversationId}-${Date.now()}.py`);
      writeFileSync(file, str(args, 'code'), 'utf8');
      const cwd = ctx.scope.resolve(str(args, 'cwd', false) || '.');
      const extra = Array.isArray(args.args) ? args.args.map((a) => quote(String(a))) : [];
      const command = `${process.platform === 'win32' ? '& ' : ''}${[py.cmd, ...py.args].join(' ')} ${quote(file)} ${extra.join(' ')}`.trim();
      const timeout = Math.min(ctx.settings.agent.commandTimeoutSec, Math.max(1, num(args, 'timeout_sec', ctx.settings.agent.commandTimeoutSec))) * 1000;
      const session = ctx.terminals.start(ctx.conversationId, command, cwd);
      await ctx.terminals.wait(session.info.id, timeout, ctx.signal);
      const info = session.info;
      const output = ctx.terminals.output(info.id);
      return {
        result: limit(`${info.status === 'running' ? `Script toujours en cours (terminal ${info.id}).` : `Code de retour : ${info.exitCode}`}\n${output}`, ctx.settings.agent.maxResultChars),
        display: { kind: 'command', command: `python ${file}`, cwd, output, exitCode: info.exitCode, status: info.status, terminalId: info.id },
        status: info.exitCode !== null && info.exitCode !== 0 ? 'error' : 'done',
      };
    },
  },
];
