import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import { createSnapshot, type Snapshot } from './shadow.js';
import { pidPath, type RepoContext } from './paths.js';
import type { Config } from './config.js';

export interface WatcherEvents {
  onSnapshot?: (snapshot: Snapshot) => void;
  /** Fired when files settled but the tree was byte-identical to the last snapshot. */
  onUnchanged?: () => void;
  onError?: (error: unknown) => void;
}

export interface Watcher {
  close: () => Promise<void>;
  /** Snapshot immediately instead of waiting out the debounce. */
  flush: () => Promise<void>;
}

/**
 * Watches the working tree and snapshots once writes go quiet.
 * The debounce is what collapses an agent's burst of edits into one snapshot
 * instead of eight.
 */
export async function startWatcher(ctx: RepoContext, config: Config, events: WatcherEvents = {}): Promise<Watcher> {
  await mkdir(ctx.stateDir, { recursive: true });
  await writeFile(pidPath(ctx), String(process.pid), 'utf8');

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let dirtyWhileRunning = false;

  const snapshot = async (): Promise<void> => {
    if (running) {
      dirtyWhileRunning = true;
      return;
    }
    running = true;
    try {
      const taken = await createSnapshot(ctx, { label: 'otomatik', source: 'watch' });
      if (taken) events.onSnapshot?.(taken);
      else events.onUnchanged?.();
    } catch (error) {
      events.onError?.(error);
    } finally {
      running = false;
      if (dirtyWhileRunning) {
        dirtyWhileRunning = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void snapshot();
    }, config.debounceMs);
  };

  // chokidar 4 dropped glob support - a bare string is now an exact path match -
  // so the patterns are matched here against the repo-relative path instead.
  const matches = picomatch(config.watchIgnore, { dot: true });
  const isIgnored = (absolute: string): boolean => {
    const rel = relative(ctx.root, absolute);
    if (rel === '' || rel.startsWith('..')) return false;
    return matches(sep === '/' ? rel : rel.split(sep).join('/'));
  };

  const watcher: FSWatcher = chokidar.watch(ctx.root, {
    ignored: (path: string) => isIgnored(path),
    ignoreInitial: true,
    persistent: true,
    // Editors write via rename/truncate; wait for the size to settle first.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  watcher.on('all', schedule);
  watcher.on('error', (error) => events.onError?.(error));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      await rm(pidPath(ctx), { force: true });
    },
    flush: async () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await snapshot();
    },
  };
}

/** Returns the pid of a live watcher for this repo, or null. */
export async function watcherPid(ctx: RepoContext): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(pidPath(ctx), 'utf8');
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0); // signal 0 only probes for existence
    return pid;
  } catch {
    await rm(pidPath(ctx), { force: true });
    return null;
  }
}
