import { changedFiles, listSnapshots, resolveRepo, type SnapshotSource } from '@coderep/core';
import { bold, cyan, dim, parseDuration, relativeTime, sourceLabel, yellow } from '../format.js';

export interface LogOptions {
  since?: string;
  source?: string;
  file?: string;
  limit?: string;
}

export async function logCommand(options: LogOptions): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const snapshots = await listSnapshots(ctx, {
    ...(options.since ? { since: Date.now() - parseDuration(options.since) } : {}),
    ...(options.source ? { source: options.source as SnapshotSource } : {}),
    ...(options.file ? { file: options.file } : {}),
    limit: options.limit ? Number.parseInt(options.limit, 10) : 30,
  });

  if (snapshots.length === 0) {
    console.log(dim('Henüz snapshot yok. `coderep watch` başlatın ya da `coderep snap` çalıştırın.'));
    return;
  }

  for (const snapshot of snapshots) {
    const files = await changedFiles(ctx, snapshot.id);
    const agent = snapshot.meta.agent ? ` ${dim(`<${snapshot.meta.agent}>`)}` : '';
    console.log(
      `${cyan(snapshot.short)} ${dim(relativeTime(snapshot.ts).padStart(9))} ` +
        `${yellow(`[${sourceLabel(snapshot.meta.source)}]`.padEnd(9))} ` +
        `${bold(String(files.length).padStart(3))} dosya  ${snapshot.meta.label}${agent}`,
    );
  }
  console.log(dim(`\n${snapshots.length} snapshot. Ayrıntı: coderep diff <id> · Geri al: coderep restore <id>`));
}
