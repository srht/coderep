import { resolveRepo } from '@coderep/core';
import { ensureIndex, outline } from '@coderep/index';
import { bold, cyan, dim, green } from '../format.js';

export async function outlineCommand(file: string): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const index = await ensureIndex(ctx);

  const rows = outline(index, file);
  if (!rows) {
    console.error(`İndekste böyle bir dosya yok: ${file}`);
    console.error('Yolu repo köküne göre verin. Gerekirse: coderep index');
    process.exitCode = 1;
    return;
  }
  if (rows.length === 0) {
    console.log(dim('Bu dosyada sembol bulunamadı.'));
    return;
  }

  console.log(bold(file));
  for (const row of rows) {
    const name = row.parent ? `${row.parent}.${row.name}` : row.name;
    const marker = row.exported ? green('·') : dim('·');
    console.log(
      `  ${marker} ${cyan(`${row.startLine}-${row.endLine}`.padEnd(9))} ${dim(row.kind.padEnd(9))} ${name}`,
    );
    console.log(`      ${dim(row.signature)}`);
  }
  console.log(dim(`\n${rows.length} sembol. ${green('·')} = ihraç edilmiş`));
}
