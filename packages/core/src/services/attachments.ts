import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
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
const UNSUPPORTED = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|7z|rar|gz|exe|dll|bin)$/i;

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

/**
 * Pièces jointes : copies adressées par contenu dans `workspace/attachments/<sha256>`.
 * Joindre un fichier donne accès à ce seul contenu, jamais à son dossier d'origine.
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
    const maxB64 = Math.ceil((ATTACHMENT_LIMITS.imageBytes * 4) / 3) + 8;
    if (dataBase64.length > maxB64) throw new HarnessError('invalid_argument', `Fichier trop volumineux (images ≤ ${ATTACHMENT_LIMITS.imageBytes / 1048576} Mo, texte ≤ ${ATTACHMENT_LIMITS.textBytes / 1048576} Mo)`);
    const bytes = Buffer.from(dataBase64, 'base64');
    return this.store(cleanName(name), typeof mime === 'string' ? mime.toLowerCase() : '', bytes);
  }

  /** Lecture d'un fichier choisi explicitement par l'utilisateur (CLI). */
  uploadFile(path: string): AttachmentRef {
    const bytes = readFileSync(path);
    if (bytes.length > ATTACHMENT_LIMITS.imageBytes) throw new HarnessError('invalid_argument', 'Fichier trop volumineux');
    return this.store(cleanName(path), '', bytes);
  }

  private store(name: string, declaredMime: string, bytes: Buffer): AttachmentRef {
    if (bytes.length === 0) throw new HarnessError('invalid_argument', 'Fichier vide');
    const ext = extname(name).toLowerCase();
    const imageMime = sniffImage(bytes);
    let kind: AttachmentKind;
    let mime: string;
    if (imageMime) {
      if (bytes.length > ATTACHMENT_LIMITS.imageBytes) throw new HarnessError('invalid_argument', `Image trop volumineuse (${ATTACHMENT_LIMITS.imageBytes / 1048576} Mo maximum)`);
      kind = 'image';
      mime = imageMime;
    } else if (IMAGE_EXT[ext] || declaredMime.startsWith('image/')) {
      throw new HarnessError('invalid_argument', `« ${name} » n'est pas une image PNG, JPEG, WebP ou GIF valide`);
    } else if (UNSUPPORTED.test(name) || !isUtf8Text(bytes)) {
      throw new HarnessError(
        'invalid_argument',
        `Format non pris en charge pour « ${name} » : images PNG, JPEG, WebP, GIF (≤ ${ATTACHMENT_LIMITS.imageBytes / 1048576} Mo) et fichiers texte UTF-8 (≤ ${ATTACHMENT_LIMITS.textBytes / 1048576} Mo). L'extraction des PDF et documents bureautiques n'est pas encore disponible.`,
      );
    } else {
      if (bytes.length > ATTACHMENT_LIMITS.textBytes) throw new HarnessError('invalid_argument', `Fichier texte trop volumineux (${ATTACHMENT_LIMITS.textBytes / 1048576} Mo maximum)`);
      kind = 'text';
      mime = declaredMime && declaredMime.startsWith('text/') ? declaredMime : 'text/plain';
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = join(this.dir, sha256);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    const { lastInsertRowid } = this.db.run('INSERT INTO attachments (sha256, name, mime, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)', sha256, name, mime, bytes.length, kind, now());
    return { id: lastInsertRowid, name, mime, size: bytes.length, kind };
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

  private row(id: Id): AttachmentRow {
    const r = this.db.get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', `Pièce jointe ${id} introuvable`);
    return r;
  }
}
