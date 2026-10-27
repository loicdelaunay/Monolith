import { diffLines } from './diff.ts';

self.onmessage = (e: MessageEvent<{ id: number; before: string; after: string }>) => {
  self.postMessage({ id: e.data.id, blocks: diffLines(e.data.before, e.data.after) });
};
