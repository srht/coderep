import { execFile } from 'node:child_process';

export interface GitRunOptions {
  /** Directory to run git in. */
  cwd: string;
  /** Value for GIT_INDEX_FILE, so the user's real index is never touched. */
  indexFile?: string;
  /** Written to the child's stdin. */
  input?: string;
  /** Resolve instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
  /** Extra environment entries. */
  env?: Record<string, string>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
  }
}

/**
 * Runs git via execFile — never through a shell, so no argument can be
 * interpreted as shell syntax.
 */
export function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (options.indexFile) env['GIT_INDEX_FILE'] = options.indexFile;

  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: options.cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const result: GitResult = {
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          code: error && typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0,
        };
        if (result.code !== 0 && !options.allowFailure) {
          reject(new GitError(args, result));
          return;
        }
        resolve(result);
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** Runs git and returns trimmed stdout. */
export async function git(args: string[], options: GitRunOptions): Promise<string> {
  const { stdout } = await runGit(args, options);
  return stdout.trim();
}

/** Runs git and returns raw, untrimmed stdout (for diffs and patches). */
export async function gitRaw(args: string[], options: GitRunOptions): Promise<string> {
  const { stdout } = await runGit(args, options);
  return stdout;
}

/** True when the command exits zero. */
export async function gitOk(args: string[], options: GitRunOptions): Promise<boolean> {
  const { code } = await runGit(args, { ...options, allowFailure: true });
  return code === 0;
}
