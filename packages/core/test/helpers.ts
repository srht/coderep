import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveRepo, type RepoContext } from '../src/paths.js';

const exec = promisify(execFile);

export async function makeRepo(): Promise<RepoContext & { cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'coderep-test-'));
  const run = (args: string[]) => exec('git', args, { cwd: dir });

  await run(['init', '-b', 'main']);
  await run(['config', 'user.name', 'Test']);
  await run(['config', 'user.email', 'test@example.com']);
  await writeFile(join(dir, '.gitignore'), 'node_modules/\nignored.txt\n', 'utf8');
  await writeFile(join(dir, 'README.md'), 'baslangic\n', 'utf8');
  await run(['add', '-A']);
  await run(['commit', '-m', 'ilk commit']);

  const ctx = await resolveRepo(dir);
  return { ...ctx, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function write(ctx: RepoContext, relative: string, contents: string): Promise<void> {
  const target = join(ctx.root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

/** The user-visible git surface, captured so tests can prove coderep never moves it. */
export async function visibleGitState(ctx: RepoContext): Promise<string> {
  const parts: string[] = [];
  for (const args of [
    ['status', '--porcelain=v2', '--branch'],
    ['log', '--format=%H %s'],
    ['branch', '--all'],
    ['stash', 'list'],
    ['rev-parse', 'HEAD'],
    ['diff', '--stat'],
    ['diff', '--cached', '--stat'],
  ]) {
    const { stdout } = await exec('git', args, { cwd: ctx.root });
    parts.push(`$ git ${args.join(' ')}\n${stdout}`);
  }
  return parts.join('\n');
}

export const gitIn = (cwd: string, args: string[]) => exec('git', args, { cwd });
