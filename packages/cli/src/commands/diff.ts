import { diffSnapshots, resolveRepo } from '@coderep/core';
import { dim } from '../format.js';

export async function diffCommand(from: string, to: string | undefined, options: { stat?: boolean; paths?: string[] }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const output = await diffSnapshots(ctx, from, to, {
    ...(options.stat ? { stat: true } : {}),
    ...(options.paths?.length ? { paths: options.paths } : {}),
  });

  if (output.trim() === '') {
    console.log(dim(to ? 'İki snapshot arasında fark yok.' : 'Snapshot ile çalışma dizini arasında fark yok.'));
    return;
  }
  process.stdout.write(output);
}
