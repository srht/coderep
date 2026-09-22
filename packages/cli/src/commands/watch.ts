import { loadConfig, resolveRepo, startWatcher, watcherPid } from '@coderep/core';
import { cyan, dim, green, red, sourceLabel } from '../format.js';

export async function watchCommand(options: { debounce?: string }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());

  const existing = await watcherPid(ctx);
  if (existing !== null) {
    console.error(red(`Bu repo için zaten bir watcher çalışıyor (pid ${existing}).`));
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(ctx);
  if (options.debounce) config.debounceMs = Number.parseInt(options.debounce, 10);

  const watcher = await startWatcher(ctx, config, {
    onSnapshot: (snapshot) => {
      console.log(`${cyan(snapshot.short)} ${dim(`[${sourceLabel(snapshot.meta.source)}]`)} ${new Date().toLocaleTimeString()}`);
    },
    onError: (error) => console.error(red(`watcher hatası: ${String(error)}`)),
  });

  console.log(`${green('coderep watch')} ${dim(`· ${ctx.root} · ${config.debounceMs}ms debounce · durdurmak için Ctrl-C`)}`);

  const shutdown = async (): Promise<void> => {
    console.log(dim('\nSon bir snapshot alınıp kapatılıyor...'));
    await watcher.flush();
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
