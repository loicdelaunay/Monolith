import type { ToolDraftDelta } from '@monolith/contracts';

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

/**
 * JSON encore incomplet, tel qu'il arrive du modèle : renvoie ce qui est déjà lisible, y compris une chaîne
 * coupée au milieu. Seules les chaînes comptent ici : nombres et booléens valent null.
 */
export function parsePartialJson(raw: string): unknown {
  let i = 0;
  const skipSpaces = () => {
    while (i < raw.length && ' \n\r\t'.includes(raw[i]!)) i++;
  };
  const readString = (): string => {
    i++;
    let out = '';
    let start = i;
    while (i < raw.length) {
      const c = raw.charCodeAt(i);
      if (c === 34) {
        out += raw.slice(start, i);
        i++;
        return out;
      }
      if (c !== 92) {
        i++;
        continue;
      }
      out += raw.slice(start, i);
      const next = raw[i + 1];
      const hex = raw.slice(i + 2, i + 6);
      // Échappement coupé par la fin du fragment : il sera lu entier au fragment suivant.
      if (next === undefined || (next === 'u' && hex.length < 4)) {
        i = raw.length;
        return out;
      }
      if (next === 'u') {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        out += ESCAPES[next] ?? next;
        i += 2;
      }
      start = i;
    }
    return out + raw.slice(start);
  };
  const readValue = (): unknown => {
    skipSpaces();
    const c = raw[i];
    if (c === '"') return readString();
    if (c === '{') {
      i++;
      const object = Object.create(null) as Record<string, unknown>;
      for (;;) {
        skipSpaces();
        if (raw[i] === ',') {
          i++;
          continue;
        }
        if (raw[i] !== '"') {
          if (raw[i] === '}') i++;
          return object;
        }
        const key = readString();
        skipSpaces();
        if (raw[i] !== ':') return object;
        i++;
        skipSpaces();
        if (i >= raw.length) return object;
        object[key] = readValue();
      }
    }
    if (c === '[') {
      i++;
      const list: unknown[] = [];
      for (;;) {
        skipSpaces();
        if (raw[i] === ',') {
          i++;
          continue;
        }
        if (i >= raw.length || raw[i] === ']') {
          if (raw[i] === ']') i++;
          return list;
        }
        list.push(readValue());
      }
    }
    while (i < raw.length && !' \n\r\t,}]'.includes(raw[i]!)) i++;
    return null;
  };
  return readValue();
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const record = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const list = (value: unknown) => (Array.isArray(value) ? value : []);

/** Fichier visé et contenu écrit par un outil de fichiers ; null pour les autres outils. */
function draftOf(name: string, args: Record<string, unknown>): { path: string | null; text: string } | null {
  if (name === 'write_file') return { path: text(args.path) || null, text: text(args.content) };
  if (name === 'edit_file') return { path: text(args.path) || null, text: text(args.new_string) };
  if (name !== 'apply_patch') return null;
  const changes = list(args.changes).map(record);
  const body = (c: Record<string, unknown>) => text(c.content) || list(c.edits).map((e) => text(record(e).new_string)).join('\n');
  return { path: text(changes.at(-1)?.path) || null, text: changes.map((c) => `--- ${text(c.path)}\n${body(c)}`).join('\n\n') };
}

export const isDraftTool = (name: string) => name === 'write_file' || name === 'edit_file' || name === 'apply_patch';

/**
 * Aperçu des fichiers que le modèle est en train d'écrire. Il n'existe que le temps de l'écriture : jamais
 * enregistré dans le message ni renvoyé au modèle, et un appel coupé en route ne laisse aucune trace.
 */
export class ToolDrafts {
  private readonly calls = new Map<number, { name: string; raw: string; sent: string; path: string | null; dirty: boolean }>();

  update(index: number, name: string, raw: string): void {
    const call = this.calls.get(index);
    if (call) Object.assign(call, { name, raw, dirty: true });
    else this.calls.set(index, { name, raw, sent: '', path: null, dirty: true });
  }

  /** Changements depuis le dernier appel : le texte n'est transmis qu'à partir du premier caractère différent. */
  take(): ToolDraftDelta[] {
    const out: ToolDraftDelta[] = [];
    for (const [index, call] of this.calls) {
      if (!call.dirty) continue;
      call.dirty = false;
      const draft = draftOf(call.name, record(parsePartialJson(call.raw)));
      if (!draft || (draft.path === call.path && draft.text === call.sent)) continue;
      let offset = 0;
      while (offset < call.sent.length && call.sent.charCodeAt(offset) === draft.text.charCodeAt(offset)) offset++;
      out.push({ index, name: call.name, path: draft.path, offset, append: draft.text.slice(offset) });
      call.sent = draft.text;
      call.path = draft.path;
    }
    return out;
  }

  /** Vide l'aperçu ; indique s'il contenait quelque chose. */
  clear(): boolean {
    const had = this.calls.size > 0;
    this.calls.clear();
    return had;
  }
}
