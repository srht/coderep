import { join, isAbsolute } from 'node:path';
import { git } from './git.js';

/** The single chronological chain of snapshots for a repository. */
export const SNAPSHOT_REF = 'refs/coderep/snapshots';

export interface RepoContext {
  /** Absolute path to the working tree root. */
  root: string;
  /** Absolute path to the .git directory. */
  gitDir: string;
  /** Absolute path to coderep's private directory inside .git. */
  stateDir: string;
  /** Absolute path to the shadow index — never the user's .git/index. */
  indexFile: string;
}

export async function resolveRepo(cwd: string): Promise<RepoContext> {
  const root = await git(['rev-parse', '--show-toplevel'], { cwd });
  const rawGitDir = await git(['rev-parse', '--git-dir'], { cwd });
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(root, rawGitDir);
  const stateDir = join(gitDir, 'coderep');
  return { root, gitDir, stateDir, indexFile: join(stateDir, 'index') };
}

export const configPath = (ctx: RepoContext): string => join(ctx.root, '.coderep', 'config.json');
export const ignorePath = (ctx: RepoContext): string => join(ctx.root, '.coderepignore');
export const pidPath = (ctx: RepoContext): string => join(ctx.stateDir, 'watch.pid');
