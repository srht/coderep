import { loadConfig, resolveRepo, stats, watcherPid } from '@coderep/core';
import { bold, cyan, dim, formatSize, green, relativeTime, red, sourceLabel } from '../format.js';

export async function statusCommand(): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const [summary, pid, config] = await Promise.all([stats(ctx), watcherPid(ctx), loadConfig(ctx)]);

  console.log(`${bold('repo')}       ${ctx.root}`);
  console.log(`${bold('watcher')}    ${pid !== null ? green(`çalışıyor (pid ${pid})`) : red('kapalı')}`);
  console.log(`${bold('snapshot')}   ${summary.snapshots}`);
  console.log(`${bold('disk')}       ${formatSize(summary.sizeKiB)} ${dim('(coderep deposu)')}`);
  console.log(`${bold('ajan geri alma')} ${config.allowAgentRestore ? green('açık') : dim('kapalı (önerilen)')}`);

  if (summary.latest) {
    const latest = summary.latest;
    console.log(
      `${bold('son')}        ${cyan(latest.short)} ${dim(relativeTime(latest.ts))} ` +
        `[${sourceLabel(latest.meta.source)}] ${latest.meta.label}`,
    );
  }
}
