/**
 * Measures what the index actually saves, rather than asserting a number.
 *
 * Two paths are compared for the same question:
 *   naive    — what an agent does without an index: grep for the term, then
 *              read the whole files that matched.
 *   coderep  — find_feature's ranked list plus get_symbol for the top hit.
 *
 * Usage: node scripts/measure-tokens.mjs [repoPath] [--files N]
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveRepo } from '@coderep/core';
import { buildIndex, getSymbolSource, loadFeatures, search } from '@coderep/index';

const exec = promisify(execFile);

/** Code averages close to this many characters per token. */
const CHARS_PER_TOKEN = 3.6;
const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

const args = process.argv.slice(2);
const repoPath = args.find((arg) => !arg.startsWith('--')) ?? process.cwd();
const fileBudgetIndex = args.indexOf('--files');
/** How many whole files an agent would open after grepping. */
const NAIVE_FILES = fileBudgetIndex === -1 ? 5 : Number.parseInt(args[fileBudgetIndex + 1], 10);

const QUERIES = args.includes('--queries')
  ? args[args.indexOf('--queries') + 1].split(',')
  : ['bisect', 'snapshot restore', 'symbol index', 'watcher debounce', 'repo map budget'];

async function naiveCost(ctx, query) {
  // An agent greps the most distinctive word, then opens what comes back.
  const term = query.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  let matches = [];
  try {
    const { stdout } = await exec('git', ['grep', '-l', '-i', term], { cwd: ctx.root, maxBuffer: 1 << 26 });
    matches = stdout.split('\n').filter((line) => line !== '');
  } catch {
    matches = []; // git grep exits 1 when nothing matches
  }

  const opened = matches.slice(0, NAIVE_FILES);
  let chars = 0;
  for (const path of opened) {
    try {
      chars += (await stat(join(ctx.root, path))).size;
    } catch {
      /* ignore */
    }
  }
  // The grep output itself is part of the cost.
  return { chars: chars + matches.join('\n').length, filesMatched: matches.length, filesOpened: opened.length };
}

async function coderepCost(ctx, index, features, query) {
  const hits = search(index, query, { features, limit: 5 });
  const list = hits
    .map((hit) => {
      const name = hit.parent ? `${hit.parent}.${hit.name}` : hit.name;
      const doc = hit.doc ? `\n   ${hit.doc}` : '';
      return `${hit.file}:${hit.startLine}-${hit.endLine} ${name} [${hit.kind}] (${hit.why.join('+')})\n   ${hit.signature}${doc}`;
    })
    .join('\n');

  let body = '';
  const top = hits[0];
  if (top) {
    const source = await getSymbolSource(ctx, index, top.file, top.parent ? `${top.parent}.${top.name}` : top.name);
    body = source?.body ?? '';
  }
  return { chars: list.length + body.length, hits: hits.length, top: top ? `${top.file}:${top.startLine}` : '—' };
}

const ctx = await resolveRepo(repoPath);
const { index, symbols } = await buildIndex(ctx);
const features = await loadFeatures(ctx);

console.log(`repo          ${ctx.root}`);
console.log(`indekslenen   ${index.files.length} dosya, ${symbols} sembol`);
console.log(`varsayım      naif yol grep sonrası ${NAIVE_FILES} tam dosya okur\n`);

const header = `${'sorgu'.padEnd(22)}${'naif'.padStart(10)}${'coderep'.padStart(10)}${'oran'.padStart(9)}   en iyi isabet`;
console.log(header);
console.log('-'.repeat(header.length + 10));

let naiveTotal = 0;
let coderepTotal = 0;

for (const query of QUERIES) {
  const naive = await naiveCost(ctx, query);
  const ours = await coderepCost(ctx, index, features, query);
  naiveTotal += naive.chars;
  coderepTotal += ours.chars;

  const ratio = ours.chars === 0 ? Infinity : naive.chars / ours.chars;
  console.log(
    `${query.padEnd(22)}${String(tokens(naive.chars)).padStart(10)}${String(tokens(ours.chars)).padStart(10)}` +
      `${`${ratio.toFixed(1)}x`.padStart(9)}   ${ours.top}`,
  );
}

console.log('-'.repeat(header.length + 10));
const overall = coderepTotal === 0 ? Infinity : naiveTotal / coderepTotal;
console.log(
  `${'TOPLAM'.padEnd(22)}${String(tokens(naiveTotal)).padStart(10)}${String(tokens(coderepTotal)).padStart(10)}` +
    `${`${overall.toFixed(1)}x`.padStart(9)}`,
);
console.log(`\n${QUERIES.length} sorguda ortalama ${overall.toFixed(1)}x daha az token.`);
