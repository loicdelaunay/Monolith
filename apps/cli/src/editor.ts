/** Tampon d'édition multiligne (logique pure, testée indépendamment de l'affichage). */
export interface EditorState {
  text: string;
  cursor: number;
}

export const empty = (): EditorState => ({ text: '', cursor: 0 });

export function insert(s: EditorState, value: string): EditorState {
  return { text: s.text.slice(0, s.cursor) + value + s.text.slice(s.cursor), cursor: s.cursor + value.length };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const prev = previousIndex(s.text, s.cursor);
  return { text: s.text.slice(0, prev) + s.text.slice(s.cursor), cursor: prev };
}

export function del(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return { text: s.text.slice(0, s.cursor) + s.text.slice(nextIndex(s.text, s.cursor)), cursor: s.cursor };
}

/** Déplacements par point de code (accents composés et emoji ne sont pas coupés en deux). */
function previousIndex(text: string, i: number): number {
  const segs = [...new Intl.Segmenter().segment(text.slice(0, i))];
  return i - (segs.at(-1)?.segment.length ?? 1);
}
function nextIndex(text: string, i: number): number {
  const first = new Intl.Segmenter().segment(text.slice(i))[Symbol.iterator]().next();
  return i + (first.done ? 1 : first.value.segment.length);
}

export function left(s: EditorState): EditorState {
  return { ...s, cursor: Math.max(0, previousIndex(s.text, s.cursor)) };
}
export function right(s: EditorState): EditorState {
  return { ...s, cursor: Math.min(s.text.length, nextIndex(s.text, s.cursor)) };
}

export function lineInfo(s: EditorState): { line: number; column: number; lines: string[] } {
  const lines = s.text.split('\n');
  let rest = s.cursor;
  for (let line = 0; line < lines.length; line++) {
    const len = lines[line]!.length;
    if (rest <= len) return { line, column: rest, lines };
    rest -= len + 1;
  }
  return { line: lines.length - 1, column: lines.at(-1)!.length, lines };
}

function offsetOf(lines: string[], line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i]!.length + 1;
  return offset + Math.min(column, lines[line]!.length);
}

/** Retourne null si le curseur est déjà sur la première/dernière ligne (le rappel d'historique prend le relais). */
export function up(s: EditorState): EditorState | null {
  const { line, column, lines } = lineInfo(s);
  return line === 0 ? null : { ...s, cursor: offsetOf(lines, line - 1, column) };
}
export function down(s: EditorState): EditorState | null {
  const { line, column, lines } = lineInfo(s);
  return line >= lines.length - 1 ? null : { ...s, cursor: offsetOf(lines, line + 1, column) };
}
export function home(s: EditorState): EditorState {
  const { line, lines } = lineInfo(s);
  return { ...s, cursor: offsetOf(lines, line, 0) };
}
export function end(s: EditorState): EditorState {
  const { line, lines } = lineInfo(s);
  return { ...s, cursor: offsetOf(lines, line, Number.MAX_SAFE_INTEGER) };
}
export function deleteWordBefore(s: EditorState): EditorState {
  const before = s.text.slice(0, s.cursor).replace(/\S+\s*$/u, '');
  return { text: before + s.text.slice(s.cursor), cursor: before.length };
}

/** Historique des messages envoyés, parcouru avec ↑/↓ (le brouillon courant est conservé). */
export class History {
  private index: number;
  private draft = '';
  constructor(private readonly items: string[] = []) {
    this.index = items.length;
  }
  push(text: string): void {
    if (text.trim() && this.items.at(-1) !== text) this.items.push(text);
    if (this.items.length > 200) this.items.shift();
    this.index = this.items.length;
  }
  previous(current: string): string | null {
    if (this.index === 0) return null;
    if (this.index === this.items.length) this.draft = current;
    return this.items[--this.index]!;
  }
  next(): string | null {
    if (this.index >= this.items.length) return null;
    this.index++;
    return this.index === this.items.length ? this.draft : this.items[this.index]!;
  }
  reset(): void {
    this.index = this.items.length;
  }
}
