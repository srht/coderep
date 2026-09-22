import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { startWatcher, watcherPid } from '../src/watcher.js';
import { listSnapshots } from '../src/shadow.js';
import { makeRepo, write } from './helpers.js';

describe('watcher', () => {
  it('collapses a burst of edits into a single snapshot', async () => {
    const repo = await makeRepo();
    const watcher = await startWatcher(repo, { ...DEFAULT_CONFIG, debounceMs: 300 });
    try {
      await sleep(400); // let chokidar finish its initial scan

      for (let i = 0; i < 8; i += 1) {
        await write(repo, `burst-${i}.ts`, `export const n = ${i};\n`);
        await sleep(30);
      }

      await sleep(1500);
      const snapshots = await listSnapshots(repo, {});
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.meta.source).toBe('watch');
    } finally {
      await watcher.close();
      await repo.cleanup();
    }
  });

  it('publishes a pid while alive and clears it on close', async () => {
    const repo = await makeRepo();
    const watcher = await startWatcher(repo, DEFAULT_CONFIG);
    try {
      expect(await watcherPid(repo)).toBe(process.pid);
    } finally {
      await watcher.close();
    }
    expect(await watcherPid(repo)).toBeNull();
    await repo.cleanup();
  });

  it('ignores paths excluded by config', async () => {
    const repo = await makeRepo();
    const watcher = await startWatcher(repo, { ...DEFAULT_CONFIG, debounceMs: 200 });
    try {
      await sleep(400);

      // Establish a baseline first: the very first snapshot has no parent to
      // compare against, so it is always written.
      await write(repo, 'real.ts', 'export const a = 1;\n');
      await sleep(900);
      const baseline = await listSnapshots(repo, {});
      expect(baseline).toHaveLength(1);

      await write(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
      await sleep(900);
      expect(await listSnapshots(repo, {})).toHaveLength(1);
    } finally {
      await watcher.close();
      await repo.cleanup();
    }
  });
});
