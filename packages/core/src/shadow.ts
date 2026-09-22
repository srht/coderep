import { mkdir, readFile } from 'node:fs/promises';
import { git, gitRaw, runGit } from './git.js';
import { encodeMessage, decodeMessage, type SnapshotMeta, type SnapshotSource } from './meta.js';
import {
  SNAPSHOT_REF,
  ensureStore,
  ignorePath,
  repoExcludePatterns,
  storeArgs,
  storeWorktreeArgs,
  type RepoContext,
} from './paths.js';

/** coderep authors its own commits so snapshots work before `user.name` is configured. */
const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'coderep',
  GIT_AUTHOR_EMAIL: 'coderep@localhost',
  GIT_COMMITTER_NAME: 'coderep',
  GIT_COMMITTER_EMAIL: 'coderep@localhost',
};

export interface Snapshot {
  id: string;
  short: string;
  tree: string;
  parent: string | null;
  /** Unix seconds. */
  ts: number;
  meta: SnapshotMeta;
}

export interface CreateOptions {
  label?: string;
  source?: SnapshotSource;
  agent?: string;
  turn?: string;
}

export async function readRef(ctx: RepoContext): Promise<string | null> {
  await ensureStore(ctx);
  const { stdout, code } = await runGit([...storeArgs(ctx), 'rev-parse', '--verify', '--quiet', SNAPSHOT_REF], {
    cwd: ctx.root,
    allowFailure: true,
  });
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function realHead(ctx: RepoContext): Promise<string | null> {
  const { stdout, code } = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: ctx.root,
    allowFailure: true,
  });
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function realBranch(ctx: RepoContext): Promise<string> {
  const { stdout, code } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: ctx.root,
    allowFailure: true,
  });
  return code === 0 && stdout.trim() ? stdout.trim() : 'unknown';
}

/** Reads .coderepignore into pathspec exclusions, so git's own global excludes stay intact. */
async function extraExcludes(ctx: RepoContext): Promise<string[]> {
  let own: string[] = [];
  try {
    own = (await readFile(ignorePath(ctx), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    own = [];
  }
  // The store has its own info/exclude, so the repository's must be forwarded.
  return [...own, ...(await repoExcludePatterns(ctx))].map((pattern) => `:(exclude,glob)${pattern}`);
}

/**
 * Stages the whole working tree into the shadow index and writes a tree object.
 * The shadow index is kept between calls so git can reuse its stat cache.
 */
async function writeWorkingTree(ctx: RepoContext): Promise<string> {
  await mkdir(ctx.stateDir, { recursive: true });
  await ensureStore(ctx);
  const excludes = await extraExcludes(ctx);
  await runGit([...storeWorktreeArgs(ctx), 'add', '-A', '--', '.', ...excludes], {
    cwd: ctx.root,
    indexFile: ctx.indexFile,
  });
  return git([...storeArgs(ctx), 'write-tree'], { cwd: ctx.root, indexFile: ctx.indexFile });
}

/**
 * Captures the working tree as a commit under refs/coderep/snapshots.
 * Returns null when nothing changed since the previous snapshot.
 */
export async function createSnapshot(ctx: RepoContext, options: CreateOptions = {}): Promise<Snapshot | null> {
  const tree = await writeWorkingTree(ctx);
  const parent = await readRef(ctx);

  if (parent) {
    const parentTree = await git([...storeArgs(ctx), 'rev-parse', `${parent}^{tree}`], { cwd: ctx.root });
    if (parentTree === tree) return null;
  }

  const meta: SnapshotMeta = {
    v: 1,
    label: options.label ?? '',
    source: options.source ?? 'manual',
    branch: await realBranch(ctx),
    head: await realHead(ctx),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.turn ? { turn: options.turn } : {}),
  };

  const commitArgs = [...storeArgs(ctx), 'commit-tree', tree];
  if (parent) commitArgs.push('-p', parent);
  const id = await git(commitArgs, {
    cwd: ctx.root,
    input: encodeMessage(meta),
    env: IDENTITY,
  });

  // The old value is passed so a concurrent watcher cannot clobber this update.
  await runGit([...storeArgs(ctx), 'update-ref', SNAPSHOT_REF, id, parent ?? ''], { cwd: ctx.root });

  return { id, short: id.slice(0, 8), tree, parent, ts: Math.floor(Date.now() / 1000), meta };
}

export interface ListOptions {
  limit?: number;
  /** Unix milliseconds; only snapshots at or after this time. */
  since?: number;
  source?: SnapshotSource;
  /** Only snapshots that touched this path. */
  file?: string;
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/** Snapshots newest first. */
export async function listSnapshots(ctx: RepoContext, options: ListOptions = {}): Promise<Snapshot[]> {
  if (!(await readRef(ctx))) return [];

  const args = [...storeArgs(ctx), 'log', `--format=%H${FIELD}%P${FIELD}%T${FIELD}%ct${FIELD}%B${RECORD}`];
  if (options.limit) args.push(`-n`, String(options.limit));
  if (options.since) args.push(`--since=${Math.floor(options.since / 1000)}`);
  args.push(SNAPSHOT_REF);
  if (options.file) args.push('--', options.file);

  const out = await gitRaw(args, { cwd: ctx.root });
  const snapshots = out
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk): Snapshot => {
      const [id = '', parents = '', tree = '', ts = '0', body = ''] = chunk.split(FIELD);
      return {
        id,
        short: id.slice(0, 8),
        tree,
        parent: parents.trim() ? (parents.trim().split(' ')[0] ?? null) : null,
        ts: Number.parseInt(ts, 10),
        meta: decodeMessage(body),
      };
    });

  return options.source ? snapshots.filter((s) => s.meta.source === options.source) : snapshots;
}

