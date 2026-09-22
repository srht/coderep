import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bisect } from '../src/bisect.js';
import { createSnapshot } from '../src/shadow.js';
import { makeRepo, write } from './helpers.js';

/** A probe that passes only while value.txt holds "ok". */
const CHECK = ['node', '-e', 'process.exit(require("fs").readFileSync("value.txt","utf8").trim()==="ok"?0:1)'];

describe('bisect', () => {
  it('pinpoints the snapshot that introduced the breakage', async () => {
    const repo = await makeRepo();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        // The 4th snapshot (index 3) is where it breaks, and it stays broken.
        await write(repo, 'value.txt', i >= 3 ? 'bozuk' : 'ok');
        await write(repo, `noise-${i}.txt`, `${i}`);
        const snapshot = await createSnapshot(repo, { label: `adim ${i}`, source: 'watch' });
        ids.push(snapshot!.id);
      }

      const result = await bisect(repo, CHECK, { timeoutMs: 30_000 });

      expect(result.firstBad?.id).toBe(ids[3]);
      expect(result.lastGood?.id).toBe(ids[2]);
      expect(result.firstBad?.meta.label).toBe('adim 3');
      // Binary search, not a linear scan.
      expect(result.tested).toBeLessThan(10);
    } finally {
      await repo.cleanup();
    }
  });

  it('leaves the working tree untouched and cleans up its worktrees', async () => {
    const repo = await makeRepo();
    try {
      for (let i = 0; i < 6; i += 1) {
        await write(repo, 'value.txt', i >= 2 ? 'bozuk' : 'ok');
        await createSnapshot(repo, { source: 'watch' });
      }
      await write(repo, 'value.txt', 'calisma-dizini');

      await bisect(repo, CHECK, { timeoutMs: 30_000 });

      expect(await readFile(join(repo.root, 'value.txt'), 'utf8')).toBe('calisma-dizini');
      const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith('coderep-bisect-'));
      expect(leftovers).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports when nothing is broken', async () => {
    const repo = await makeRepo();
    try {
      for (let i = 0; i < 4; i += 1) {
        await write(repo, 'value.txt', 'ok');
        await write(repo, `n-${i}.txt`, `${i}`);
        await createSnapshot(repo, { source: 'watch' });
      }
      const result = await bisect(repo, CHECK, { timeoutMs: 30_000 });
      expect(result.firstBad).toBeNull();
      expect(result.reason).toContain('bozulma yok');
    } finally {
      await repo.cleanup();
    }
  });

  it('says so when the breakage predates the whole chain', async () => {
    const repo = await makeRepo();
    try {
      for (let i = 0; i < 4; i += 1) {
        await write(repo, 'value.txt', 'bozuk');
        await write(repo, `n-${i}.txt`, `${i}`);
        await createSnapshot(repo, { source: 'watch' });
      }
      const result = await bisect(repo, CHECK, { timeoutMs: 30_000 });
      expect(result.reason).toContain('daha geride');
      expect(result.lastGood).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
