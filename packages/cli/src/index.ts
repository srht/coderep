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
