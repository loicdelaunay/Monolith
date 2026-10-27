import { closeSync, openSync, readSync } from 'node:fs';
import type { GgufMeta } from '@monolith/contracts';

/** Lecture séquentielle d'un fichier par blocs (les métadonnées GGUF peuvent dépasser 10 Mo : vocabulaire). */
class Reader {
  private buf = Buffer.alloc(0);
  private pos = 0;
  private fileOffset = 0;

  constructor(private readonly fd: number) {}

  private ensure(n: number): void {
    if (this.buf.length - this.pos >= n) return;
    const rest = this.buf.subarray(this.pos);
    const chunk = Buffer.alloc(Math.max(n, 1 << 20));
    const read = readSync(this.fd, chunk, 0, chunk.length, this.fileOffset);
    this.fileOffset += read;
    this.buf = Buffer.concat([rest, chunk.subarray(0, read)]);
    this.pos = 0;
    if (this.buf.length < n) throw new Error('Fichier GGUF tronqué');
  }

  u8() {
    this.ensure(1);
    return this.buf.readUInt8(this.pos++);
  }
  u32() {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Valeur GGUF hors limites');
    return Number(v);
  }
  skip(n: number) {
    while (n > 0) {
      this.ensure(1);
      const step = Math.min(n, this.buf.length - this.pos);
      this.pos += step;
      n -= step;
    }
  }
  string() {
    const len = this.u64();
    if (len > 64 * 1024 * 1024) throw new Error('Chaîne GGUF trop longue');
    this.ensure(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function readValue(r: Reader, type: number): unknown {
  switch (type) {
    case 0:
      return r.u8();
    case 4:
      return r.u32();
    case 5: {
      const v = r.u32();
      return v > 0x7fffffff ? v - 0x100000000 : v;
    }
    case 7:
      return r.u8() !== 0;
    case 8:
      return r.string();
    case 10:
    case 11:
      return r.u64();
    case 9: {
      const inner = r.u32();
      const count = r.u64();
      // Tableaux (vocabulaire…) : ignorés, sauf leur taille.
      if (inner === 8) for (let i = 0; i < count; i++) r.skip(r.u64());
      else if (SIZES[inner]) r.skip(SIZES[inner]! * count);
      else throw new Error(`Type de tableau GGUF inconnu : ${inner}`);
      return { array: count };
    }
    default: {
      const size = SIZES[type];
      if (!size) throw new Error(`Type GGUF inconnu : ${type}`);
      r.skip(size);
      return null;
    }
  }
}

/** Métadonnées d'un fichier GGUF (v2/v3) : architecture, contexte, couches, têtes d'attention. */
export function readGgufMeta(path: string): GgufMeta {
  const fd = openSync(path, 'r');
  try {
    const r = new Reader(fd);
    const magic = Buffer.from([r.u8(), r.u8(), r.u8(), r.u8()]).toString('latin1');
    if (magic !== 'GGUF') throw new Error('Ce fichier n’est pas au format GGUF');
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`Version GGUF non prise en charge : ${version}`);
    r.u64(); // nombre de tenseurs
    const kvCount = r.u64();
    const kv = new Map<string, unknown>();
    for (let i = 0; i < kvCount; i++) {
      const key = r.string();
      kv.set(key, readValue(r, r.u32()));
    }
    const arch = typeof kv.get('general.architecture') === 'string' ? (kv.get('general.architecture') as string) : null;
    const num = (k: string) => (typeof kv.get(`${arch}.${k}`) === 'number' ? (kv.get(`${arch}.${k}`) as number) : null);
    return {
      architecture: arch,
      name: typeof kv.get('general.name') === 'string' ? (kv.get('general.name') as string) : null,
      contextLength: num('context_length'),
      blockCount: num('block_count'),
      embeddingLength: num('embedding_length'),
      headCount: num('attention.head_count'),
      headCountKv: num('attention.head_count_kv') ?? num('attention.head_count'),
      hasChatTemplate: typeof kv.get('tokenizer.chat_template') === 'string',
    };
  } finally {
    closeSync(fd);
  }
}

/** Écriture d'un GGUF minimal (tests et vérifications). */
export function writeGgufForTest(entries: Record<string, string | number | boolean>): Buffer {
  const parts: Buffer[] = [Buffer.from('GGUF', 'latin1')];
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
  parts.push(u32(3), u64(0), u64(Object.keys(entries).length));
  for (const [k, v] of Object.entries(entries)) {
    parts.push(str(k));
    if (typeof v === 'string') parts.push(u32(8), str(v));
    else if (typeof v === 'boolean') parts.push(u32(7), Buffer.from([v ? 1 : 0]));
    else parts.push(u32(4), u32(v));
  }
  return Buffer.concat(parts);
}
