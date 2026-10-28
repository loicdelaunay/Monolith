import { canonical } from '../tools/scope.ts';
import type { LocalAiService } from '../local/ai-runtime.ts';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, effectiveEmbeddings, type Id, type RagRootStatus, type RagStatus, type Settings } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import type { ProviderService } from './providers.ts';
import type { HttpClient } from '../providers/http.ts';
import { joinUrl } from '../providers/openai-compatible.ts';
import { isBinary, walk } from '../tools/files.ts';
import { ftsQuery } from './memory.ts';
import { now } from '../util.ts';

const MAX_FILE = 1024 * 1024;
const MAX_FILES = 20_000;
const EMBED_BATCH = 64;

interface SourceRow {
  id: number;
  root: string;
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
  embedding_model: string | null;
  indexed_at: string;
}

export interface RagHit {
  path: string;
  root: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

/** Découpe en fragments de lignes avec chevauchement (contexte préservé aux frontières). */
export function chunkText(text: string, lines: number): { start: number; end: number; text: string }[] {
  const all = text.split('\n');
  const out: { start: number; end: number; text: string }[] = [];
  const step = Math.max(1, Math.floor(lines * 0.85));
  for (let i = 0; i < all.length; i += step) {
    const slice = all.slice(i, i + lines);
    const body = slice.join('\n');
    if (body.trim()) out.push({ start: i + 1, end: i + slice.length, text: body });
    if (i + lines >= all.length) break;
  }
  return out;
}

const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Index construits avec MiniLM multilingue local (incompatibles avec ceux d'une connexion). */
export const LOCAL_EMBEDDING_MODEL = 'local:paraphrase-multilingual-MiniLM-L12-v2';

/**
 * RAG local : les ressources autorisées de la conversation sont découpées et indexées
 * (recherche lexicale FTS5 ; embeddings facultatifs via une connexion compatible OpenAI).
 * Un fichier modifié depuis l'indexation est signalé (index périmé) ; l'indexation est annulable.
 */
export class RagService {
  private readonly running = new Map<Id, { controller: AbortController; progress: RagStatus['progress'] }>();

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
    private readonly providers: ProviderService,
    private readonly http: HttpClient,
    private readonly settings: () => Settings,
    /** Embeddings locaux (MiniLM multilingue). */
    private readonly localAi: Pick<LocalAiService, 'embed'> | null = null,
  ) {}

  /** Identifiant du modèle d'embeddings des index (null : recherche lexicale seule). */
  private embeddingModel(): string | null {
    const r = this.settings().rag;
    const source = effectiveEmbeddings(r);
    return source === 'local' ? LOCAL_EMBEDDING_MODEL : source === 'provider' ? r.embeddingModel : null;
  }

  private files(root: string): string[] {
    return walk(root, { max: MAX_FILES }).paths.filter((p) => !/(^|\/)(index\.ohm|package-lock\.json|.*\.min\.(js|css)|.*\.lock)$/.test(p));
  }

  status(conversationId: Id, roots: string[]): RagStatus {
    const rootsStatus: RagRootStatus[] = roots.map((root) => {
      const rows = this.db.all<SourceRow>('SELECT * FROM rag_sources WHERE root = ?', root);
      const chunks = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id WHERE s.root = ?', root)!.n;
      let stale = 0;
      if (rows.length) {
        const known = new Map(rows.map((r) => [r.path, r]));
        const current = this.files(root);
        for (const rel of current) {
          const r = known.get(rel);
          if (!r) {
            stale++;
            continue;
          }
          try {
            const st = statSync(join(root, rel));
            if (st.size !== r.size || Math.round(st.mtimeMs) !== r.mtime_ms) stale++;
          } catch {
            stale++;
          }
        }
        const set = new Set(current);
        stale += rows.filter((r) => !set.has(r.path)).length;
      }
      return { root, files: rows.length, chunks, stale, indexedAt: rows.length ? rows.map((r) => r.indexed_at).sort().at(-1)! : null, embeddingModel: rows.find((r) => r.embedding_model)?.embedding_model ?? null };
    });
    const run = this.running.get(conversationId);
    return { roots: rootsStatus, indexing: !!run, progress: run?.progress ?? null };
  }

  cancel(conversationId: Id): void {
    this.running.get(conversationId)?.controller.abort();
  }

  clear(roots: string[]): void {
    for (const root of roots) this.db.run('DELETE FROM rag_sources WHERE root = ?', root);
  }

  /** Embeddings via la connexion configurée (null : recherche lexicale seule). */
  private async embed(texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; model: string } | null> {
    const s = this.settings().rag;
    const source = effectiveEmbeddings(s);
    if (source === 'local') {
      if (!this.localAi) return null;
      return { vectors: await this.localAi.embed(texts, signal), model: LOCAL_EMBEDDING_MODEL };
    }
    if (source !== 'provider' || s.embeddingProviderId === null || !s.embeddingModel) return null;
    const { conn } = await this.providers.connection(s.embeddingProviderId);
    const body = await this.http.json<{ data?: { embedding: number[]; index: number }[] }>(joinUrl(conn.baseUrl, 'embeddings'), {
      method: 'POST',
      headers: { ...conn.options.headers, ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}) },
      body: { model: s.embeddingModel, input: texts },
      signal,
      connectTimeoutMs: conn.options.connectTimeoutSec * 1000,
    });
    const data = (body.data ?? []).sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) throw new HarnessError('provider_stream', 'Réponse d’embeddings incomplète');
    return { vectors: data.map((d) => d.embedding), model: s.embeddingModel };
  }

  async index(conversationId: Id, roots: string[]): Promise<RagStatus> {
    if (this.running.has(conversationId)) throw new HarnessError('busy', 'Indexation déjà en cours');
    const controller = new AbortController();
    const state = { controller, progress: { done: 0, total: 0, file: null as string | null } };
    this.running.set(conversationId, state);
    const emit = () => this.events.emit('rag.progress', { conversationId, status: this.status(conversationId, roots) });
    try {
      const chunkLines = this.settings().rag.chunkLines;
      const model = this.embeddingModel();
      const work = roots.flatMap((root) => this.files(root).map((rel) => ({ root, rel })));
      state.progress.total = work.length;
      for (const root of roots) {
        const present = new Set(this.files(root));
        for (const r of this.db.all<SourceRow>('SELECT * FROM rag_sources WHERE root = ?', root)) if (!present.has(r.path)) this.db.run('DELETE FROM rag_sources WHERE id = ?', r.id);
      }
      let lastEmit = 0;
      for (const { root, rel } of work) {
        if (controller.signal.aborted) throw new HarnessError('cancelled', 'Indexation annulée');
        state.progress.done++;
        state.progress.file = rel;
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          emit();
        }
        const full = join(root, rel);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE || st.size === 0) continue;
        const prev = this.db.get<SourceRow>('SELECT * FROM rag_sources WHERE root = ? AND path = ?', root, rel);
        if (prev && prev.size === st.size && prev.mtime_ms === Math.round(st.mtimeMs) && prev.embedding_model === model) continue;
        const buf = readFileSync(full);
        if (isBinary(buf)) continue;
        const sha = createHash('sha256').update(buf).digest('hex');
        if (prev && prev.sha256 === sha && prev.embedding_model === model) {
          this.db.run('UPDATE rag_sources SET size = ?, mtime_ms = ? WHERE id = ?', st.size, Math.round(st.mtimeMs), prev.id);
          continue;
        }
        const chunks = chunkText(buf.toString('utf8'), chunkLines);
        const vectors: (number[] | null)[] = chunks.map(() => null);
        for (let i = 0; i < chunks.length && model; i += EMBED_BATCH) {
          const r = await this.embed(chunks.slice(i, i + EMBED_BATCH).map((c) => `${rel}\n${c.text}`), controller.signal);
          r?.vectors.forEach((v, j) => (vectors[i + j] = v));
        }
        this.db.transaction(() => {
          if (prev) this.db.run('DELETE FROM rag_sources WHERE id = ?', prev.id);
          const { lastInsertRowid: sid } = this.db.run('INSERT INTO rag_sources (root, path, size, mtime_ms, sha256, embedding_model, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)', root, rel, st.size, Math.round(st.mtimeMs), sha, model, now());
          chunks.forEach((c, i) => this.db.run('INSERT INTO rag_chunks (source_id, ord, start_line, end_line, text, embedding) VALUES (?, ?, ?, ?, ?, ?)', sid, i, c.start, c.end, c.text, vectors[i] ? toBlob(vectors[i]!) : null));
        });
      }
    } finally {
      this.running.delete(conversationId);
      emit();
    }
    return this.status(conversationId, roots);
  }

  /** Recherche hybride : BM25 (FTS5) et, si l'index a des embeddings, similarité cosinus ; fusion par rangs (RRF). */
  async search(rawRoots: string[], query: string, topK: number, signal: AbortSignal): Promise<RagHit[]> {
    // Index construits sur les racines canoniques de la portée : même forme pour la recherche.
    const roots = rawRoots.map(canonical);
    if (!roots.length) return [];
    const marks = roots.map(() => '?').join(',');
    type Row = { id: number; path: string; root: string; start_line: number; end_line: number; text: string; embedding: Uint8Array | null };
    const fts = ftsQuery(query);
    const lexical = fts
      ? this.db.all<Row>(`SELECT c.id, s.path, s.root, c.start_line, c.end_line, c.text, c.embedding FROM rag_fts f JOIN rag_chunks c ON c.id = f.rowid JOIN rag_sources s ON s.id = c.source_id WHERE rag_fts MATCH ? AND s.root IN (${marks}) ORDER BY bm25(rag_fts) LIMIT 100`, fts, ...roots)
      : [];
    const scores = new Map<number, { row: Row; score: number }>();
    lexical.forEach((row, i) => scores.set(row.id, { row, score: 1 / (60 + i) }));
    // Seuls les vecteurs du modèle actuel sont comparés (dimensions et espace identiques).
    const model = this.embeddingModel();
    const hasVectors = model ? this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id WHERE c.embedding IS NOT NULL AND s.embedding_model = ? AND s.root IN (${marks})`, model, ...roots)!.n : 0;
    if (hasVectors) {
      const q = await this.embed([query], signal).catch(() => null);
      if (q) {
        const qv = new Float32Array(q.vectors[0]!);
        const rows = this.db.all<Row>(`SELECT c.id, s.path, s.root, c.start_line, c.end_line, c.text, c.embedding FROM rag_chunks c JOIN rag_sources s ON s.id = c.source_id WHERE c.embedding IS NOT NULL AND s.embedding_model = ? AND s.root IN (${marks}) LIMIT 50000`, model, ...roots);
        rows
          .map((row) => ({ row, sim: cosine(qv, fromBlob(row.embedding!)) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 100)
          .forEach(({ row }, i) => {
            const prev = scores.get(row.id);
            scores.set(row.id, { row, score: (prev?.score ?? 0) + 1 / (60 + i) });
          });
      }
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row, score }) => ({ path: row.path, root: row.root, startLine: row.start_line, endLine: row.end_line, text: row.text, score }));
  }
}
