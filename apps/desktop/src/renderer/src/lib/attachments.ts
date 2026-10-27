import { ATTACHMENT_LIMITS, type AttachmentRef, type Id } from '@monolith/contracts';
import { api } from '../api.ts';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Envoie des fichiers au moteur, qui les valide (signature, taille, encodage) et les copie
 * dans l'espace de travail. Retourne les références acceptées et les refus expliqués.
 */
export async function uploadFiles(files: File[]): Promise<{ refs: AttachmentRef[]; errors: string[] }> {
  const refs: AttachmentRef[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size > ATTACHMENT_LIMITS.imageBytes) {
      errors.push(`${file.name} : ${Math.round(file.size / 1048576)} Mo (maximum ${ATTACHMENT_LIMITS.imageBytes / 1048576} Mo)`);
      continue;
    }
    try {
      refs.push(await api.call('attachments.upload', { name: file.name || 'image.png', mime: file.type, dataBase64: toBase64(await file.arrayBuffer()) }));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { refs, errors };
}

const previews = new Map<Id, Promise<string>>();

/** URL locale (blob:) d'une image jointe, chargée une seule fois. */
export function previewUrl(id: Id): Promise<string> {
  let p = previews.get(id);
  if (!p) {
    p = api.call('attachments.read', { id }).then(({ mime, dataBase64 }) => {
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    });
    previews.set(id, p);
  }
  return p;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1048576).toFixed(1)} Mo`;
}
