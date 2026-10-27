import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { HarnessError } from '@monolith/contracts';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/** `child` est-il `parent` ou un de ses descendants ? (comparaison sur chemins canoniques) */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Chemin canonique : liens symboliques résolus ; pour un chemin inexistant, via le plus proche parent existant. */
export function canonical(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length).replace(/^[\\/]/, ''));
    current = parent;
  }
  let base: string;
  try {
    base = realpathSync.native(current);
  } catch {
    base = current;
  }
  return tail.length ? join(base, ...tail) : base;
}

/**
 * Portée des outils d'une conversation : racines (dossiers) et fichiers isolés autorisés.
 * Toute résolution passe par le chemin canonique : `..`, liens symboliques et jonctions
 * ne permettent pas de sortir de la portée. Certains chemins restent interdits même
 * s'ils sont dans une racine (base, clés, journaux de l'application).
 */
export class ResourceScope {
  readonly roots: string[];
  readonly files: string[];
  private readonly forbidden: string[];

  constructor(roots: string[], files: string[], forbidden: string[]) {
    this.roots = roots.map(canonical);
    this.files = files.map(canonical);
    this.forbidden = forbidden.map(canonical);
  }

  get primary(): string | null {
    return this.roots[0] ?? null;
  }

  /** Résout un chemin donné par le modèle (relatif à la première racine, ou absolu). */
  resolve(input: unknown, opts: { write?: boolean } = {}): string {
    if (typeof input !== 'string' || !input.trim()) throw new HarnessError('invalid_argument', 'Chemin manquant');
    const raw = input.trim().replace(/^["']|["']$/g, '');
    const base = this.primary;
    if (!isAbsolute(raw) && !base) throw new HarnessError('permission_denied', 'Aucun dossier n’est accessible : indiquez un fichier joint par son chemin absolu.');
    const full = canonical(isAbsolute(raw) ? normalize(raw) : resolve(base!, raw));
    for (const f of this.forbidden) {
      if (isInside(f, full)) throw new HarnessError('permission_denied', `Chemin protégé par l’application : ${raw}`);
    }
    if (this.roots.some((r) => isInside(r, full))) return full;
    if (!opts.write && this.files.some((f) => norm(f) === norm(full))) return full;
    if (opts.write && this.files.some((f) => norm(f) === norm(full))) return full;
    throw new HarnessError('permission_denied', `Hors de la portée de la conversation : ${raw}. Accès limité à ${this.describe()}.`);
  }

  /** Affichage relatif à la racine qui contient le chemin. */
  display(full: string): string {
    const root = this.roots.find((r) => isInside(r, full));
    if (!root) return full;
    const rel = relative(root, full);
    return this.roots.length > 1 ? `${root.split(sep).pop()}/${rel.split(sep).join('/')}` : rel.split(sep).join('/') || '.';
  }

  describe(): string {
    const parts = [...this.roots, ...this.files];
    return parts.length ? parts.join(', ') : 'aucune ressource';
  }
}
