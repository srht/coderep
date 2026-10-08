import { resolveRepo } from '@coderep/core';
import { buildIndex } from '@coderep/index';
import { bold, cyan, dim, green } from '../format.js';

export async function indexCommand(options: { force?: boolean; stats?: boolean }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const result = await buildIndex(ctx, { ...(options.force ? { force: true } : {}) });

  console.log(
    `${green('indekslendi')} ${bold(String(result.index.files.length))} dosya · ` +
      `${bold(String(result.symbols))} sembol · ${dim(`${result.elapsedMs}ms`)}`,
  );
  console.log(dim(`  ${result.parsed} parse edildi, ${result.reused} önbellekten`));

  if (!options.stats) return;

  const byKind = new Map<string, number>();
  const byLang = new Map<string, number>();
  for (const entry of result.index.files) {
    byLang.set(entry.lang, (byLang.get(entry.lang) ?? 0) + 1);
    for (const symbol of entry.symbols) byKind.set(symbol.kind, (byKind.get(symbol.kind) ?? 0) + 1);
  }

  console.log(`\n${bold('dil')}`);
  for (const [lang, count] of [...byLang].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${lang.padEnd(5)} ${count}`);
  }
  console.log(`\n${bold('sembol türü')}`);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(10)} ${count}`);
  }

  const top = result.index.files.slice().sort((a, b) => b.rank - a.rank).slice(0, 8);
  console.log(`\n${bold('en çok import edilen')} ${dim('(PageRank)')}`);
  for (const entry of top) console.log(`  ${cyan(entry.rank.toFixed(4))} ${entry.path}`);
}
