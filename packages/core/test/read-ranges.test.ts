import { describe, expect, it } from 'vitest';
import { readLines } from '../src/tools/types.ts';

const text = Array.from({ length: 3000 }, (_, i) => `ligne ${i + 1}`).join('\n');

describe('lecture : contenu entier ou lignes X à Y', () => {
  it('sans plage : contenu entier, sans limite cachée de lignes', () => {
    const r = readLines(text, {}, 1_000_000);
    expect(r).toMatchObject({ start: 1, end: 3000, total: 3000, whole: true, next: null });
    expect(r.body.endsWith('ligne 3000')).toBe(true);
  });

  it('avec plage : exactement les lignes X à Y (incluses), numérotées sur demande', () => {
    const r = readLines(text, { start_line: 10, end_line: 12 }, 1_000_000, { numbered: true });
    expect(r).toMatchObject({ start: 10, end: 12, whole: false, next: null });
    expect(r.body.split('\n')).toEqual(['   10| ligne 10', '   11| ligne 11', '   12| ligne 12']);
    expect(readLines(text, { start_line: 2990 }, 1_000_000)).toMatchObject({ start: 2990, end: 3000 });
    expect(readLines(text, { end_line: 2 }, 1_000_000).body).toBe('ligne 1\nligne 2');
  });

  it('résultat trop long : coupé en fin de ligne, avec la plage exacte à relire', () => {
    const r = readLines(text, {}, 100);
    expect(r.whole).toBe(false);
    expect(r.next).toEqual({ start: r.end + 1, end: 3000 });
    expect(r.body).toContain(`relisez avec start_line=${r.end + 1} end_line=3000`);
    expect(r.body.split('\n')[0]).toBe('ligne 1');
  });

  it('plage hors limites : ramenée au contenu existant', () => {
    expect(readLines('a\nb', { start_line: 9, end_line: 50 }, 1000)).toMatchObject({ start: 2, end: 2 });
    expect(readLines('a\nb', { start_line: 0, end_line: -3 }, 1000)).toMatchObject({ start: 1, end: 1 });
  });
});
