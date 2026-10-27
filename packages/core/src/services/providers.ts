import {
  DEFAULT_PROVIDER_OPTIONS,
  HarnessError,
  PROVIDER_PRESETS,
  findPreset,
  type CatalogModel,
  type ConnectionTestResult,
  type Id,
  type ModelCapabilities,
  type Provider,
  type ProviderInput,
  type ProviderKind,
  type ProviderModel,
  type ProviderOptions,
  type ProviderPatch,
  type ProviderPreset,
  type ProviderTestInput,
  type ReasoningLevel,
  KINDS_WITHOUT_BASE_URL,
} from '@monolith/contracts';
import { bool, json, type Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import type { SecretStore } from '../security/secrets.ts';
import type { ProviderAdapter, ProviderConnection } from '../providers/adapter.ts';
import { parseServiceAccount } from '../providers/google-auth.ts';
import { now } from '../util.ts';
import { documentedLevels } from '../generation/reasoning.ts';

interface ProviderRow {
  id: number;
  name: string;
  kind: string;
  preset: string;
  base_url: string;
  secret_id: string | null;
  options_json: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  provider_id: number;
  model_id: string;
  label: string;
  enabled: number;
  context_window: number | null;
  max_output_tokens: number | null;
  source: string;
  capabilities_json: string;
}

const REASONING: ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
const EMPTY_CAPS: ModelCapabilities = { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null };
const SOURCES: ModelCapabilities['reasoningSource'][] = ['unknown', 'documented', 'catalog', 'user'];

/**
 * Validation volontairement permissive : aucune règle de préfixe (les formats évoluent et
 * varient selon les fournisseurs/passerelles). Seuls les caractères qui ne peuvent pas
 * figurer dans un en-tête HTTP sont refusés.
 */
export function validateApiKey(key: unknown): string {
  if (typeof key !== 'string') throw new HarnessError('invalid_argument', 'Clé invalide');
  const k = key.trim();
  if (!k) throw new HarnessError('invalid_argument', 'La clé est vide');
  if (k.length > 8192) throw new HarnessError('invalid_argument', 'Clé trop longue (8192 caractères maximum)');
  if (/[\s\u0000-\u001f\u007f]/.test(k)) throw new HarnessError('invalid_argument', 'La clé contient des espaces ou des caractères de contrôle');
  if (/[^ -~]/.test(k)) throw new HarnessError('invalid_argument', 'La clé contient des caractères non ASCII, impossibles à transmettre dans un en-tête HTTP');
  return k;
}

/** Secret d'une connexion : clé d'API, ou JSON de compte de service pour Vertex AI. */
export function validateSecret(kind: ProviderKind, key: unknown): string {
  if (kind === 'vertex' && typeof key === 'string' && key.trim().startsWith('{')) return parseServiceAccount(key);
  return validateApiKey(key);
}

const needsBaseUrl = (kind: ProviderKind) => !(KINDS_WITHOUT_BASE_URL as readonly string[]).includes(kind);

export function validateBaseUrl(url: unknown, required: boolean): string {
  if (typeof url !== 'string') throw new HarnessError('invalid_argument', 'URL invalide');
  const u = url.trim();
  if (!u) {
    if (required) throw new HarnessError('invalid_argument', 'L’URL de base est obligatoire');
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new HarnessError('invalid_argument', `URL invalide : ${u}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HarnessError('invalid_argument', 'Seules les URL http(s) sont acceptées');
  if (parsed.username || parsed.password) throw new HarnessError('invalid_argument', 'Ne placez pas d’identifiants dans l’URL : utilisez le champ Clé');
  return u.replace(/\/+$/, '');
}

function cleanOptions(input: Partial<ProviderOptions> | undefined, base: ProviderOptions): ProviderOptions {
  const o = { ...base };
  if (!input) return o;
  if (input.headers && typeof input.headers === 'object') {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v)) continue;
      if (/^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(k)) {
        throw new HarnessError('invalid_argument', `L’en-tête ${k} est un secret : utilisez le champ Clé, chiffré`);
      }
      h[k] = v.slice(0, 1000);
    }
    o.headers = h;
  }
  const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);
  if (input.connectTimeoutSec !== undefined) o.connectTimeoutSec = num(input.connectTimeoutSec, 5, 600, base.connectTimeoutSec);
  if (input.idleTimeoutSec !== undefined) o.idleTimeoutSec = num(input.idleTimeoutSec, 10, 1800, base.idleTimeoutSec);
  if (input.streamUsage !== undefined) o.streamUsage = Boolean(input.streamUsage);
  if (input.temperature !== undefined) o.temperature = input.temperature === null ? null : Math.min(2, Math.max(0, Number(input.temperature) || 0));
  if (input.maxOutputTokens !== undefined) o.maxOutputTokens = input.maxOutputTokens === null ? null : num(input.maxOutputTokens, 1, 1_000_000, 4096);
  const line = (v: unknown, max: number) => (typeof v === 'string' && !/[\r\n\u0000]/.test(v) ? v.trim().slice(0, max) : null);
  if (input.google && typeof input.google === 'object') {
    const g = input.google;
    const project = line(g.project, 100) ?? base.google.project;
    if (project && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new HarnessError('invalid_argument', `Identifiant de projet Google Cloud invalide : ${project}`);
    const location = line(g.location, 40) ?? base.google.location;
    if (!/^[a-z0-9-]{2,40}$/.test(location)) throw new HarnessError('invalid_argument', `Région invalide : ${location}`);
    o.google = { project, location, auth: ['api_key', 'express', 'adc', 'service_account'].includes(g.auth) ? g.auth : base.google.auth };
  }
  if (input.acp && typeof input.acp === 'object') {
    const a = input.acp;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k) || line(v, 2000) === null) continue;
      // Les secrets restent dans la configuration de l'agent : jamais en clair dans la base.
      if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) throw new HarnessError('invalid_argument', `La variable ${k} ressemble à un secret : configurez-la dans l’agent lui-même, pas ici.`);
      env[k] = line(v, 2000)!;
    }
    o.acp = {
      command: line(a.command, 500) ?? base.acp.command,
      args: Array.isArray(a.args) ? a.args.map((x) => line(x, 1000)).filter((x): x is string => x !== null && x !== '').slice(0, 50) : base.acp.args,
      env,
    };
  }
  if (input.composite && typeof input.composite === 'object') {
    const c = input.composite;
    const ref = (r: unknown) => {
      const x = r as { providerId?: unknown; model?: unknown } | null;
      return x && typeof x.providerId === 'number' && typeof x.model === 'string' && x.model.trim() ? { providerId: x.providerId, model: x.model.trim().slice(0, 200) } : null;
    };
    const specialists = (Array.isArray(c.specialists) ? c.specialists : []).slice(0, 10).map((sp) => {
      const r = ref(sp);
      const name = line(sp?.name, 40) ?? '';
      if (!r || !/^[\w-]{1,40}$/.test(name)) throw new HarnessError('invalid_argument', 'Spécialiste invalide : nom (lettres, chiffres, tirets), connexion et modèle requis.');
      return { ...r, name, description: line(sp.description, 500) ?? '' };
    });
    if (new Set(specialists.map((x) => x.name)).size !== specialists.length) throw new HarnessError('invalid_argument', 'Deux spécialistes portent le même nom.');
    o.composite = { orchestrator: c.orchestrator === null ? null : (ref(c.orchestrator) ?? base.composite.orchestrator), specialists, maxConsultations: num(c.maxConsultations, 1, 20, base.composite.maxConsultations) };
  }
  return o;
}

function cleanCapabilities(c: Partial<ModelCapabilities> | undefined): ModelCapabilities {
  return {
    reasoningLevels: Array.isArray(c?.reasoningLevels) ? [...new Set(c.reasoningLevels.filter((l) => REASONING.includes(l)))] : [],
    reasoningSource: c?.reasoningSource && SOURCES.includes(c.reasoningSource) ? c.reasoningSource : Array.isArray(c?.reasoningLevels) && c.reasoningLevels.length ? 'user' : 'unknown',
    rejectedLevels: Array.isArray(c?.rejectedLevels) ? c.rejectedLevels.filter((l) => REASONING.includes(l)) : [],
    vision: typeof c?.vision === 'boolean' ? c.vision : null,
    tools: typeof c?.tools === 'boolean' ? c.tools : null,
  };
}

export class ProviderService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
    private readonly secrets: SecretStore,
    private readonly adapters: Map<ProviderKind, ProviderAdapter>,
  ) {}

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS.map((p) => ({ ...p, available: p.available && this.adapters.has(p.kind) }));
  }

  list(): Provider[] {
    const rows = this.db.all<ProviderRow>('SELECT * FROM providers ORDER BY sort_order, id');
    const models = this.db.all<ModelRow>('SELECT * FROM provider_models ORDER BY sort_order, model_id');
    return rows.map((r) => this.map(r, models.filter((m) => m.provider_id === r.id)));
  }

  get(id: Id): Provider {
    const row = this.row(id);
    return this.map(row, this.db.all<ModelRow>('SELECT * FROM provider_models WHERE provider_id = ? ORDER BY sort_order, model_id', id));
  }

  private row(id: Id): ProviderRow {
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
    if (!row) throw new HarnessError('not_found', `Connexion ${id} introuvable`);
    return row;
  }

  async create(input: ProviderInput): Promise<Provider> {
    const preset = findPreset(input.preset);
    if (!preset) throw new HarnessError('invalid_argument', `Préréglage inconnu : ${input.preset}`);
    if (!preset.available || !this.adapters.has(preset.kind)) {
      throw new HarnessError('unavailable', preset.unavailableReason ?? 'Ce type de connexion n’est pas encore disponible');
    }
    const name = (input.name ?? '').trim().slice(0, 120) || preset.name;
    const baseUrl = validateBaseUrl(input.baseUrl ?? preset.baseUrl, needsBaseUrl(preset.kind));
    const options = cleanOptions({ ...preset.defaults, ...input.options }, DEFAULT_PROVIDER_OPTIONS);
    const apiKey = input.apiKey ? validateSecret(preset.kind, input.apiKey) : null;
    const t = now();
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM providers')?.m ?? 0;
    const { lastInsertRowid: id } = this.db.run(
      'INSERT INTO providers (name, kind, preset, base_url, options_json, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      name,
      preset.kind,
      preset.id,
      baseUrl,
      JSON.stringify(options),
      input.enabled === false ? 0 : 1,
      max + 1,
      t,
      t,
    );
    if (apiKey) {
      try {
        await this.storeKey(id, apiKey);
      } catch (error) {
        this.db.run('DELETE FROM providers WHERE id = ?', id);
        throw error;
      }
    }
    // Agent externe et modèle composé : un modèle unique, activé d'office pour apparaître dans le chat.
    if (preset.kind === 'acp' || preset.kind === 'composite' || preset.kind === 'local') {
      const conn: ProviderConnection = { kind: preset.kind, baseUrl, apiKey: null, options };
      const list = await this.adapters.get(preset.kind)!.listModels(conn, AbortSignal.timeout(5000));
      if (list.length) return this.setModels(id, list.map((m) => ({ id: m.id, label: m.label, enabled: true, contextWindow: m.contextWindow, maxOutputTokens: null, source: 'catalog' as const, capabilities: m.capabilities })));
    }
    this.changed();
    return this.get(id);
  }

  update(id: Id, patch: ProviderPatch): Provider {
    const row = this.row(id);
    const current = this.get(id);
    this.db.run(
      'UPDATE providers SET name = ?, base_url = ?, enabled = ?, options_json = ?, updated_at = ? WHERE id = ?',
      patch.name !== undefined ? patch.name.trim().slice(0, 120) || row.name : row.name,
      patch.baseUrl !== undefined ? validateBaseUrl(patch.baseUrl, needsBaseUrl(row.kind as ProviderKind)) : row.base_url,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
      JSON.stringify(cleanOptions(patch.options, current.options)),
      now(),
      id,
    );
    this.changed();
    return this.get(id);
  }

  /** Duplique la connexion et ses modèles ; la clé est recopiée (chiffrée sous un nouvel identifiant). */
  async duplicate(id: Id): Promise<Provider> {
    const src = this.get(id);
    const row = this.row(id);
    const key = row.secret_id ? await this.secrets.get(row.secret_id).catch(() => null) : null;
    const copy = await this.create({
      name: `${src.name} (copie)`,
      kind: src.kind,
      preset: src.preset,
      baseUrl: src.baseUrl,
      enabled: src.enabled,
      options: src.options,
      ...(key ? { apiKey: key } : {}),
    });
    this.setModels(copy.id, src.models);
    return this.get(copy.id);
  }

  delete(id: Id): void {
    const row = this.row(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM providers WHERE id = ?', id);
      if (row.secret_id) this.secrets.delete(row.secret_id);
      // Les réglages pointant vers cette connexion sont remis à zéro par le moteur (Harness).
    });
    this.changed();
  }

  reorder(ids: Id[]): void {
    this.db.transaction(() => ids.forEach((pid, i) => this.db.run('UPDATE providers SET sort_order = ? WHERE id = ?', i + 1, pid)));
    this.changed();
  }

  async setKey(id: Id, apiKey: string): Promise<Provider> {
    this.row(id);
    await this.storeKey(id, validateSecret(this.get(id).kind, apiKey));
    this.changed();
    return this.get(id);
  }

  clearKey(id: Id): Provider {
    const row = this.row(id);
    this.db.transaction(() => {
      this.db.run('UPDATE providers SET secret_id = NULL, updated_at = ? WHERE id = ?', now(), id);
      if (row.secret_id) this.secrets.delete(row.secret_id);
    });
    this.changed();
    return this.get(id);
  }

  private async storeKey(id: Id, key: string): Promise<void> {
    const secretId = `provider:${id}`;
    await this.secrets.set(secretId, key);
    this.db.run('UPDATE providers SET secret_id = ?, updated_at = ? WHERE id = ?', secretId, now(), id);
  }

  setModels(id: Id, models: ProviderModel[]): Provider {
    this.row(id);
    if (!Array.isArray(models)) throw new HarnessError('invalid_argument', 'Liste de modèles attendue');
    const t = now();
    const seen = new Set<string>();
    this.db.transaction(() => {
      this.db.run('DELETE FROM provider_models WHERE provider_id = ?', id);
      models.forEach((m, index) => {
        const modelId = typeof m.id === 'string' ? m.id.trim().slice(0, 300) : '';
        if (!modelId || seen.has(modelId)) return;
        seen.add(modelId);
        this.db.run(
          'INSERT INTO provider_models (provider_id, model_id, label, enabled, context_window, max_output_tokens, source, capabilities_json, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          modelId,
          (m.label ?? '').trim().slice(0, 300) || modelId,
          m.enabled === false ? 0 : 1,
          positiveOrNull(m.contextWindow),
          positiveOrNull(m.maxOutputTokens),
          m.source === 'catalog' ? 'catalog' : 'manual',
          JSON.stringify(cleanCapabilities(m.capabilities)),
          index,
          t,
        );
      });
    });
    this.changed();
    return this.get(id);
  }

  /** Connexion prête à l'emploi (clé déchiffrée) — usage interne du moteur uniquement. */
  async connection(id: Id): Promise<{ provider: Provider; conn: ProviderConnection; adapter: ProviderAdapter }> {
    const row = this.row(id);
    const provider = this.get(id);
    const adapter = this.adapters.get(provider.kind);
    if (!adapter) throw new HarnessError('unavailable', `Le type de connexion « ${provider.kind} » n’est pas disponible dans cette version`);
    const apiKey = row.secret_id ? await this.secrets.get(row.secret_id) : null;
    return { provider, adapter, conn: { kind: provider.kind, baseUrl: provider.baseUrl, apiKey, options: provider.options } };
  }

  async test(input: ProviderTestInput, signal: AbortSignal): Promise<ConnectionTestResult> {
    const adapter = this.adapters.get(input.kind);
    if (!adapter) throw new HarnessError('unavailable', 'Type de connexion indisponible');
    let apiKey: string | null = input.apiKey ? validateSecret(input.kind, input.apiKey) : null;
    let options = cleanOptions(input.options, DEFAULT_PROVIDER_OPTIONS);
    if (input.providerId !== undefined) {
      const row = this.row(input.providerId);
      if (!apiKey && row.secret_id) apiKey = await this.secrets.get(row.secret_id);
      options = cleanOptions(input.options, this.get(input.providerId).options);
    }
    const conn: ProviderConnection = { kind: input.kind, baseUrl: validateBaseUrl(input.baseUrl, needsBaseUrl(input.kind)), apiKey, options };
    return adapter.test(conn, { ...(input.model ? { model: input.model } : {}), allowCompletion: input.allowCompletion === true }, signal);
  }

  async fetchCatalog(id: Id, signal: AbortSignal): Promise<CatalogModel[]> {
    const { adapter, conn, provider } = await this.connection(id);
    const catalog = await adapter.listModels(conn, signal);
    return catalog.map((m) => ({ ...m, capabilities: withKnownLevels(provider.preset, m.id, m.capabilities) }));
  }

  /**
   * Réévalue les capacités des modèles enregistrés : catalogue du fournisseur puis table documentée.
   * Les niveaux saisis par l'utilisateur sont conservés ; les niveaux refusés sont oubliés.
   */
  async refreshModels(id: Id, signal: AbortSignal): Promise<Provider> {
    const provider = this.get(id);
    let catalog: CatalogModel[] = [];
    try {
      catalog = await this.fetchCatalog(id, signal);
    } catch {
      // Catalogue indisponible : la table documentée suffit pour réévaluer.
    }
    const byId = new Map(catalog.map((c) => [c.id, c]));
    const models = provider.models.map((m): ProviderModel => {
      const c = byId.get(m.id);
      const known = withKnownLevels(provider.preset, m.id, c?.capabilities ?? EMPTY_CAPS);
      const keepUser = m.capabilities.reasoningSource === 'user';
      return {
        ...m,
        contextWindow: m.contextWindow ?? c?.contextWindow ?? null,
        maxOutputTokens: m.maxOutputTokens ?? c?.maxOutputTokens ?? null,
        capabilities: {
          reasoningLevels: keepUser ? m.capabilities.reasoningLevels : known.reasoningLevels,
          reasoningSource: keepUser ? 'user' : known.reasoningSource,
          rejectedLevels: [],
          vision: c?.capabilities.vision ?? m.capabilities.vision,
          tools: c?.capabilities.tools ?? m.capabilities.tools,
        },
      };
    });
    return this.setModels(id, models);
  }

  /** Le fournisseur a refusé ce niveau : il disparaît des choix jusqu'à la prochaine réévaluation. */
  rejectLevel(id: Id, modelId: string, level: ReasoningLevel): void {
    const row = this.db.get<ModelRow>('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?', id, modelId);
    if (!row) return;
    const caps = cleanCapabilities(json<Partial<ModelCapabilities>>(row.capabilities_json, EMPTY_CAPS));
    if (caps.rejectedLevels.includes(level)) return;
    caps.rejectedLevels.push(level);
    this.db.run('UPDATE provider_models SET capabilities_json = ?, updated_at = ? WHERE provider_id = ? AND model_id = ?', JSON.stringify(caps), now(), id, modelId);
    this.changed();
  }

  /** Capacités enregistrées d'un modèle (null si le modèle n'est pas dans la liste de la connexion). */
  modelCapabilities(id: Id, modelId: string): ModelCapabilities | null {
    const row = this.db.get<ModelRow>('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?', id, modelId);
    return row ? cleanCapabilities(json<Partial<ModelCapabilities>>(row.capabilities_json, EMPTY_CAPS)) : null;
  }

  modelLimits(id: Id, modelId: string): { contextWindow: number | null; maxOutputTokens: number | null } {
    const row = this.db.get<ModelRow>('SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?', id, modelId);
    return { contextWindow: row?.context_window ?? null, maxOutputTokens: row?.max_output_tokens ?? null };
  }

  private map(r: ProviderRow, models: ModelRow[]): Provider {
    const keyUnreadable = r.secret_id !== null && this.secrets.unreadable;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as ProviderKind,
      preset: r.preset,
      baseUrl: r.base_url,
      enabled: bool(r.enabled),
      sortOrder: r.sort_order,
      hasKey: r.secret_id !== null,
      keyHint: r.secret_id ? this.secrets.hint(r.secret_id) : null,
      keyUnreadable,
      options: { ...DEFAULT_PROVIDER_OPTIONS, ...json<Partial<ProviderOptions>>(r.options_json, {}) },
      models: models.map((m) => ({
        id: m.model_id,
        label: m.label || m.model_id,
        enabled: bool(m.enabled),
        contextWindow: m.context_window,
        maxOutputTokens: m.max_output_tokens,
        source: m.source === 'catalog' ? 'catalog' : 'manual',
        capabilities: cleanCapabilities(json<Partial<ModelCapabilities>>(m.capabilities_json, EMPTY_CAPS)),
      })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private changed(): void {
    this.events.emit('providers.changed', { providers: this.list() });
  }
}

function positiveOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/** Complète les capacités d'un modèle par la table documentée lorsque le catalogue ne déclare rien. */
function withKnownLevels(preset: string, modelId: string, caps: ModelCapabilities): ModelCapabilities {
  const base = cleanCapabilities(caps);
  if (base.reasoningLevels.length) return { ...base, reasoningSource: base.reasoningSource === 'unknown' ? 'catalog' : base.reasoningSource };
  const documented = documentedLevels(preset, modelId);
  return documented.length ? { ...base, reasoningLevels: documented, reasoningSource: 'documented' } : { ...base, reasoningSource: 'unknown' };
}
