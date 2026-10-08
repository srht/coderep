import { describe, expect, it } from 'vitest';
import { rankFiles } from '../src/graph.js';
import { buildIndex } from '../src/store.js';
import type { FileEntry } from '../src/symbols.js';
import { makeRepo } from './helpers.js';

const entry = (path: string, imports: string[]): FileEntry => ({
  path,
  hash: path,
  lang: 'ts',
  symbols: [],
  imports,
  specifiers: [],
  rank: 0,
});

describe('rankFiles', () => {
  it('ranks a widely imported hub above its importers', () => {
    const entries = [
      entry('src/hub.ts', []),
      entry('src/a.ts', ['src/hub.ts']),
      entry('src/b.ts', ['src/hub.ts']),
      entry('src/c.ts', ['src/hub.ts']),
      entry('src/leaf.ts', []),
    ];
    rankFiles(entries);

    const rankOf = (path: string): number => entries.find((item) => item.path === path)?.rank ?? 0;
    expect(rankOf('src/hub.ts')).toBeGreaterThan(rankOf('src/a.ts'));
    expect(rankOf('src/hub.ts')).toBeGreaterThan(rankOf('src/leaf.ts'));
  });

  it('is stable on an import cycle and conserves total rank', () => {
    const entries = [
      entry('src/a.ts', ['src/b.ts']),
      entry('src/b.ts', ['src/c.ts']),
      entry('src/c.ts', ['src/a.ts']),
    ];
    rankFiles(entries);

    for (const item of entries) {
      expect(Number.isFinite(item.rank)).toBe(true);
      expect(item.rank).toBeGreaterThan(0);
    }
    // Dangling mass is redistributed rather than leaked, so ranks still sum to 1.
    const total = entries.reduce((sum, item) => sum + item.rank, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('conserves total rank when nothing imports anything', () => {
    const entries = [entry('src/a.ts', []), entry('src/b.ts', [])];
    rankFiles(entries);
    expect(entries.reduce((sum, item) => sum + item.rank, 0)).toBeCloseTo(1, 5);
    expect(entries[0]?.rank).toBeCloseTo(entries[1]?.rank ?? 0, 10);
  });

  it('ignores self-imports and duplicate edges', () => {
    const entries = [entry('src/a.ts', ['src/a.ts', 'src/b.ts', 'src/b.ts']), entry('src/b.ts', [])];
    rankFiles(entries);
    expect(entries.reduce((sum, item) => sum + item.rank, 0)).toBeCloseTo(1, 5);
  });

  it('handles an empty repository', () => {
    const entries: FileEntry[] = [];
    expect(() => rankFiles(entries)).not.toThrow();
  });

  it('ranks a real barrel file highest end to end', async () => {
    const repo = await makeRepo({
      'src/util.ts': `export const shared = 1;\n`,
      'src/a.ts': `import { shared } from './util';\nexport const a = shared;\n`,
      'src/b.ts': `import { shared } from './util';\nexport const b = shared;\n`,
      'src/c.ts': `import { shared } from './util';\nexport const c = shared;\n`,
    });
    try {
      const { index } = await buildIndex(repo);
      const sorted = index.files.slice().sort((x, y) => y.rank - x.rank);
      expect(sorted[0]?.path).toBe('src/util.ts');
    } finally {
      await repo.cleanup();
    }
  });
});
