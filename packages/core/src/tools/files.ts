import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { FileChange } from '@monolith/contracts';
import { globToRegExp } from '../permissions/engine.ts';

export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', 'target', '.next', '.nuxt', '.cache', 'coverage', '.idea', '.vs']);
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Lecture texte : refuse les binaires et les fichiers trop volumineux, avec un message explicite. */
export function readText(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`Ce n’est pas un fichier : ${path}`);
  if (st.size > MAX_TEXT_BYTES) throw new Error(`Fichier trop volumineux pour être lu en entier (${Math.round(st.size / 1048576)} Mo) : utilisez une plage de lignes ou grep.`);
  const buf = readFileSync(path);
  if (isBinary(buf)) throw new Error(`Fichier binaire non lisible comme texte : ${path}`);
  return buf.toString('utf8');
}

/** Parcours récursif borné, dossiers lourds ignorés sauf s'ils sont explicitement visés. */
export function walk(root: string, opts: { pattern?: string; max: number; includeDirs?: boolean }): { paths: string[]; truncated: boolean } {
  const re = opts.pattern ? globToRegExp(opts.pattern.replace(/^\.\//, '')) : null;
  const out: string[] = [];
  let truncated = false;
  const visit = (dir: string) => {
    if (out.length >= opts.max) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full).split(sep).join('/');
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) && !(opts.pattern ?? '').includes(name)) continue;
        if (opts.includeDirs && (!re || re.test(rel))) out.push(`${rel}/`);
        visit(full);
      } else if (!re || re.test(rel) || re.test(name)) {
        out.push(rel);
      }
      if (out.length >= opts.max) {
        truncated = true;
        return;
      }
    }
  };
  visit(root);
  return { paths: out, truncated };
}

/** Remplacement exact avec contrôle du nombre d'occurrences ; fins de ligne du fichier préservées. */
export function replaceInText(original: string, oldString: string, newString: string, replaceAll: boolean, path: string): string {
  const crlf = original.includes('\r\n');
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const find = oldString.replace(/\r\n/g, '\n');
  const repl = newString.replace(/\r\n/g, '\n');
  if (!find) throw new Error('old_string est vide : utilisez write_file pour créer ou remplacer un fichier.');
  const count = text.split(find).length - 1;
  if (count === 0) throw new Error(`Texte à remplacer introuvable dans ${path} (vérifiez espaces et indentation).`);
  if (count > 1 && !replaceAll) throw new Error(`Le texte à remplacer apparaît ${count} fois dans ${path} : précisez-le ou utilisez replace_all.`);
  const next = replaceAll ? text.split(find).join(repl) : text.replace(find, () => repl);
  return crlf ? next.replace(/\n/g, '\r\n') : next;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.mh-tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * Applique un lot de changements de façon atomique : tout ou rien. En cas d'échec en cours
 * d'écriture, les fichiers déjà modifiés sont restaurés.
 */
export function applyChanges(changes: (FileChange & { full: string })[]): void {
  const done: (FileChange & { full: string })[] = [];
  try {
    for (const c of changes) {
      if (c.status === 'deleted') rmSync(c.full, { force: true });
      else writeAtomic(c.full, c.after);
      done.push(c);
    }
  } catch (error) {
    for (const c of done.reverse()) {
      try {
        if (c.status === 'created') rmSync(c.full, { force: true });
        else writeAtomic(c.full, c.before);
      } catch {
        /* restauration au mieux */
      }
    }
    throw error;
  }
}

export function currentContent(full: string): { exists: boolean; content: string } {
  return existsSync(full) ? { exists: true, content: readText(full) } : { exists: false, content: '' };
}
