import { Command } from 'commander';
import { GitError } from '@coderep/core';
import { red, dim } from './format.js';
import { initCommand } from './commands/init.js';
import { snapCommand } from './commands/snap.js';
import { logCommand } from './commands/log.js';
import { diffCommand } from './commands/diff.js';
import { restoreCommand } from './commands/restore.js';
import { bisectCommand } from './commands/bisect.js';
import { watchCommand } from './commands/watch.js';
import { statusCommand } from './commands/status.js';
import { pruneCommand } from './commands/prune.js';
import { indexCommand } from './commands/index-cmd.js';
import { findCommand } from './commands/find.js';
import { outlineCommand } from './commands/outline.js';
import { mapCommand } from './commands/map.js';
import {
  featureAddCommand,
  featureListCommand,
  featureRemoveCommand,
  featureSuggestCommand,
} from './commands/feature.js';

const program = new Command();

program
  .name('coderep')
  .description(
    'AI editörleri için gölge-git checkpoint sistemi.\n' +
      'Snapshot\'lar refs/coderep/* altında durur; git log, git status ve git branch hiç değişmez.',
  )
  .version('0.1.0');

program
  .command('init')
  .description('config, .coderepignore ve editörlerin MCP girdilerini oluşturur')
  .option('-e, --editor <editor>', 'windsurf | cursor | claude | all', 'all')
  .option('-f, --force', 'mevcut coderep MCP girdisinin üzerine yaz')
  .action(initCommand);

program
  .command('watch')
  .description('çalışma dizinini izler, yazma bitince snapshot alır')
  .option('-d, --debounce <ms>', 'yazma bittikten sonra beklenecek süre')
  .action(watchCommand);

program
  .command('snap')
  .description('şu anki durumdan elle snapshot alır')
  .option('-m, --message <mesaj>', 'snapshot etiketi')
  .action(snapCommand);

program
  .command('log')
  .description('snapshot zaman çizelgesi')
  .option('-s, --since <süre>', 'örn. 30m, 2h, 7d')
  .option('--source <kaynak>', 'watch | agent | manual | pre-restore')
  .option('-f, --file <yol>', 'sadece bu dosyaya dokunan snapshot\'lar')
  .option('-n, --limit <sayı>', 'kaç tane gösterilsin', '30')
  .action(logCommand);

program
  .command('diff')
  .description('iki snapshot\'ı, ya da bir snapshot ile çalışma dizinini karşılaştırır')
  .argument('<from>', 'snapshot id')
  .argument('[to]', 'snapshot id (boşsa çalışma dizini)')
  .option('--stat', 'sadece özet')
  .option('-p, --paths <yollar...>', 'sadece bu yollar')
  .action((from: string, to: string | undefined, options: { stat?: boolean; paths?: string[] }) =>
    diffCommand(from, to, options),
  );

program
  .command('restore')
  .description('çalışma dizinini bir snapshot\'a döndürür (önce mevcut durumu snapshot\'lar)')
  .argument('<ref>', 'snapshot id')
  .option('-f, --files <yollar...>', 'sadece bu dosyaları geri al')
  .option('-n, --dry-run', 'ne olacağını göster, hiçbir şey yazma')
  .action(restoreCommand);

program
  .command('bisect')
  .description('verilen komutu bozan ilk snapshot\'ı ikili aramayla bulur')
  .argument('[command...]', 'kontrol komutu, örn. -- npm test')
  .option('-n, --limit <sayı>', 'geriye kaç snapshot taransın', '200')
  .option('-t, --timeout <saniye>', 'her deneme için zaman sınırı', '300')
  .option('--link <yollar...>', 'deneme dizinine sembolik bağ kurulacak klasörler')
  .action(bisectCommand);

program.command('status').description('watcher, snapshot sayısı ve disk kullanımı').action(statusCommand);

program
  .command('prune')
  .description('eski snapshot\'ları siler')
  .requiredOption('--older-than <süre>', 'örn. 7d')
  .option('--keep-labeled', 'elle alınmış snapshot\'ları yaşı ne olursa olsun tut')
  .action(pruneCommand);

// --- kod haritası ---------------------------------------------------------

program
  .command('index')
  .description('sembol indeksini kurar ya da yeniler (sadece değişen dosyaları parse eder)')
  .option('-f, --force', 'her şeyi yeniden parse et')
  .option('-s, --stats', 'dil, sembol türü ve en çok import edilen dosyalar')
  .action(indexCommand);

program
  .command('find')
  .description('bir feature\'ın hangi dosya ve sembolde olduğunu bulur')
  .argument('<query...>', 'örn. login akışı')
  .option('-n, --limit <sayı>', 'kaç sonuç', '10')
  .option('-k, --kind <tür>', 'function | class | component | hook | route | ...')
  .action(findCommand);

program
  .command('outline')
  .description('bir dosyanın sadece imzalarını listeler')
  .argument('<file>', 'repo köküne göreli yol')
  .action(outlineCommand);

program
  .command('map')
  .description('token bütçesine sığdırılmış repo haritası')
  .option('-b, --budget <token>', 'yaklaşık token sınırı', '2000')
  .option('-p, --private', 'ihraç edilmemiş sembolleri de göster')
  .action(mapCommand);

const feature = program.command('feature').description('feature -> yol haritasını yönetir');

feature.command('list').description('tanımlı feature\'ları gösterir').action(featureListCommand);

feature
  .command('add')
  .description('feature ekler ya da günceller')
  .argument('<name>', 'feature adı, örn. login')
  .argument('<paths...>', 'glob\'lar, örn. "src/auth/**"')
  .option('-a, --alias <alias...>', 'Türkçe ya da başka eş anlamlılar')
  .action(featureAddCommand);

feature.command('rm').description('feature siler').argument('<name>').action(featureRemoveCommand);

feature
  .command('suggest')
  .description('koda bakıp aday feature\'lar önerir')
  .action(featureSuggestCommand);

program
  .command('mcp')
  .description('MCP sunucusunu stdio üzerinden başlatır (editörler çağırır)')
  .action(async () => {
    const { startMcpServer } = await import('@coderep/mcp');
    await startMcpServer();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message)) {
      console.error(red('Burası bir git reposu değil. coderep git üzerine kurulu çalışır.'));
    } else {
      console.error(red(error instanceof Error ? error.message : String(error)));
      if (process.env['CODEREP_DEBUG']) console.error(dim(String((error as Error)?.stack ?? '')));
    }
    process.exitCode = 1;
  }
}

void main();
