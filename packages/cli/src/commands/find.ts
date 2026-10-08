import { resolveRepo } from '@coderep/core';
import { ensureIndex, loadFeatures, search, type SymbolKind } from '@coderep/index';
import { bold, cyan, dim, yellow } from '../format.js';

export async function findCommand(query: string[], options: { limit?: string; kind?: string }): Promise<void> {
  const text = query.join(' ').trim();
  if (text === '') {
    console.error('Sorgu boş. Örnek: coderep find "login akışı"');
    process.exitCode = 2;
    return;
  }

  const ctx = await resolveRepo(process.cwd());
  const [index, features] = await Promise.all([ensureIndex(ctx), loadFeatures(ctx)]);

  const hits = search(index, text, {
    features,
    limit: options.limit ? Number.parseInt(options.limit, 10) : 10,
    ...(options.kind ? { kind: options.kind as SymbolKind } : {}),
  });

  if (hits.length === 0) {
    console.log(dim('Eşleşme yok.'));
    console.log(
      dim('Kod İngilizce, sorgu Türkçe ise alias ekleyin:\n  coderep feature add login "src/auth/**" --alias "giriş"'),
    );
    return;
  }

  for (const hit of hits) {
    const name = hit.parent ? `${hit.parent}.${hit.name}` : hit.name;
    console.log(`${cyan(`${hit.file}:${hit.startLine}`)}  ${bold(name)} ${dim(`[${hit.kind}]`)}`);
    console.log(`  ${hit.signature}`);
    if (hit.doc) console.log(`  ${dim(hit.doc)}`);
    console.log(`  ${yellow(hit.why.join(' + '))} ${dim(`· skor ${hit.score.toFixed(2)}`)}\n`);
  }
  console.log(dim(`Kaynağı almak için: coderep outline <dosya>`));
}
