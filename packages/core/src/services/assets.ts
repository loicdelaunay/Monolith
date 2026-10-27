import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError, type AssetInfo, type AssetKind, type PixelAsset } from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import { encodePng } from '../util/png.ts';

const NAME = /^[\w.-]{1,80}$/;
const EXT: Record<AssetKind, string> = { svg: '.svg', pixel: '.pixel.json' };
const MAX_SVG = 2 * 1024 * 1024;

/**
 * SVG sûr : aucun script, gestionnaire d'événement, objet étranger ni lien externe.
 * Les assets sont affichés dans l'interface : on refuse plutôt que de corriger en silence.
 */
export function sanitizeSvg(svg: string): string {
  const s = svg.trim();
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s)) throw new HarnessError('invalid_argument', 'Contenu SVG attendu (élément <svg> racine).');
  if (s.length > MAX_SVG) throw new HarnessError('invalid_argument', 'SVG trop volumineux (2 Mo maximum).');
  if (/<script|<foreignObject|<iframe|<embed|<object/i.test(s)) throw new HarnessError('invalid_argument', 'SVG refusé : scripts et objets intégrés interdits.');
  if (/\son[a-z]+\s*=/i.test(s)) throw new HarnessError('invalid_argument', 'SVG refusé : gestionnaires d’événements (onload, onclick…) interdits.');
  if (/(href|src)\s*=\s*["']\s*(?!#|data:image\/)[^"']+["']/i.test(s) || /javascript:/i.test(s)) throw new HarnessError('invalid_argument', 'SVG refusé : seules les références internes (#id) et images data: sont autorisées.');
  return s;
}

const COLOR = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
const INDEX = '0123456789abcdefghijklmnopqrstuvwxyz';

export function parsePixel(content: string): PixelAsset {
  let p: PixelAsset;
  try {
    p = JSON.parse(content) as PixelAsset;
  } catch {
    throw new HarnessError('invalid_argument', 'Pixel art : JSON illisible');
  }
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 256 || p.height > 256) throw new HarnessError('invalid_argument', 'Pixel art : dimensions entières de 1 à 256 attendues');
  if (!Array.isArray(p.palette) || !p.palette.length || p.palette.length > 36 || !p.palette.every((c) => COLOR.test(c))) throw new HarnessError('invalid_argument', 'Pixel art : palette de 1 à 36 couleurs #rrggbb ou #rrggbbaa');
  if (!Array.isArray(p.frames) || !p.frames.length || p.frames.length > 64) throw new HarnessError('invalid_argument', 'Pixel art : 1 à 64 images');
  for (const [f, frame] of p.frames.entries()) {
    if (!Array.isArray(frame) || frame.length !== p.height) throw new HarnessError('invalid_argument', `Pixel art : l’image ${f + 1} doit avoir ${p.height} lignes`);
    for (const row of frame) {
      if (typeof row !== 'string' || row.length !== p.width) throw new HarnessError('invalid_argument', `Pixel art : chaque ligne doit avoir ${p.width} caractères`);
      for (const ch of row) if (INDEX.indexOf(ch.toLowerCase()) < 0 || INDEX.indexOf(ch.toLowerCase()) >= p.palette.length) throw new HarnessError('invalid_argument', `Pixel art : « ${ch} » n’est pas un indice de la palette`);
    }
  }
  return { width: p.width, height: p.height, palette: p.palette, frames: p.frames, fps: Math.min(30, Math.max(1, Number(p.fps) || 8)) };
}

/** Rendu PNG d'une image du pixel art (agrandie, sans lissage). */
export function pixelToPng(p: PixelAsset, scale: number, frame: number): { png: Buffer; width: number; height: number } {
  const s = Math.min(32, Math.max(1, Math.round(scale)));
  const rows = p.frames[Math.min(Math.max(0, frame), p.frames.length - 1)]!;
  const w = p.width * s;
  const h = p.height * s;
  const rgba = new Uint8Array(w * h * 4);
  const colors = p.palette.map((c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), c.length === 9 ? parseInt(c.slice(7, 9), 16) : 255]);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const col = colors[INDEX.indexOf(rows[y]![x]!.toLowerCase())]!;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) rgba.set(col, ((y * s + dy) * w + (x * s + dx)) * 4);
    }
  }
  return { png: encodePng(w, h, rgba), width: w, height: h };
}

/** Assets générés (SVG, pixel art) : dossier de l'espace de travail, formats ouverts. */
export class AssetService {
  constructor(
    private readonly dir: string,
    private readonly events: EventBus,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string, kind: AssetKind): string {
    if (!NAME.test(name)) throw new HarnessError('invalid_argument', 'Nom d’asset invalide (lettres, chiffres, points, tirets)');
    return join(this.dir, `${name}${EXT[kind]}`);
  }

  private find(name: string): { kind: AssetKind; file: string } {
    for (const kind of ['svg', 'pixel'] as AssetKind[]) {
      const file = this.file(name, kind);
      if (existsSync(file)) return { kind, file };
    }
    throw new HarnessError('not_found', `Asset « ${name} » introuvable`);
  }

  list(): AssetInfo[] {
    return readdirSync(this.dir)
      .map((f) => {
        const kind: AssetKind | null = f.endsWith('.pixel.json') ? 'pixel' : f.endsWith('.svg') ? 'svg' : null;
        if (!kind) return null;
        const st = statSync(join(this.dir, f));
        return { name: f.slice(0, -EXT[kind].length), kind, size: st.size, updatedAt: st.mtime.toISOString() };
      })
      .filter((x): x is AssetInfo => x !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(name: string): { kind: AssetKind; content: string } {
    const { kind, file } = this.find(name);
    return { kind, content: readFileSync(file, 'utf8') };
  }

  save(name: string, kind: AssetKind, content: string): AssetInfo {
    if (kind !== 'svg' && kind !== 'pixel') throw new HarnessError('invalid_argument', 'Type d’asset : svg ou pixel');
    const clean = kind === 'svg' ? sanitizeSvg(content) : JSON.stringify(parsePixel(content));
    const file = this.file(name, kind);
    const other = this.file(name, kind === 'svg' ? 'pixel' : 'svg');
    if (existsSync(other)) unlinkSync(other);
    writeFileSync(`${file}.tmp`, clean, 'utf8');
    renameSync(`${file}.tmp`, file);
    this.changed();
    return this.list().find((a) => a.name === name)!;
  }

  delete(name: string): void {
    unlinkSync(this.find(name).file);
    this.changed();
  }

  png(name: string, scale = 8, frame = 0): { png: Buffer; width: number; height: number } {
    const a = this.read(name);
    if (a.kind !== 'pixel') throw new HarnessError('invalid_argument', 'Export PNG côté moteur : pixel art uniquement (les SVG s’exportent depuis l’interface).');
    return pixelToPng(parsePixel(a.content), scale, frame);
  }

  private changed(): void {
    this.events.emit('assets.changed', { assets: this.list() });
  }
}
