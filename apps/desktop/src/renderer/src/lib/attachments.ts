import { ATTACHMENT_LIMITS, type AttachmentRef, type Id } from '@monolith/contracts';
import { api, errorMessage, host } from '../api.ts';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Envoie des fichiers ou dossiers au moteur, qui les valide (signature, taille, encodage) et les copie
 * dans l'espace de travail. Un élément du disque (sélecteur, glisser-déposer) passe par son chemin :
 * le moteur le lit directement, dossiers compris ; un contenu collé passe par son contenu.
 */
export async function uploadFiles(files: File[]): Promise<{ refs: AttachmentRef[]; errors: string[] }> {
  const refs: AttachmentRef[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const path = host.pathForFile(file);
    if (path) {
      const r = await attachPaths([path]);
      refs.push(...r.refs);
      errors.push(...r.errors);
      continue;
    }
    if (file.size > ATTACHMENT_LIMITS.fileBytes) {
      errors.push(`${file.name} : ${Math.round(file.size / 1048576)} Mo (maximum ${ATTACHMENT_LIMITS.fileBytes / 1048576} Mo)`);
      continue;
    }
    try {
      refs.push(await api.call('attachments.upload', { name: file.name || 'image.png', mime: file.type, dataBase64: toBase64(await file.arrayBuffer()) }));
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }
  return { refs, errors };
}

/** Fichiers ou dossiers du poste désignés par leur chemin (sélecteurs natifs). */
export async function attachPaths(paths: string[]): Promise<{ refs: AttachmentRef[]; errors: string[] }> {
  const refs: AttachmentRef[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      refs.push(await api.call('attachments.fromPath', { path }));
    } catch (e) {
      errors.push(errorMessage(e));
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
