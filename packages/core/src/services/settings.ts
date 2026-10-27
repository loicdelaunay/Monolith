import { DEFAULT_SETTINGS, HarnessError, SETTINGS_BOUNDS, type Settings, type SettingsPatch, type SettingsSection, sanitizeShortcuts } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Réglages typés : une ligne par section. Les clés inconnues sont ignorées, les types
 * vérifiés contre les valeurs par défaut et les bornes appliquées.
 */
export class SettingsService {
  private cache: Settings | null = null;

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  get(): Settings {
    if (this.cache) return clone(this.cache);
    const rows = this.db.all<{ key: string; value_json: string }>('SELECT key, value_json FROM settings');
    const stored = new Map(rows.map((r) => [r.key, r.value_json]));
    const result = clone(DEFAULT_SETTINGS);
    for (const section of Object.keys(DEFAULT_SETTINGS) as SettingsSection[]) {
      const raw = stored.get(section);
      if (!raw) continue;
      try {
        this.merge(result, section, JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* section corrompue : valeurs par défaut */
      }
    }
    this.cache = result;
    return clone(result);
  }

  update(patch: SettingsPatch): Settings {
    if (!patch || typeof patch !== 'object') throw new HarnessError('invalid_argument', 'Patch de réglages invalide');
    const next = this.get();
    const touched: SettingsSection[] = [];
    for (const [section, values] of Object.entries(patch) as [SettingsSection, Record<string, unknown>][]) {
      if (!(section in DEFAULT_SETTINGS) || !values || typeof values !== 'object') continue;
      this.merge(next, section, values);
      touched.push(section);
    }
    if (touched.length === 0) return next;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const section of touched) {
        this.db.run(
          'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          section,
          JSON.stringify(next[section]),
          now,
        );
      }
    });
    this.cache = next;
    this.events.emit('settings.changed', clone(next));
    return clone(next);
  }

  reset(section?: SettingsSection): Settings {
    if (section) {
      if (!(section in DEFAULT_SETTINGS)) throw new HarnessError('invalid_argument', `Section inconnue : ${section}`);
      this.db.run('DELETE FROM settings WHERE key = ?', section);
    } else {
      this.db.run('DELETE FROM settings');
    }
    this.cache = null;
    const s = this.get();
    this.events.emit('settings.changed', s);
    return s;
  }

  private merge(target: Settings, section: SettingsSection, values: Record<string, unknown>): void {
    const defaults = DEFAULT_SETTINGS[section] as Record<string, unknown>;
    const dest = target[section] as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (!(key in defaults)) continue;
      const def = defaults[key];
      if (!compatible(def, value)) continue;
      let v = value;
      // Listes structurées : validées élément par élément.
      if (section === 'shortcuts' && key === 'items') v = sanitizeShortcuts(value);
      const bounds = (SETTINGS_BOUNDS as Record<string, readonly [number, number]>)[`${section}.${key}`];
      if (bounds && typeof v === 'number') v = Math.min(bounds[1], Math.max(bounds[0], v));
      dest[key] = clone(v);
    }
  }
}

function compatible(def: unknown, value: unknown): boolean {
  if (value === undefined) return false;
  if (def === null) return value === null || typeof value === 'string' || typeof value === 'number';
  if (Array.isArray(def)) return Array.isArray(value);
  if (typeof def === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof def === typeof value;
}
