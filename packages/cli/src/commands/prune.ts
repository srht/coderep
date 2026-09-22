import { prune, resolveRepo } from '@coderep/core';
import { dim, green, parseDuration } from '../format.js';

export async function pruneCommand(options: { olderThan: string; keepLabeled?: boolean }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const result = await prune(ctx, {
    olderThanMs: parseDuration(options.olderThan),
    ...(options.keepLabeled ? { keepLabeled: true } : {}),
  });

  if (result.removed === 0) {
    console.log(dim(`Silinecek snapshot yok (${result.kept} tutuldu).`));
    return;
  }
  console.log(`${green(`${result.removed} snapshot silindi`)}, ${result.kept} tutuldu.`);
  console.log(dim('Diski gerçekten boşaltmak için: git gc --prune=now'));
}
