import { HarnessError, type Id, type MessageTemplate } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface TemplateRow {
  id: number;
  name: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const map = (r: TemplateRow): MessageTemplate => ({ id: r.id, name: r.name, content: r.content, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at });

function clean(name: unknown, content: unknown): { name: string; content: string } {
  if (typeof name !== 'string' || !name.trim()) throw new HarnessError('invalid_argument', 'Le nom du modèle est obligatoire');
  if (typeof content !== 'string' || !content.trim()) throw new HarnessError('invalid_argument', 'Le contenu du modèle est vide');
  if (content.length > 200_000) throw new HarnessError('invalid_argument', 'Modèle trop long');
  return { name: name.trim().slice(0, 120), content };
}

/** Modèles de messages réutilisables, communs à toutes les conversations. */
export class TemplateService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  list(): MessageTemplate[] {
    return this.db.all<TemplateRow>('SELECT * FROM templates ORDER BY sort_order, name').map(map);
  }

  create(name: string, content: string): MessageTemplate {
    const c = clean(name, content);
    const t = now();
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM templates')?.m ?? 0;
    const { lastInsertRowid } = this.db.run('INSERT INTO templates (name, content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', c.name, c.content, max + 1, t, t);
    this.changed();
    return this.get(lastInsertRowid);
  }

  update(id: Id, patch: { name?: string; content?: string }): MessageTemplate {
    const current = this.get(id);
    const c = clean(patch.name ?? current.name, patch.content ?? current.content);
    this.db.run('UPDATE templates SET name = ?, content = ?, updated_at = ? WHERE id = ?', c.name, c.content, now(), id);
    this.changed();
    return this.get(id);
  }

  delete(id: Id): void {
    this.get(id);
    this.db.run('DELETE FROM templates WHERE id = ?', id);
    this.changed();
  }

  get(id: Id): MessageTemplate {
    const r = this.db.get<TemplateRow>('SELECT * FROM templates WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', 'Modèle de message introuvable');
    return map(r);
  }

  private changed(): void {
    this.events.emit('templates.changed', { templates: this.list() });
  }
}