export async function resolveSnapshot(ctx: RepoContext, ref: string): Promise<Snapshot> {
  const id = await git([...storeArgs(ctx), 'rev-parse', '--verify', `${ref}^{commit}`], { cwd: ctx.root });
  const out = await gitRaw([...storeArgs(ctx), 'log', '-1', `--format=%H${FIELD}%P${FIELD}%T${FIELD}%ct${FIELD}%B`, id], {
    cwd: ctx.root,
  });
  const [, parents = '', tree = '', ts = '0', body = ''] = out.split(FIELD);
  return {
    id,
    short: id.slice(0, 8),
    tree,
    parent: parents.trim() ? (parents.trim().split(' ')[0] ?? null) : null,
    ts: Number.parseInt(ts, 10),
    meta: decodeMessage(body),
  };
}

/** Files a snapshot changed relative to its parent, as `STATUS\tpath` lines. */
export async function changedFiles(ctx: RepoContext, id: string): Promise<string[]> {
  const out = await gitRaw([...storeArgs(ctx), 'diff-tree', '-r', '--root', '--no-commit-id', '--name-status', id], {
    cwd: ctx.root,
  });
  return out.split('\n').filter((line) => line.trim() !== '');
}

export interface DiffOptions {
  paths?: string[];
  stat?: boolean;
}

/** Diffs two snapshots, or a snapshot against the current working tree when `to` is omitted. */
export async function diffSnapshots(
  ctx: RepoContext,
  from: string,
  to: string | undefined,
  options: DiffOptions = {},
): Promise<string> {
  const target = to ?? (await writeWorkingTree(ctx));
  const args = [...storeArgs(ctx), 'diff', options.stat ? '--stat' : '--patch', from, target];
  if (options.paths?.length) args.push('--', ...options.paths);
  return gitRaw(args, { cwd: ctx.root });
}

export interface RestoreOptions {
  files?: string[];
  dryRun?: boolean;
}

export interface RestoreResult {
  applied: boolean;
  /** The snapshot taken of the pre-restore state, so the restore itself is undoable. */
  preRestore: string;
  stat: string;
  noop: boolean;
}

