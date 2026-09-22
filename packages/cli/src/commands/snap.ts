import { createSnapshot, resolveRepo } from '@coderep/core';
import { dim, green, sourceLabel } from '../format.js';

export async function snapCommand(options: { message?: string }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const snapshot = await createSnapshot(ctx, { label: options.message ?? 'elle', source: 'manual' });

  if (!snapshot) {
    console.log(dim('Son snapshot\'tan beri değişiklik yok — yeni snapshot alınmadı.'));
    return;
  }
  console.log(`${green(snapshot.short)} ${dim(`[${sourceLabel(snapshot.meta.source)}]`)} ${snapshot.meta.label}`);
}
