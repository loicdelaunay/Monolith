import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { HarnessError, type FileContent, type FileEntry, type FileReference } from '@monolith/contracts';
import type { ResourceScope } from '../tools/scope.ts';
import { isBinary, SKIP_DIRS, walk } from '../tools/files.ts';
import { sniffImage } from './attachments.ts';

const MAX_PREVIEW_TEXT = 2 * 1024 * 1024;
const MAX_PREVIEW_IMAGE = 15 * 1024 * 1024;
const MIME: Record<string, string> = { '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css', '.ts': 'text/typescript', '.js': 'text/javascript' };

/**
 * Accès aux fichiers pour les panneaux de l'interface : lecture seule, dans la portée de la
 * conversation (mêmes règles que les outils : chemins canonisés, données de l'application exclues).
 */
export class WorkspaceFiles {
  list(scope: ResourceScope, path: string | undefined): { root: string; entries: FileEntry[] } {
    if (!path) {
      // Racines et fichiers isolés de la conversation.
      const entries: FileEntry[] = [
        ...scope.roots.map((r) => ({ name: basename(r) || r, path: r, display: r, type: 'directory' as const, size: 0 })),
        ...scope.files.map((f) => ({ name: basename(f), path: f, display: f, type: 'file' as const, size: safeSize(f) })),
      ];
      return { root: '', entries };
    }
    const dir = scope.resolve(path);
    if (!statSync(dir).isDirectory()) throw new HarnessError('invalid_argument', 'Ce n’est pas un dossier');
    const entries: FileEntry[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      try {
        scope.resolve(full); // exclut les liens qui sortent de la portée et les données protégées
      } catch {
        continue;
      }
      entries.push({ name, path: full, display: scope.display(full), type: st.isDirectory() ? 'directory' : 'file', size: st.isDirectory() ? 0 : st.size });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    return { root: dir, entries };
  }

  read(scope: ResourceScope, path: string): FileContent {
    const full = scope.resolve(path);
    const st = statSync(full);
    if (!st.isFile()) throw new HarnessError('invalid_argument', 'Ce n’est pas un fichier');
    const base = { path: full, display: scope.display(full), size: st.size };
    const ext = extname(full).toLowerCase();
    if (st.size > MAX_PREVIEW_IMAGE) return { ...base, kind: 'too_large', mime: 'application/octet-stream' };
    const buf = readFileSync(full);
    const image = sniffImage(buf);
    if (image) return { ...base, kind: 'image', mime: image, dataBase64: buf.toString('base64') };
    if (ext === '.svg' && st.size <= MAX_PREVIEW_TEXT) return { ...base, kind: 'text', mime: 'image/svg+xml', text: buf.toString('utf8') };
    if (isBinary(buf)) return { ...base, kind: 'binary', mime: 'application/octet-stream' };
    if (st.size > MAX_PREVIEW_TEXT) return { ...base, kind: 'too_large', mime: 'text/plain' };
    return { ...base, kind: 'text', mime: MIME[ext] ?? 'text/plain', text: buf.toString('utf8') };
  }

  /** Références citées (`chemin`, `chemin:ligne`, `chemin#L12`) : seules celles qui existent deviennent des badges. */
  stat(scope: ResourceScope, references: string[]): FileReference[] {
    return references.slice(0, 200).map((input) => {
      const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(input.trim());
      const raw = m?.[1] ?? input;
      const line = m?.[2] ? Number(m[2]) : m?.[3] ? Number(m[3]) : null;
      const none: FileReference = { input, exists: false, path: null, display: null, type: null, line };
      if (!raw || raw.length > 400 || /[<>|"*?\n]/.test(raw)) return none;
      const candidates = isAbsolute(raw) ? [raw] : scope.roots.map((r) => join(r, raw));
      for (const c of candidates) {
        try {
          const full = scope.resolve(c);
          const st = statSync(full);
          return { input, exists: true, path: full, display: scope.display(full), type: st.isDirectory() ? 'directory' : 'file', line };
        } catch {
          /* candidat suivant */
        }
      }
      return none;
    });
  }

  search(scope: ResourceScope, query: string, content: boolean): { display: string; path: string; line: number | null; text: string | null }[] {
    const q = query.trim();
    if (!q) return [];
    const out: { display: string; path: string; line: number | null; text: string | null }[] = [];
    const lower = q.toLowerCase();
    for (const root of scope.roots) {
      for (const rel of walk(root, { max: 20_000 }).paths) {
        if (out.length >= 300) return out;
        const full = join(root, rel);
        if (!content) {
          if (rel.toLowerCase().includes(lower)) out.push({ display: scope.display(full), path: full, line: null, text: null });
          continue;
        }
        let buf: Buffer;
        try {
          if (statSync(full).size > 1024 * 1024) continue;
          buf = readFileSync(full);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        buf
          .toString('utf8')
          .split(/\r?\n/)
          .forEach((text, i) => {
            if (out.length < 300 && text.toLowerCase().includes(lower)) out.push({ display: scope.display(full), path: full, line: i + 1, text: text.slice(0, 200) });
          });
      }
    }
    return out;
  }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export { SKIP_DIRS };
