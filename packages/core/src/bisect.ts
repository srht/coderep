import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './git.js';
import { listSnapshots, type Snapshot } from './shadow.js';
import { storeArgs, type RepoContext } from './paths.js';

export interface BisectOptions {
  /** How far back to search. */
  limit?: number;
  /** Directories symlinked into each probe worktree (node_modules and friends). */
  link?: string[];
  /** Per-probe timeout in milliseconds. */
  timeoutMs?: number;
  onStep?: (snapshot: Snapshot, good: boolean, index: number, total: number) => void;
}

export interface BisectResult {
  /** The earliest snapshot where the command fails. */
  firstBad: Snapshot | null;
  /** The newest snapshot before it where the command still passes. */
  lastGood: Snapshot | null;
  tested: number;
  candidates: number;
  reason?: string;
}

/**
 * Runs `command` against a snapshot in a throwaway worktree.
 * The user's working tree is never touched.
 */
async function probe(
  ctx: RepoContext,
  snapshot: Snapshot,
  command: string[],
  options: BisectOptions,
): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'coderep-bisect-'));
  // `git worktree add` insists on creating the directory itself.
  await rm(dir, { recursive: true, force: true });

  try {
    await runGit([...storeArgs(ctx), 'worktree', 'add', '--detach', '--quiet', dir, snapshot.id], { cwd: ctx.root });

    for (const name of options.link ?? []) {
      const source = join(ctx.root, name);
      if (existsSync(source) && !existsSync(join(dir, name))) {
        await symlink(source, join(dir, name), 'junction').catch(() => undefined);
      }
    }

    return await new Promise<boolean>((resolve) => {
      const [bin, ...args] = command;
      if (!bin) {
        resolve(false);
        return;
      }
      const child = spawn(bin, args, { cwd: dir, stdio: 'ignore' });
      const timer = options.timeoutMs
        ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
        : undefined;
      child.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve(code === 0);
      });
    });
  } finally {
    await runGit([...storeArgs(ctx), 'worktree', 'remove', '--force', dir], { cwd: ctx.root, allowFailure: true });
    await rm(dir, { recursive: true, force: true });
    await runGit([...storeArgs(ctx), 'worktree', 'prune'], { cwd: ctx.root, allowFailure: true });
  }
}

/**
 * Binary-searches the snapshot chain for the first one where `command` fails.
 * Because snapshots are taken per file-save, the answer lands on a single edit
 * rather than on a whole commit.
 */
export async function bisect(ctx: RepoContext, command: string[], options: BisectOptions = {}): Promise<BisectResult> {
  const newestFirst = await listSnapshots(ctx, options.limit ? { limit: options.limit } : {});
  const chain = [...newestFirst].reverse(); // oldest -> newest
  let tested = 0;

  if (chain.length < 2) {
    return { firstBad: null, lastGood: null, tested, candidates: chain.length, reason: 'Arama için en az iki snapshot gerekiyor.' };
  }

  const newest = chain[chain.length - 1] as Snapshot;
  const newestGood = await probe(ctx, newest, command, options);
  tested += 1;
  options.onStep?.(newest, newestGood, tested, chain.length);
  if (newestGood) {
    return { firstBad: null, lastGood: newest, tested, candidates: chain.length, reason: 'En yeni snapshot zaten geçiyor — bozulma yok.' };
  }

  const oldest = chain[0] as Snapshot;
  const oldestGood = await probe(ctx, oldest, command, options);
  tested += 1;
  options.onStep?.(oldest, oldestGood, tested, chain.length);
  if (!oldestGood) {
    return {
      firstBad: oldest,
      lastGood: null,
      tested,
      candidates: chain.length,
      reason: 'Zincirin en eskisi de bozuk — bozulma bu aralıktan daha geride. --limit değerini artırın.',
    };
  }

  let low = 0; // known good
  let high = chain.length - 1; // known bad
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const candidate = chain[mid] as Snapshot;
    const good = await probe(ctx, candidate, command, options);
    tested += 1;
    options.onStep?.(candidate, good, tested, chain.length);
    if (good) low = mid;
    else high = mid;
  }

  return {
    firstBad: chain[high] as Snapshot,
    lastGood: chain[low] as Snapshot,
    tested,
    candidates: chain.length,
  };
}
