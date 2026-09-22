import { bisect, changedFiles, diffSnapshots, loadConfig, resolveRepo } from '@coderep/core';
import { bold, cyan, dim, green, red, relativeTime, sourceLabel, yellow } from '../format.js';

export interface BisectOptions {
  limit?: string;
  timeout?: string;
  link?: string[];
}

export async function bisectCommand(command: string[], options: BisectOptions): Promise<void> {
  if (command.length === 0) {
    console.error(red('Çalıştırılacak komut verilmedi. Örnek: coderep bisect -- npm test'));
    process.exitCode = 2;
    return;
  }

  const ctx = await resolveRepo(process.cwd());
  const config = await loadConfig(ctx);

  console.log(dim(`Kontrol komutu: ${command.join(' ')}`));

  const result = await bisect(ctx, command, {
    limit: options.limit ? Number.parseInt(options.limit, 10) : 200,
    link: options.link ?? config.bisectLink,
    timeoutMs: options.timeout ? Number.parseInt(options.timeout, 10) * 1000 : 300_000,
    onStep: (snapshot, good, index) => {
      const verdict = good ? green('geçti') : red('kaldı');
      console.log(
        `  ${dim(`#${index}`)} ${cyan(snapshot.short)} ${dim(relativeTime(snapshot.ts))} → ${verdict} ${dim(snapshot.meta.label)}`,
      );
    },
  });

  console.log('');

  if (!result.firstBad) {
    console.log(yellow(result.reason ?? 'Bozulma bulunamadı.'));
    return;
  }

  const { firstBad, lastGood } = result;
  console.log(`${red(bold('Bozulmayı getiren snapshot:'))} ${cyan(firstBad.short)}`);
  console.log(`  ${dim('ne zaman')}  ${relativeTime(firstBad.ts)}`);
  console.log(`  ${dim('kaynak  ')}  ${sourceLabel(firstBad.meta.source)}${firstBad.meta.agent ? ` (${firstBad.meta.agent})` : ''}`);
  console.log(`  ${dim('etiket  ')}  ${firstBad.meta.label || '-'}`);

  const files = await changedFiles(ctx, firstBad.id);
  console.log(`  ${dim('dosyalar')}  ${files.length}`);
  for (const line of files.slice(0, 20)) console.log(`      ${line}`);
  if (files.length > 20) console.log(dim(`      ... ${files.length - 20} dosya daha`));

  if (lastGood) {
    console.log(`\n${dim('Bozulmayı getiren değişiklik:')}`);
    process.stdout.write(await diffSnapshots(ctx, lastGood.id, firstBad.id, { stat: true }));
    console.log(
      `\n${dim('Tam diff:')} ${bold(`coderep diff ${lastGood.short} ${firstBad.short}`)}\n` +
        `${dim('Öncesine dön:')} ${bold(`coderep restore ${lastGood.short}`)}`,
    );
  }

  console.log(dim(`\n${result.tested} deneme / ${result.candidates} snapshot.`));
}
