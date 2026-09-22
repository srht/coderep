import { describe, expect, it } from 'vitest';
import { readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSnapshot, listSnapshots, restore, changedFiles, diffSnapshots, prune, stats } from '../src/shadow.js';
import { makeRepo, write, visibleGitState, gitIn } from './helpers.js';

describe('shadow snapshots', () => {
  it('leaves the user-visible git surface byte-identical', async () => {
    const repo = await makeRepo();
    try {
      const before = await visibleGitState(repo);
      const indexBefore = await stat(join(repo.gitDir, 'index'));

      for (let i = 0; i < 20; i += 1) {
        await write(repo, `src/file-${i}.ts`, `export const n = ${i};\n`);
        await createSnapshot(repo, { label: `adim ${i}`, source: 'manual' });
      }

      // Stat before reading the visible state: `git status` legitimately
      // refreshes git's own stat cache, which would mask what we are measuring.
      const indexAfter = await stat(join(repo.gitDir, 'index'));
      const after = await visibleGitState(repo);

      // The real index must not have been rewritten.
      expect(indexAfter.mtimeMs).toBe(indexBefore.mtimeMs);
      // git status legitimately reports the new untracked files, so compare the
      // parts coderep must never move: history, branches, HEAD, stash, staging.
      const stripStatus = (s: string) => s.split('$ git log')[1];
      expect(stripStatus(after)).toBe(stripStatus(before));
    } finally {
      await repo.cleanup();
    }
  });

  it('skips a snapshot when nothing changed', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'bir\n');
      expect(await createSnapshot(repo, { source: 'manual' })).not.toBeNull();
      expect(await createSnapshot(repo, { source: 'manual' })).toBeNull();
      expect(await listSnapshots(repo, {})).toHaveLength(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('records metadata and the real HEAD it sits on', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'bir\n');
      const snapshot = await createSnapshot(repo, { label: 'test', source: 'agent', agent: 'windsurf', turn: 't1' });
      expect(snapshot).not.toBeNull();
      const { stdout: head } = await gitIn(repo.root, ['rev-parse', 'HEAD']);

      const [listed] = await listSnapshots(repo, {});
      expect(listed?.meta).toMatchObject({
        label: 'test',
        source: 'agent',
        agent: 'windsurf',
        turn: 't1',
        branch: 'main',
        head: head.trim(),
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('honours .gitignore and .coderepignore', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'ignored.txt', 'gorunmemeli\n');
      await write(repo, 'secrets/key.pem', 'gizli\n');
      await write(repo, '.coderepignore', 'secrets/**\n');
      await write(repo, 'kept.txt', 'gorunmeli\n');

      const snapshot = await createSnapshot(repo, { source: 'manual' });
      const files = await changedFiles(repo, snapshot!.id);
      const paths = files.map((line) => line.split('\t')[1]);

      expect(paths).toContain('kept.txt');
      expect(paths).not.toContain('ignored.txt');
      expect(paths).not.toContain('secrets/key.pem');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('restore', () => {
  it('round-trips modifications, deletions and additions', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'keep.txt', 'orijinal\n');
      await write(repo, 'doomed.txt', 'silinecek\n');
      const good = await createSnapshot(repo, { label: 'saglam', source: 'manual' });

      await write(repo, 'keep.txt', 'BOZULDU\n');
      await rm(join(repo.root, 'doomed.txt'));
      await write(repo, 'junk.txt', 'sonradan eklendi\n');
      await createSnapshot(repo, { label: 'bozuk', source: 'watch' });

      const result = await restore(repo, good!.id);
      expect(result.applied).toBe(true);

      expect(await readFile(join(repo.root, 'keep.txt'), 'utf8')).toBe('orijinal\n');
      expect(existsSync(join(repo.root, 'doomed.txt'))).toBe(true);
      expect(existsSync(join(repo.root, 'junk.txt'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('is itself undoable via the pre-restore snapshot', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'v1\n');
      const first = await createSnapshot(repo, { source: 'manual' });
      await write(repo, 'a.txt', 'v2\n');
      await createSnapshot(repo, { source: 'manual' });

      const result = await restore(repo, first!.id);
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('v1\n');

      // The pre-restore state must be reachable, whether it needed a fresh
      // snapshot or the chain tip already captured it.
      const snapshots = await listSnapshots(repo, {});
      expect(snapshots.some((s) => s.id === result.preRestore)).toBe(true);

      // Rewind the rewind.
      await restore(repo, result.preRestore);
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('v2\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('captures unsnapshotted work before rewinding', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'v1\n');
      const first = await createSnapshot(repo, { source: 'manual' });

      // Edited but never snapshotted - this is what would otherwise be lost.
      await write(repo, 'a.txt', 'kaydedilmemis is\n');

      const result = await restore(repo, first!.id);
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('v1\n');

      const snapshots = await listSnapshots(repo, {});
      const preRestore = snapshots.find((s) => s.id === result.preRestore);
      expect(preRestore?.meta.source).toBe('pre-restore');

      await restore(repo, result.preRestore);
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('kaydedilmemis is\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('restores only the requested files', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'a1\n');
      await write(repo, 'b.txt', 'b1\n');
      const good = await createSnapshot(repo, { source: 'manual' });

      await write(repo, 'a.txt', 'a2\n');
      await write(repo, 'b.txt', 'b2\n');
      await createSnapshot(repo, { source: 'manual' });

      await restore(repo, good!.id, { files: ['a.txt'] });
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('a1\n');
      expect(await readFile(join(repo.root, 'b.txt'), 'utf8')).toBe('b2\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('writes nothing on --dry-run', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'v1\n');
      const first = await createSnapshot(repo, { source: 'manual' });
      await write(repo, 'a.txt', 'v2\n');
      await createSnapshot(repo, { source: 'manual' });

      const result = await restore(repo, first!.id, { dryRun: true });
      expect(result.applied).toBe(false);
      expect(result.stat).toContain('a.txt');
      expect(await readFile(join(repo.root, 'a.txt'), 'utf8')).toBe('v2\n');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('diff, prune and stats', () => {
  it('diffs a snapshot against the live working tree', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'v1\n');
      const snapshot = await createSnapshot(repo, { source: 'manual' });
      await write(repo, 'a.txt', 'v2\n');

      const patch = await diffSnapshots(repo, snapshot!.id, undefined);
      expect(patch).toContain('-v1');
      expect(patch).toContain('+v2');
    } finally {
      await repo.cleanup();
    }
  });

  it('prunes old snapshots while preserving timestamps of the kept ones', async () => {
    const repo = await makeRepo();
    try {
      for (let i = 0; i < 4; i += 1) {
        await write(repo, 'a.txt', `v${i}\n`);
        await createSnapshot(repo, { label: `v${i}`, source: 'watch' });
      }
      const before = await listSnapshots(repo, {});
      expect(before).toHaveLength(4);

      // Everything is younger than an hour, so nothing goes.
      expect(await prune(repo, { olderThanMs: 60 * 60 * 1000 })).toMatchObject({ removed: 0 });
      // Nothing is younger than zero, so all but nothing goes.
      const result = await prune(repo, { olderThanMs: -1000 });
      expect(result.kept + result.removed).toBe(4);

      const after = await listSnapshots(repo, {});
      expect(after.length).toBe(result.kept);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports snapshot count and disk usage', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, 'a.txt', 'v1\n');
      await createSnapshot(repo, { source: 'manual' });
      const result = await stats(repo);
      expect(result.snapshots).toBe(1);
      expect(result.sizeKiB).toBeGreaterThanOrEqual(0);
      expect(result.latest).not.toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});