/**
 * Rewinds the working tree to a snapshot by applying the diff between the
 * current state and that snapshot. One code path covers additions, deletions
 * and modifications, whole-tree and per-file alike.
 */
export async function restore(ctx: RepoContext, target: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const targetId = await git([...storeArgs(ctx), 'rev-parse', '--verify', `${target}^{commit}`], { cwd: ctx.root });

  const taken = await createSnapshot(ctx, { label: 'restore öncesi', source: 'pre-restore' });
  const base = taken?.id ?? (await readRef(ctx));
  if (!base) throw new Error('Geri alınacak bir snapshot zinciri yok. Önce `coderep snap` çalıştırın.');

  const pathspec = options.files?.length ? ['--', ...options.files] : [];
  const stat = await gitRaw([...storeArgs(ctx), 'diff', '--stat', base, targetId, ...pathspec], { cwd: ctx.root });
  if (stat.trim() === '') return { applied: false, preRestore: base, stat: '', noop: true };
  if (options.dryRun) return { applied: false, preRestore: base, stat, noop: false };

  const patch = await gitRaw([...storeArgs(ctx), 'diff', '--binary', base, targetId, ...pathspec], { cwd: ctx.root });
  // `git apply` only writes files, so it runs against the working tree directly.
  await runGit(['apply', '--whitespace=nowarn', '-'], { cwd: ctx.root, input: patch });

  return { applied: true, preRestore: base, stat, noop: false };
}

export async function deleteRef(ctx: RepoContext): Promise<void> {
  await ensureStore(ctx);
  await runGit([...storeArgs(ctx), 'update-ref', '-d', SNAPSHOT_REF], { cwd: ctx.root, allowFailure: true });
}

export interface PruneOptions {
  olderThanMs: number;
  /** Keep snapshots a human explicitly labelled, however old. */
  keepLabeled?: boolean;
}

export interface PruneResult {
  removed: number;
  kept: number;
}

/**
 * Drops old snapshots by rebuilding the kept ones into a fresh chain.
 * Original timestamps and metadata are preserved.
 */
export async function prune(ctx: RepoContext, options: PruneOptions): Promise<PruneResult> {
  const all = await listSnapshots(ctx, {});
  if (all.length === 0) return { removed: 0, kept: 0 };

  const cutoff = (Date.now() - options.olderThanMs) / 1000;
  const kept = all.filter((s) => s.ts >= cutoff || (options.keepLabeled === true && s.meta.source === 'manual'));
  if (kept.length === all.length) return { removed: 0, kept: kept.length };

  if (kept.length === 0) {
    await deleteRef(ctx);
    return { removed: all.length, kept: 0 };
  }

  let parent: string | null = null;
  for (const snapshot of [...kept].reverse()) {
    const args = [...storeArgs(ctx), 'commit-tree', snapshot.tree];
    if (parent) args.push('-p', parent);
    const stamp = new Date(snapshot.ts * 1000).toISOString();
    parent = await git(args, {
      cwd: ctx.root,
      input: encodeMessage(snapshot.meta),
      env: { ...IDENTITY, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    });
  }

  await runGit([...storeArgs(ctx), 'update-ref', SNAPSHOT_REF, parent as string], { cwd: ctx.root });
  return { removed: all.length - kept.length, kept: kept.length };
}

export interface RepoStats {
  snapshots: number;
  /** Size of the repository's loose + packed objects, in kibibytes. */
  sizeKiB: number;
  latest: Snapshot | null;
}

export async function stats(ctx: RepoContext): Promise<RepoStats> {
  const snapshots = await listSnapshots(ctx, {});
  const counts = await gitRaw([...storeArgs(ctx), 'count-objects', '-v'], { cwd: ctx.root });
  let sizeKiB = 0;
  for (const line of counts.split('\n')) {
    const match = /^(?:size|size-pack): (\d+)$/.exec(line.trim());
    if (match?.[1]) sizeKiB += Number.parseInt(match[1], 10);
  }
  return { snapshots: snapshots.length, sizeKiB, latest: snapshots[0] ?? null };
}
