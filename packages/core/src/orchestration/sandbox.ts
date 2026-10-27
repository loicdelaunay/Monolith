import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { HarnessError, type Id, type SandboxChange, type SandboxStatus } from '@monolith/contracts';
import type { ResourceService } from '../services/resources.ts';
import { isBinary } from '../tools/files.ts';

/** Dossiers jamais copiés dans une sandbox (dépendances, historiques, sorties de build). */
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'dist', 'out', 'build', 'target', '.next', '.nuxt', '.cache', 'coverage']);
const MAX_FILES = 50_000;

interface Manifest {
  createdAt: string;
  previous: { mode: 'inherit' | 'custom'; folders: string[]; files: string[] };
  roots: { original: string; copy: string; files: Record<string, string> }[];
}

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) {
        if (out.length >= MAX_FILES) throw new HarnessError('invalid_argument', `Plus de ${MAX_FILES} fichiers : sandbox refusée pour ce dossier.`);
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Sandbox de conversation : les ressources sont remplacées par des copies privées. L'agent
 * travaille sur les copies ; l'utilisateur consulte le diff et applique fichier par fichier,
 * avec détection des conflits (original modifié depuis la copie). Isolation des fichiers
 * uniquement : les commandes s'exécutent sur ce poste, dans les dossiers copiés.
 */
export class SandboxService {
  constructor(
    private readonly resources: ResourceService,
    private readonly dir: string,
  ) {}

  private base(conversationId: Id): string {
    return join(this.dir, String(conversationId));
  }

  private manifest(conversationId: Id): Manifest | null {
    const file = join(this.base(conversationId), 'manifest.json');
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Manifest) : null;
  }

  status(conversationId: Id): SandboxStatus {
    const m = this.manifest(conversationId);
    if (!m) return { enabled: false, roots: [], createdAt: null, changes: 0 };
    return { enabled: true, roots: m.roots.map((r) => ({ original: r.original, copy: r.copy })), createdAt: m.createdAt, changes: this.diff(conversationId, false).length };
  }

  enable(conversationId: Id): SandboxStatus {
    if (this.manifest(conversationId)) return this.status(conversationId);
    const info = this.resources.scope(conversationId).info;
    const roots = info.roots.filter((r) => r !== info.privateDir);
    if (!roots.length) throw new HarnessError('invalid_argument', 'Aucun dossier à isoler : ajoutez une ressource à la conversation.');
    const base = this.base(conversationId);
    mkdirSync(base, { recursive: true });
    const manifest: Manifest = { createdAt: new Date().toISOString(), previous: { mode: info.mode, folders: info.mode === 'custom' ? roots : [], files: info.files }, roots: [] };
    try {
      roots.forEach((original, i) => {
        const copy = join(base, `${i}-${basename(original) || 'racine'}`);
        const files = listFiles(original);
        cpSync(original, copy, { recursive: true, filter: (src) => !SKIP.has(basename(src)) || src === original });
        manifest.roots.push({ original, copy, files: Object.fromEntries(files.map((f) => [f, hash(join(original, f))])) });
      });
    } catch (e) {
      rmSync(base, { recursive: true, force: true });
      throw e;
    }
    writeFileSync(join(base, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    this.resources.setCustom(conversationId, manifest.roots.map((r) => r.copy), info.files);
    return this.status(conversationId);
  }

  diff(conversationId: Id, withContent = true): SandboxChange[] {
    const m = this.manifest(conversationId);
    if (!m) throw new HarnessError('invalid_argument', 'Sandbox inactive pour cette conversation');
    const out: SandboxChange[] = [];
    m.roots.forEach((r, i) => {
      const now = new Set(existsSync(r.copy) ? listFiles(r.copy) : []);
      const read = (p: string) => {
        if (!withContent || !existsSync(p)) return { text: '', binary: false };
        const buf = readFileSync(p);
        return isBinary(buf) || buf.length > 2 * 1024 * 1024 ? { text: '', binary: true } : { text: buf.toString('utf8'), binary: false };
      };
      const conflict = (rel: string) => {
        const orig = join(r.original, rel);
        const snap = r.files[rel];
        if (!existsSync(orig)) return snap !== undefined;
        return snap === undefined ? true : hash(orig) !== snap;
      };
      for (const rel of now) {
        const copyPath = join(r.copy, rel);
        const snap = r.files[rel];
        if (snap !== undefined && hash(copyPath) === snap) continue;
        const before = read(join(r.original, rel));
        const after = read(copyPath);
        out.push({ root: i, path: rel, status: snap === undefined ? 'created' : 'modified', conflict: conflict(rel), before: before.text, after: after.text, binary: before.binary || after.binary });
      }
      for (const rel of Object.keys(r.files)) {
        if (now.has(rel)) continue;
        const before = read(join(r.original, rel));
        out.push({ root: i, path: rel, status: 'deleted', conflict: conflict(rel), before: before.text, after: '', binary: before.binary });
      }
    });
    return out.sort((a, b) => a.root - b.root || a.path.localeCompare(b.path));
  }

  /** Applique les fichiers choisis à l'original ; un conflit est refusé sauf confirmation explicite. */
  apply(conversationId: Id, files: { root: number; path: string }[], force: boolean): { applied: number; conflicts: string[] } {
    const m = this.manifest(conversationId);
    if (!m) throw new HarnessError('invalid_argument', 'Sandbox inactive pour cette conversation');
    const changes = this.diff(conversationId, false);
    const conflicts: string[] = [];
    let applied = 0;
    for (const f of files) {
      const c = changes.find((x) => x.root === f.root && x.path === f.path);
      const r = m.roots[f.root];
      if (!c || !r) continue;
      if (c.conflict && !force) {
        conflicts.push(f.path);
        continue;
      }
      const target = join(r.original, c.path);
      const source = join(r.copy, c.path);
      if (!target.startsWith(r.original + sep)) continue;
      if (c.status === 'deleted') {
        if (existsSync(target)) unlinkSync(target);
        delete r.files[c.path];
      } else {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
        r.files[c.path] = hash(source);
      }
      applied++;
    }
    // L'état appliqué devient la nouvelle référence : il ne réapparaît plus dans le diff.
    writeFileSync(join(this.base(conversationId), 'manifest.json'), JSON.stringify(m), 'utf8');
    return { applied, conflicts };
  }

  /** Supprime les copies et rétablit les ressources d'avant la sandbox. */
  discard(conversationId: Id): SandboxStatus {
    const m = this.manifest(conversationId);
    if (!m) return this.status(conversationId);
    if (m.previous.mode === 'inherit') this.resources.reset(conversationId);
    else this.resources.setCustom(conversationId, m.previous.folders, m.previous.files);
    rmSync(this.base(conversationId), { recursive: true, force: true });
    return this.status(conversationId);
  }
}
