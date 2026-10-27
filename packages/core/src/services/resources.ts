import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HarnessError, type ConversationResource, type Id, type ResourceScopeInfo } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { ProjectService } from './projects.ts';
import { ResourceScope } from '../tools/scope.ts';
import { now } from '../util.ts';

interface ResourceRow {
  id: number;
  conversation_id: number;
  kind: string;
  path: string;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.monolith/instructions.md'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', 'target', '.next', '.cache']);
const MAX_INSTRUCTION_BYTES = 64 * 1024;

function readable(path: string, dir: boolean): boolean {
  try {
    const st = statSync(path);
    if (dir ? !st.isDirectory() : !st.isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ressources d'une conversation : héritées du projet (par défaut) ou propres à la conversation.
 * Une conversation sans dossier dispose d'un espace privé persistant `workspace/conversations/<id>`.
 * Un fichier joint donne accès à ce seul fichier, jamais à son dossier parent.
 */
export class ResourceService {
  constructor(
    private readonly db: Database,
    private readonly projects: ProjectService,
    private readonly conversationsDir: string,
    /** Chemins jamais accessibles aux outils (base, clés, journaux de l'application). */
    private readonly forbidden: string[],
  ) {}

  privateDir(conversationId: Id): string {
    return join(this.conversationsDir, String(conversationId));
  }

  private mode(conversationId: Id): { mode: 'inherit' | 'custom'; projectId: Id | null } {
    const row = this.db.get<{ resources_mode: string; project_id: number | null }>('SELECT resources_mode, project_id FROM conversations WHERE id = ?', conversationId);
    if (!row) throw new HarnessError('not_found', `Conversation ${conversationId} introuvable`);
    return { mode: row.resources_mode === 'custom' ? 'custom' : 'inherit', projectId: row.project_id };
  }

  private items(conversationId: Id): ConversationResource[] {
    return this.db
      .all<ResourceRow>('SELECT * FROM conversation_resources WHERE conversation_id = ? ORDER BY id', conversationId)
      .map((r) => ({ id: r.id, kind: r.kind === 'file' ? 'file' : 'folder', path: r.path, available: readable(r.path, r.kind !== 'file') }));
  }

  /** Portée effective : dossiers (projet ou conversation), fichiers isolés, espace privé si aucun dossier. */
  scope(conversationId: Id): { scope: ResourceScope; info: Omit<ResourceScopeInfo, 'instructionFiles'> } {
    const { mode, projectId } = this.mode(conversationId);
    const items = this.items(conversationId);
    let folders: string[];
    let files: string[] = [];
    if (mode === 'custom') {
      folders = items.filter((i) => i.kind === 'folder' && i.available).map((i) => i.path);
      files = items.filter((i) => i.kind === 'file' && i.available).map((i) => i.path);
    } else {
      folders = projectId !== null ? this.projects.get(projectId).folders.filter((f) => f.available).map((f) => f.path) : [];
    }
    const privateDir = this.privateDir(conversationId);
    if (folders.length === 0) {
      mkdirSync(privateDir, { recursive: true });
      folders = [privateDir];
    }
    return { scope: new ResourceScope(folders, files, this.forbidden), info: { mode, items, roots: folders, files, privateDir } };
  }

  get(conversationId: Id, readInstructions: boolean): ResourceScopeInfo {
    const { info } = this.scope(conversationId);
    return { ...info, instructionFiles: readInstructions ? this.instructionFiles(info.roots).map(({ path, scope }) => ({ path, scope })) : [] };
  }

  add(conversationId: Id, kind: 'folder' | 'file', path: string): void {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new HarnessError('invalid_argument', 'Chemin absolu attendu');
    const full = resolve(path);
    if (!readable(full, kind === 'folder')) throw new HarnessError('invalid_argument', `${kind === 'folder' ? 'Dossier' : 'Fichier'} inaccessible : ${full}`);
    const { mode, projectId } = this.mode(conversationId);
    this.db.transaction(() => {
      // Passage en ressources propres : les dossiers du projet sont repris pour ne rien retirer implicitement.
      if (mode === 'inherit') {
        if (projectId !== null) {
          for (const f of this.projects.get(projectId).folders) {
            this.db.run('INSERT OR IGNORE INTO conversation_resources (conversation_id, kind, path, created_at) VALUES (?, ?, ?, ?)', conversationId, 'folder', f.path, now());
          }
        }
        this.db.run("UPDATE conversations SET resources_mode = 'custom' WHERE id = ?", conversationId);
      }
      this.db.run('INSERT OR IGNORE INTO conversation_resources (conversation_id, kind, path, created_at) VALUES (?, ?, ?, ?)', conversationId, kind, full, now());
    });
  }

  remove(conversationId: Id, resourceId: Id): void {
    const r = this.db.run('DELETE FROM conversation_resources WHERE id = ? AND conversation_id = ?', resourceId, conversationId);
    if (!r.changes) throw new HarnessError('not_found', 'Ressource introuvable');
    this.db.run("UPDATE conversations SET resources_mode = 'custom' WHERE id = ?", conversationId);
  }

  /** Retour aux ressources par défaut du projet. */
  reset(conversationId: Id): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM conversation_resources WHERE conversation_id = ?', conversationId);
      this.db.run("UPDATE conversations SET resources_mode = 'inherit' WHERE id = ?", conversationId);
    });
  }

  /**
   * Fichiers d'instructions des racines et de leurs sous-dossiers (profondeur 3), avec leur portée
   * explicite : chacun ne s'applique qu'au dossier qui le contient.
   */
  instructionFiles(roots: string[]): { path: string; scope: string; content: string }[] {
    const found: { path: string; scope: string; content: string }[] = [];
    const visit = (dir: string, root: string, depth: number) => {
      for (const name of INSTRUCTION_FILES) {
        const p = join(dir, name);
        if (existsSync(p) && readable(p, false)) {
          const rel = relative(root, dir).split(sep).join('/') || '.';
          const content = readFileSync(p).subarray(0, MAX_INSTRUCTION_BYTES).toString('utf8');
          found.push({ path: p, scope: rel === '.' ? root : `${root}${sep}${rel}`, content });
        }
      }
      if (depth >= 3 || found.length >= 20) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
        const sub = join(dir, e);
        if (readable(sub, true)) visit(sub, root, depth + 1);
      }
    };
    for (const root of roots) visit(root, root, 0);
    return found;
  }
}
