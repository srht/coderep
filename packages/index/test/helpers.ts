import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveRepo, type RepoContext } from '@coderep/core';

const exec = promisify(execFile);

export type TestRepo = RepoContext & { cleanup: () => Promise<void> };

export async function makeRepo(files: Record<string, string> = {}): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'coderep-index-'));
  await exec('git', ['init', '-b', 'main'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');

  for (const [path, contents] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  const ctx = await resolveRepo(dir);
  return { ...ctx, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function write(ctx: RepoContext, path: string, contents: string): Promise<void> {
  const target = join(ctx.root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}
