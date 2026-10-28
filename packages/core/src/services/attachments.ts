import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ATTACHMENT_LIMITS, HarnessError, type AttachmentKind, type AttachmentRef, type Id } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import { now } from '../util.ts';

interface AttachmentRow {
  id: number;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
}

const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/** Formats binaires connus : jamais traités comme du texte, même si leurs premiers octets le permettraient. */
const BINARY = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|7z|rar|gz|tgz|tar|exe|dll|bin|so|dylib|class|jar|wasm|mp3|mp4|mov|avi|mkv|wav|flac|ogg|ico|psd|sqlite|db)$/i;
/** Dossiers ignorés quand un dossier est joint (dépendances, historique Git, caches). */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.turbo', '.cache']);
/** Texte transmis tel quel au modèle ; au-delà, début du texte et chemin de la copie lisible par les outils. */
const INLINE_TEXT = 1024 * 1024;
const TEXT_HEAD = 256 * 1024;
/** Dossier joint : arborescence et fichiers texte courts transmis dans ce budget. */
const FOLDER_TREE_LINES = 300;
const FOLDER_FILE_INLINE = 64 * 1024;
const FOLDER_BUDGET = 256 * 1024;

/** Type réel d'une image d'après sa signature (le nom et le type déclaré ne suffisent pas). */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function cleanName(name: unknown): string {
  const n = basename(String(name ?? '')).replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').trim();
  return (n || 'fichier').slice(0, 200);
}

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} Mo`;
const size = (bytes: number) => (bytes < 1024 ? `${bytes} o` : bytes < 1048576 ? `${Math.round(bytes / 1024)} Ko` : `${(bytes / 1048576).toFixed(1)} Mo`);

/**
 * Pièces jointes : copies adressées par contenu dans `workspace/attachments/<sha256>` (fichiers) et
 * `workspace/attachments/folders/<sha256>/<nom>` (dossiers). Joindre un fichier ou un dossier donne accès
 * à cette copie seulement, jamais à l'original ; les outils de l'agent la lisent sans pouvoir la modifier.
 */
export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  upload(name: string, mime: string, dataBase64: string): AttachmentRef {
    if (typeof dataBase64 !== 'string') throw new HarnessError('invalid_argument', 'Contenu de pièce jointe invalide');
    const maxB64 = Math.ceil((ATTACHMENT_LIMITS.fileBytes * 4) / 3) + 8;
    if (dataBase64.length > maxB64) throw new HarnessError('invalid_argument', `Fichier trop volumineux (${mb(ATTACHMENT_LIMITS.fileBytes)} maximum)`);
    const bytes = Buffer.from(dataBase64, 'base64');
    return this.store(cleanName(name), typeof mime === 'string' ? mime.toLowerCase() : '', bytes);
  }

  /** Image produite par un outil (capture). */
  storeImage(name: string, dataBase64: string): AttachmentRef {
    return this.store(cleanName(name), 'image/png', Buffer.from(dataBase64, 'base64'));
  }

  /** Fichier choisi explicitement par l'utilisateur (CLI). */
  uploadFile(path: string): AttachmentRef {
    return this.fromPath(path);
  }

  /** Fichier ou dossier choisi par l'utilisateur sur ce poste (sélecteur, glisser-déposer, CLI) : copié. */
  fromPath(path: unknown): AttachmentRef {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new HarnessError('invalid_argument', 'Chemin absolu attendu');
    const full = resolve(path);
    let st;
    try {
      st = statSync(full);
    } catch {
      throw new HarnessError('not_found', `Introuvable : ${full}`);
    }
    if (st.isDirectory()) return this.storeFolder(full);
    if (!st.isFile()) throw new HarnessError('invalid_argument', `Ni fichier ni dossier : ${full}`);
    if (st.size > ATTACHMENT_LIMITS.fileBytes) throw new HarnessError('invalid_argument', `« ${basename(full)} » : ${mb(st.size)} (${mb(ATTACHMENT_LIMITS.fileBytes)} maximum)`);
    return this.store(cleanName(full), '', readFileSync(full));
  }

  private store(name: string, declaredMime: string, bytes: Buffer): AttachmentRef {
    if (bytes.length === 0) throw new HarnessError('invalid_argument', 'Fichier vide');
    if (bytes.length > ATTACHMENT_LIMITS.fileBytes) throw new HarnessError('invalid_argument', `« ${name} » : ${mb(bytes.length)} (${mb(ATTACHMENT_LIMITS.fileBytes)} maximum)`);
    const ext = extname(name).toLowerCase();
    const imageMime = sniffImage(bytes);
    let kind: AttachmentKind;
    let mime: string;
    if (imageMime) {
      // Au-delà de la taille acceptée par les fournisseurs, l'image reste un fichier lisible par les outils.
      kind = bytes.length <= ATTACHMENT_LIMITS.imageBytes ? 'image' : 'file';
      mime = imageMime;
    } else if (IMAGE_EXT[ext] || declaredMime.startsWith('image/')) {
      throw new HarnessError('invalid_argument', `« ${name} » n'est pas une image PNG, JPEG, WebP ou GIF valide`);
    } else if (!BINARY.test(name) && isUtf8Text(bytes)) {
      kind = 'text';
      mime = declaredMime && declaredMime.startsWith('text/') ? declaredMime : 'text/plain';
    } else {
      kind = 'file';
      mime = declaredMime || 'application/octet-stream';
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = join(this.dir, sha256);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    return this.insert(sha256, name, mime, bytes.length, kind);
  }

  /** Dossier : copie complète (hors dépendances, Git et caches), liens symboliques ignorés, taille bornée. */
  private storeFolder(source: string): AttachmentRef {
    const name = cleanName(source);
    const files: { rel: string; full: string; size: number }[] = [];
    let total = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink() || lstatSync(full).isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile()) {
          const s = statSync(full).size;
          total += s;
          files.push({ rel: relative(source, full), full, size: s });
          if (total > ATTACHMENT_LIMITS.fileBytes) throw new HarnessError('invalid_argument', `Dossier « ${name} » trop volumineux : plus de ${mb(ATTACHMENT_LIMITS.fileBytes)} (dépendances, .git et caches déjà exclus)`);
          if (files.length > ATTACHMENT_LIMITS.folderFiles) throw new HarnessError('invalid_argument', `Dossier « ${name} » : plus de ${ATTACHMENT_LIMITS.folderFiles} fichiers`);
        }
      }
    };
    walk(source);
    if (files.length === 0) throw new HarnessError('invalid_argument', `Dossier « ${name} » vide`);
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    const folders = join(this.dir, 'folders');
    const tmp = join(folders, `.tmp-${randomBytes(6).toString('hex')}`);
    const hash = createHash('sha256').update(name);
    try {
      for (const f of files) {
        const dest = join(tmp, name, f.rel);
        mkdirSync(join(dest, '..'), { recursive: true });
        copyFileSync(f.full, dest);
        hash.update(`\n${f.rel.split(sep).join('/')}\n`).update(createHash('sha256').update(readFileSync(dest)).digest('hex'));
      }
      const sha256 = hash.digest('hex');
      const final = join(folders, sha256);
      if (existsSync(final)) rmSync(tmp, { recursive: true, force: true });
      else renameSync(tmp, final);
      return this.insert(sha256, name, 'inode/directory', total, 'folder');
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  private insert(sha256: string, name: string, mime: string, bytes: number, kind: AttachmentKind): AttachmentRef {
    const { lastInsertRowid } = this.db.run('INSERT INTO attachments (sha256, name, mime, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', sha256, name, mime, bytes, kind, now());
    return { id: lastInsertRowid, name, mime, size: bytes, kind };
  }

  get(id: Id): AttachmentRef {
    const r = this.row(id);
    return { id: r.id, name: r.name, mime: r.mime, size: r.size, kind: r.kind as AttachmentKind };
  }

  /** Vérifie une liste d'identifiants transmise par une interface et retourne les références. */
  resolve(ids: unknown): AttachmentRef[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new HarnessError('invalid_argument', 'Liste de pièces jointes invalide');
    if (ids.length > ATTACHMENT_LIMITS.perMessage) throw new HarnessError('invalid_argument', `${ATTACHMENT_LIMITS.perMessage} pièces jointes maximum par message`);
    return ids.map((id) => this.get(Number(id)));
  }

  bytes(id: Id): Buffer {
    const r = this.row(id);
    if (r.kind === 'folder') throw new HarnessError('invalid_argument', `« ${r.name} » est un dossier`);
    const file = join(this.dir, r.sha256);
    if (!existsSync(file)) throw new HarnessError('not_found', `Contenu de la pièce jointe « ${r.name} » introuvable`);
    return readFileSync(file);
  }

  text(id: Id): string {
    return this.bytes(id).toString('utf8');
  }

  dataUrl(id: Id): string {
    const r = this.row(id);
    return `data:${r.mime};base64,${this.bytes(id).toString('base64')}`;
  }

  /**
   * Copie lisible par les outils de l'agent : le dossier copié, ou le fichier sous son nom
   * (`files/<sha256>/<nom>`, lien physique vers le contenu stocké, sinon copie).
   */
  agentPath(id: Id): string {
    const r = this.row(id);
    if (r.kind === 'folder') return join(this.dir, 'folders', r.sha256, r.name);
    const named = join(this.dir, 'files', r.sha256, r.name);
    if (!existsSync(named)) {
      const stored = join(this.dir, r.sha256);
      if (!existsSync(stored)) throw new HarnessError('not_found', `Contenu de la pièce jointe « ${r.name} » introuvable`);
      mkdirSync(join(named, '..'), { recursive: true });
      try {
        linkSync(stored, named);
      } catch {
        copyFileSync(stored, named);
      }
    }
    return named;
  }

  /**
   * Contenu transmis au modèle pour une pièce jointe autre qu'une image : texte complet jusqu'à 1 Mo,
   * sinon début du texte ; fichier binaire décrit ; dossier : arborescence et fichiers texte courts.
   * Le chemin de la copie est indiqué pour une lecture complète par les outils (mode Agent).
   */
  promptText(id: Id): string {
    const r = this.row(id);
    if (r.kind === 'text') {
      if (r.size <= INLINE_TEXT) return this.text(id);
      const head = this.bytes(id).subarray(0, TEXT_HEAD).toString('utf8').replace(/�+$/, '');
      return `${head}\n[… début seulement : ${size(r.size)} au total. Fichier complet lisible par les outils en mode Agent : ${this.agentPath(id)}]`;
    }
    if (r.kind === 'file') return `[Fichier ${r.mime} de ${size(r.size)}, contenu non affiché. Lisible par les outils en mode Agent : ${this.agentPath(id)}]`;
    if (r.kind !== 'folder') return '';
    const root = this.agentPath(id);
    const all: { rel: string; size: number }[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else all.push({ rel: relative(root, full).split(sep).join('/'), size: statSync(full).size });
      }
    };
    walk(root);
    all.sort((a, b) => a.rel.localeCompare(b.rel));
    const out = [`[Dossier joint : ${all.length} fichier(s), ${size(r.size)}. Copie complète lisible par les outils en mode Agent : ${root}]`, '', 'Arborescence :'];
    out.push(...all.slice(0, FOLDER_TREE_LINES).map((f) => `- ${f.rel} (${size(f.size)})`));
    if (all.length > FOLDER_TREE_LINES) out.push(`- … ${all.length - FOLDER_TREE_LINES} autre(s) fichier(s)`);
    let budget = FOLDER_BUDGET;
    const skipped: string[] = [];
    for (const f of all) {
      if (f.size > FOLDER_FILE_INLINE || BINARY.test(f.rel) || IMAGE_EXT[extname(f.rel).toLowerCase()]) continue;
      const bytes = readFileSync(join(root, f.rel));
      if (!isUtf8Text(bytes)) continue;
      if (bytes.length > budget) {
        skipped.push(f.rel);
        continue;
      }
      budget -= bytes.length;
      out.push('', `<<< ${f.rel} >>>`, bytes.toString('utf8'));
    }
    if (skipped.length) out.push('', `[Contenu non inclus faute de place (lisible par les outils) : ${skipped.slice(0, 50).join(', ')}${skipped.length > 50 ? '…' : ''}]`);
    return out.join('\n');
  }

  private row(id: Id): AttachmentRow {
    const r = this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', `Pièce jointe ${id} introuvable`);
    return r;
  }
}
