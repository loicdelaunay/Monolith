/**
 * Parseur Server-Sent Events tolérant :
 *  - fragments arbitraires (un événement peut être coupé n'importe où, y compris dans un caractère UTF-8) ;
 *  - fins de ligne LF, CRLF ou CR ;
 *  - commentaires / keep-alive (`:`) ignorés ;
 *  - champs `data:` multiples concaténés ;
 *  - dernier événement émis même sans ligne vide finale.
 */
export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventName = '';
  private id: string | null = null;
  private readonly decoder = new TextDecoder('utf-8');
  private pendingCR = false;

  /** Ajoute un fragment et retourne les événements complets. */
  push(chunk: Uint8Array | string): SseEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.pendingCR) {
      // CRLF coupé entre deux fragments : le LF appartient au CR déjà traité.
      if (text.startsWith('\n')) text = text.slice(1);
      this.pendingCR = false;
    }
    this.buffer += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i++;
        } else {
          this.pendingCR = true;
        }
      }
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Fin de flux : vide le tampon et émet un éventuel événement non terminé. */
  end(): SseEvent[] {
    const rest = this.decoder.decode();
    const out = rest ? this.push(rest) : [];
    if (this.buffer.length > 0) {
      const ev = this.line(this.buffer);
      this.buffer = '';
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.eventName = value;
    else if (field === 'id') this.id = value;
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.data.length === 0) {
      this.eventName = '';
      return null;
    }
    const ev: SseEvent = { event: this.eventName || 'message', data: this.data.join('\n'), id: this.id };
    this.data = [];
    this.eventName = '';
    return ev;
  }
}
