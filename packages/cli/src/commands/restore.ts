import { resolveRepo, restore, resolveSnapshot } from '@coderep/core';
import { bold, cyan, dim, green, yellow } from '../format.js';

export async function restoreCommand(ref: string, options: { files?: string[]; dryRun?: boolean }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const target = await resolveSnapshot(ctx, ref);

  const result = await restore(ctx, ref, {
    ...(options.files?.length ? { files: options.files } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
  });

  if (result.noop) {
    console.log(dim('Çalışma dizini zaten bu snapshot ile aynı.'));
    return;
  }

  process.stdout.write(result.stat);

  if (!result.applied) {
    console.log(yellow('\n--dry-run: hiçbir dosya yazılmadı.'));
    return;
  }

  console.log(
    `\n${green('Geri alındı')} → ${cyan(target.short)} ${dim(target.meta.label)}\n` +
      `${dim('Bu geri almayı da geri almak için:')} ${bold(`coderep restore ${result.preRestore.slice(0, 8)}`)}`,
  );
}
