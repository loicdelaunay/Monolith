/** Différence ligne par ligne (Myers, O((N+M)·D)), regroupée en blocs : ajout, suppression, remplacement. */
export type DiffBlock =
  | { kind: 'equal'; lines: string[]; oldStart: number; newStart: number }
  | { kind: 'add'; lines: string[]; newStart: number }
  | { kind: 'remove'; lines: string[]; oldStart: number }
  | { kind: 'replace'; before: string[]; after: string[]; oldStart: number; newStart: number };

type Op = { t: '=' | '-' | '+'; line: string };

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!) ? v[k + 1 + max]! : v[k - 1 + max]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        return backtrack(trace, a, b, max);
      }
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], max: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 2; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!) ? k + 1 : k - 1;
    const prevX = v[prevK + max]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ t: '=', line: a[--x]! }), y--;
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', line: b[--y]! });
      else ops.push({ t: '-', line: a[--x]! });
    }
  }
  return ops.reverse();
}

export function diffLines(before: string, after: string): DiffBlock[] {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  // Préfixe et suffixe communs retirés : le calcul porte sur la zone modifiée.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [
    ...a.slice(0, pre).map((line) => ({ t: '=' as const, line })),
    ...myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((line) => ({ t: '=' as const, line })),
  ];
  const blocks: DiffBlock[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < ops.length; ) {
    const t = ops[i]!.t;
    if (t === '=') {
      const lines: string[] = [];
      while (i < ops.length && ops[i]!.t === '=') lines.push(ops[i++]!.line);
      blocks.push({ kind: 'equal', lines, oldStart: oldLine, newStart: newLine });
      oldLine += lines.length;
      newLine += lines.length;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ops.length && ops[i]!.t !== '=') {
      if (ops[i]!.t === '-') removed.push(ops[i]!.line);
      else added.push(ops[i]!.line);
      i++;
    }
    if (removed.length && added.length) blocks.push({ kind: 'replace', before: removed, after: added, oldStart: oldLine, newStart: newLine });
    else if (removed.length) blocks.push({ kind: 'remove', lines: removed, oldStart: oldLine });
    else blocks.push({ kind: 'add', lines: added, newStart: newLine });
    oldLine += removed.length;
    newLine += added.length;
  }
  return blocks;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (blocks: DiffBlock[]) => void>();

/** Calcul hors du thread d'interface pour les gros contenus (Web Worker), direct sinon. */
export function diffAsync(before: string, after: string): Promise<DiffBlock[]> {
  if (before.length + after.length < 40_000) return Promise.resolve(diffLines(before, after));
  if (!worker) {
    worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; blocks: DiffBlock[] }>) => {
      pending.get(e.data.id)?.(e.data.blocks);
      pending.delete(e.data.id);
    };
  }
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ id, before, after });
  });
}
