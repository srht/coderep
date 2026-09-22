import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { git, runGit } from './git.js';

export const SNAPSHOT_REF = 'refs/coderep/snapshots';

export interface RepoContext {
  /** Absolute path to the working tree root. */
  root: string;
  /** Absolute path to the repository's own .git directory. */
  gitDir: string;
  /** Absolute path to coderep's private directory inside .git. */
  stateDir: string;
  /**
   * Absolute path to coderep's own bare object store. Snapshots live here and
   * not in the repository's ref namespace, so `git log --all`, `git show-ref`
   * and `git fsck` never see them.
   */
  storeDir: string;
  /** Absolute path to the shadow index — never the repository's .git/index. */
  indexFile: string;
}

export async function resolveRepo(cwd: string): Promise<RepoContext> {
  const root = await git(['rev-parse', '--show-toplevel'], { cwd });
  const rawGitDir = await git(['rev-parse', '--git-dir'], { cwd });
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(root, rawGitDir);
  const stateDir = join(gitDir, 'coderep');
  const storeDir = join(stateDir, 'store');
  return { root, gitDir, stateDir, storeDir, indexFile: join(stateDir, 'index') };
}

/** Git arguments that target coderep's store rather than the user's repository. */
export const storeArgs = (ctx: RepoContext): string[] => ['--git-dir', ctx.storeDir];

/** Same, for the commands that also need to see the working tree. */
export const storeWorktreeArgs = (ctx: RepoContext): string[] => [
  '-c',
  'core.bare=false',
  '--git-dir',
  ctx.storeDir,
  '--work-tree',
  ctx.root,
];

/**
 * Creates the store on first use. It borrows the repository's objects through
 * `alternates`, so content already committed is never stored twice.
 */
export async function ensureStore(ctx: RepoContext): Promise<void> {
  if (existsSync(join(ctx.storeDir, 'HEAD'))) return;

  await mkdir(ctx.stateDir, { recursive: true });
  await runGit(['init', '--quiet', '--bare', ctx.storeDir], { cwd: ctx.root });
  await writeFile(join(ctx.storeDir, 'objects', 'info', 'alternates'), `${join(ctx.gitDir, 'objects')}\n`, 'utf8');
}

/** The repository's own .git/info/exclude patterns, which the store would not otherwise read. */
export async function repoExcludePatterns(ctx: RepoContext): Promise<string[]> {
  try {
    const raw = await readFile(join(ctx.gitDir, 'info', 'exclude'), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch {
    return [];
  }
}

export const configPath = (ctx: RepoContext): string => join(ctx.root, '.coderep', 'config.json');
export const ignorePath = (ctx: RepoContext): string => join(ctx.root, '.coderepignore');
export const pidPath = (ctx: RepoContext): string => join(ctx.stateDir, 'watch.pid');
