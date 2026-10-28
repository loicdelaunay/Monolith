import { accessSync, constants, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { ATTACHMENT_LIMITS, HarnessError, type AttachmentKind, type Id, type Project, type ProjectFolder, type ProjectInput } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface ProjectRow {
  id: number;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: number;
  project_id: number;
  path: string;
  label: string;
  sort_order: number;
}

const MAX_NAME = 120;
const MAX_INSTRUCTIONS = 100_000;

interface AttachmentRow {
  project_id: number;
  id: number;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

function folderAvailable(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  list(): Project[] {
    const rows = this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY sort_order, id');
    const folders = this.db.all<FolderRow>('SELECT * FROM project_folders ORDER BY sort_order, id');
    const attachments = this.attachmentRows(null);
    return rows.map((r) => this.map(r, folders.filter((f) => f.project_id === r.id), attachments.filter((a) => a.project_id === r.id)));
  }

  private attachmentRows(projectId: Id | null): AttachmentRow[] {
    const sql = 'SELECT pa.project_id, a.id, a.name, a.mime, a.size, a.kind FROM project_attachments pa JOIN attachments a ON a.id = pa.attachment_id';
    return projectId === null ? this.db.all<AttachmentRow>(`${sql} ORDER BY pa.sort_order, a.id`) : this.db.all<AttachmentRow>(`${sql} WHERE pa.project_id = ? ORDER BY pa.sort_order, a.id`, projectId);
  }

  /** Rattache des pièces jointes déjà validées par le service des pièces jointes (20 au plus par projet). */
  addAttachments(id: Id, attachmentIds: unknown): Project {
    const project = this.get(id);
    if (!Array.isArray(attachmentIds)) throw new HarnessError('invalid_argument', 'Liste de pièces jointes invalide');
    const ids = [...new Set(attachmentIds.map(Number))].filter((a) => !project.attachments.some((x) => x.id === a));
    if (project.attachments.length + ids.length > ATTACHMENT_LIMITS.perProject) throw new HarnessError('invalid_argument', `${ATTACHMENT_LIMITS.perProject} pièces jointes maximum par projet`);
    let order = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM project_attachments WHERE project_id = ?', id)?.m ?? 0;
    for (const a of ids) if (!Number.isInteger(a) || !this.db.get('SELECT 1 AS x FROM attachments WHERE id = ?', a)) throw new HarnessError('not_found', `Pièce jointe ${a} introuvable`);
    for (const a of ids) this.db.run('INSERT INTO project_attachments (project_id, attachment_id, sort_order) VALUES (?, ?, ?)', id, a, ++order);
    this.changed();
    return this.get(id);
  }

  removeAttachment(id: Id, attachmentId: Id): Project {
    this.get(id);
    this.db.run('DELETE FROM project_attachments WHERE project_id = ? AND attachment_id = ?', id, attachmentId);
    this.changed();
    return this.get(id);
  }

  get(id: Id): Project {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    if (!row) throw new HarnessError('not_found', `Projet ${id} introuvable`);
    return this.map(row, this.db.all<FolderRow>('SELECT * FROM project_folders WHERE project_id = ? ORDER BY sort_order, id', id), this.attachmentRows(id));
  }

  exists(id: Id): boolean {
    return this.db.get('SELECT 1 AS x FROM projects WHERE id = ?', id) !== undefined;
  }

  create(input: ProjectInput): Project {
    const name = cleanName(input.name);
    const t = now();
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM projects')?.m ?? 0;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO projects (name, icon, color, instructions, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name,
      cleanIcon(input.icon),
      cleanColor(input.color),
      cleanInstructions(input.instructions),
      max + 1,
      t,
      t,
    );
    if (input.attachmentIds?.length) return this.addAttachments(lastInsertRowid, input.attachmentIds);
    this.changed();
    return this.get(lastInsertRowid);
  }

  update(id: Id, patch: Partial<ProjectInput>): Project {
    const current = this.get(id);
    this.db.run(
      'UPDATE projects SET name = ?, icon = ?, color = ?, instructions = ?, updated_at = ? WHERE id = ?',
      patch.name !== undefined ? cleanName(patch.name) : current.name,
      patch.icon !== undefined ? cleanIcon(patch.icon) : current.icon,
      patch.color !== undefined ? cleanColor(patch.color) : current.color,
      patch.instructions !== undefined ? cleanInstructions(patch.instructions) : current.instructions,
      now(),
      id,
    );
    this.changed();
    return this.get(id);
  }

  /**
   * Supprime le projet. Ses conversations sont supprimées (`deleteConversations`) ou déplacées
   * dans l'espace personnel. Les dossiers sources sur disque ne sont jamais touchés.
   */
  delete(id: Id, deleteConversations: boolean): Id[] {
    this.get(id);
    const ids = this.db.all<{ id: number }>('SELECT id FROM conversations WHERE project_id = ?', id).map((r) => r.id);
    this.db.transaction(() => {
      if (deleteConversations) this.db.run('DELETE FROM conversations WHERE project_id = ?', id);
      else this.db.run('UPDATE conversations SET project_id = NULL, updated_at = ? WHERE project_id = ?', now(), id);
      this.db.run('DELETE FROM projects WHERE id = ?', id);
    });
    this.changed();
    return ids;
  }

  reorder(ids: Id[]): void {
    if (!Array.isArray(ids)) throw new HarnessError('invalid_argument', 'Liste d’identifiants attendue');
    this.db.transaction(() => {
      ids.forEach((pid, index) => this.db.run('UPDATE projects SET sort_order = ? WHERE id = ?', index + 1, pid));
    });
    this.changed();
  }

  addFolder(id: Id, path: string, label?: string): Project {
    this.get(id);
    if (typeof path !== 'string' || !isAbsolute(path)) throw new HarnessError('invalid_argument', 'Chemin absolu attendu');
    const normalized = resolve(path);
    if (!folderAvailable(normalized)) throw new HarnessError('invalid_argument', `Dossier inaccessible : ${normalized}`);
    const exists = this.db.get('SELECT 1 AS x FROM project_folders WHERE project_id = ? AND path = ?', id, normalized);
    if (exists) throw new HarnessError('conflict', 'Ce dossier est déjà associé au projet');
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM project_folders WHERE project_id = ?', id)?.m ?? 0;
    this.db.run(
      'INSERT INTO project_folders (project_id, path, label, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      normalized,
      (label ?? '').trim().slice(0, MAX_NAME) || basename(normalized),
      max + 1,
      now(),
    );
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id);
    this.changed();
    return this.get(id);
  }

  removeFolder(folderId: Id): Project {
    const row = this.db.get<FolderRow>('SELECT * FROM project_folders WHERE id = ?', folderId);
    if (!row) throw new HarnessError('not_found', 'Dossier introuvable');
    this.db.run('DELETE FROM project_folders WHERE id = ?', folderId);
    this.changed();
    return this.get(row.project_id);
  }

  private map(r: ProjectRow, folders: FolderRow[], attachments: AttachmentRow[]): Project {
    return {
      id: r.id,
      name: r.name,
      icon: r.icon,
      color: r.color,
      instructions: r.instructions,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      folders: folders.map(
        (f): ProjectFolder => ({ id: f.id, projectId: f.project_id, path: f.path, label: f.label, sortOrder: f.sort_order, available: folderAvailable(f.path) }),
      ),
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind })),
    };
  }

  private changed(): void {
    this.events.emit('projects.changed', { projects: this.list() });
  }
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') throw new HarnessError('invalid_argument', 'Le nom du projet est obligatoire');
  return name.trim().slice(0, MAX_NAME);
}

function cleanIcon(icon: unknown): string {
  return typeof icon === 'string' && /^[a-z0-9-]{1,40}$/.test(icon) ? icon : 'folder';
}

function cleanColor(color: unknown): string {
  return typeof color === 'string' && /^(#[0-9a-fA-F]{6}|)$/.test(color) ? color : '';
}

function cleanInstructions(text: unknown): string {
  if (text === undefined) return '';
  if (typeof text !== 'string') throw new HarnessError('invalid_argument', 'Instructions invalides');
  if (text.length > MAX_INSTRUCTIONS) throw new HarnessError('invalid_argument', `Instructions limitées à ${MAX_INSTRUCTIONS} caractères`);
  return text;
}
