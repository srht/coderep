import type { CodeIndex } from './store.js';
import type { CodeSymbol } from './symbols.js';

/** Rough character-per-token ratio for code; good enough to hold a budget. */
const CHARS_PER_TOKEN = 3.6;

export interface MapOptions {
  /** Approximate token ceiling for the whole map. */
  budgetTokens?: number;
  /** Include unexported symbols too. */
  includePrivate?: boolean;
}

/** Highest-value symbols first: exported API before internals. */
const symbolWeight = (symbol: CodeSymbol): number => {
  const byKind: Record<string, number> = {
    route: 6,
    component: 5,
    hook: 5,
    class: 4,
    function: 3,
    interface: 2,
    method: 2,
    type: 1,
    enum: 1,
    const: 1,
  };
  return (byKind[symbol.kind] ?? 1) * (symbol.exported ? 2 : 1);
};

/**
 * A compressed, ranked map of the repository that fits a token budget.
 * Files come in PageRank order and each file's symbols in value order, so
 * truncation drops the least useful lines rather than the tail of the alphabet.
 */
export function buildMap(index: CodeIndex, options: MapOptions = {}): string {
  const budgetChars = Math.floor((options.budgetTokens ?? 2000) * CHARS_PER_TOKEN);

  const files = index.files
    .filter((entry) => entry.symbols.length > 0)
    .slice()
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));

  const lines: string[] = [];
  let used = 0;
  let truncatedFiles = 0;

  for (const entry of files) {
    const chosen = entry.symbols
      .filter((symbol) => (options.includePrivate ? true : symbol.exported))
      .slice()
      .sort((a, b) => symbolWeight(b) - symbolWeight(a) || a.startLine - b.startLine);

    if (chosen.length === 0) continue;

    const header = `${entry.path}`;
    const block: string[] = [header];
    for (const symbol of chosen) {
      const parent = symbol.parent ? `${symbol.parent}.` : '';
      block.push(`  ${symbol.startLine}: ${symbol.kind} ${parent}${symbol.name}`);
    }

    const blockText = `${block.join('\n')}\n`;
    if (used + blockText.length > budgetChars) {
      // Try the header plus a couple of lines before giving up on this file.
      const short = `${header}\n${block.slice(1, 3).join('\n')}\n`;
      if (used + short.length <= budgetChars) {
        lines.push(short.trimEnd());
        used += short.length;
      }
      truncatedFiles += 1;
      continue;
    }
    lines.push(blockText.trimEnd());
    used += blockText.length;
  }

  const footer =
    truncatedFiles > 0
      ? `\n… ${truncatedFiles} dosya bütçeye sığmadı. Ayrıntı için: outline(<dosya>) / find_feature(<sorgu>)`
      : '';
  return lines.join('\n') + footer;
}
