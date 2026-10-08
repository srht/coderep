import type { FileEntry } from './symbols.js';

const DAMPING = 0.85;
const ITERATIONS = 20;

/**
 * PageRank over the import graph. A file many others import is more likely to
 * be the one worth showing first in a repo map, which is why aider's repo map
 * ranks this way too.
 */
export function rankFiles(entries: FileEntry[]): void {
  const count = entries.length;
  if (count === 0) return;

  const indexOf = new Map<string, number>();
  entries.forEach((entry, i) => indexOf.set(entry.path, i));

  // Incoming edges per file, and how many outgoing edges each source has.
  const incoming: number[][] = entries.map(() => []);
  const outDegree = new Array<number>(count).fill(0);

  entries.forEach((entry, from) => {
    const seen = new Set<number>();
    for (const target of entry.imports) {
      const to = indexOf.get(target);
      if (to === undefined || to === from || seen.has(to)) continue;
      seen.add(to);
      (incoming[to] as number[]).push(from);
      outDegree[from] = (outDegree[from] ?? 0) + 1;
    }
  });

  let rank = new Array<number>(count).fill(1 / count);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const next = new Array<number>(count).fill((1 - DAMPING) / count);
    // Files that import nothing would leak rank; spread theirs evenly instead.
    let danglingMass = 0;
    for (let i = 0; i < count; i += 1) {
      if ((outDegree[i] ?? 0) === 0) danglingMass += rank[i] as number;
    }
    const danglingShare = (DAMPING * danglingMass) / count;

    for (let to = 0; to < count; to += 1) {
      let sum = 0;
      for (const from of incoming[to] as number[]) {
        sum += (rank[from] as number) / (outDegree[from] as number);
      }
      next[to] = (next[to] as number) + DAMPING * sum + danglingShare;
    }
    rank = next;
  }

  entries.forEach((entry, i) => {
    entry.rank = rank[i] as number;
  });
}
