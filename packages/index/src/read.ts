import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoContext } from '@coderep/core';
import type { CodeIndex } from './store.js';
import type { CodeSymbol } from './symbols.js';

export interface SymbolSource {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  /** Absent when only the signature was asked for. */
  body?: string;
}

const findSymbol = (index: CodeIndex, file: string, name: string): { symbol: CodeSymbol } | null => {
  const entry = index.files.find((candidate) => candidate.path === file);
  if (!entry) return null;
  // A method name can repeat across classes; prefer an exact `Class.method`.
  const dotted = name.includes('.') ? name.split('.') : null;
  const symbol = dotted
    ? entry.symbols.find((candidate) => candidate.parent === dotted[0] && candidate.name === dotted[1])
    : entry.symbols.find((candidate) => candidate.name === name);
  return symbol ? { symbol } : null;
};

/**
 * Returns just one symbol's source. This is where the token saving happens:
 * the agent gets the twenty lines it needs instead of the whole file.
 */
export async function getSymbolSource(
  ctx: RepoContext,
  index: CodeIndex,
  file: string,
  name: string,
  include: 'signature' | 'body' = 'body',
): Promise<SymbolSource | null> {
  const found = findSymbol(index, file, name);
  if (!found) return null;
  const { symbol } = found;

  const base: SymbolSource = {
    file,
    name: symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature,
  };
  if (include === 'signature') return base;

  const text = await readFile(join(ctx.root, file), 'utf8');
  const lines = text.split('\n');
  return { ...base, body: lines.slice(symbol.startLine - 1, symbol.endLine).join('\n') };
}

export interface OutlineRow {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string;
  doc?: string;
  parent?: string;
}

/** Signatures only — reading a file's shape without paying for its body. */
export function outline(index: CodeIndex, file: string): OutlineRow[] | null {
  const entry = index.files.find((candidate) => candidate.path === file);
  if (!entry) return null;
  return entry.symbols
    .slice()
    .sort((a, b) => a.startLine - b.startLine)
    .map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      exported: symbol.exported,
      signature: symbol.signature,
      ...(symbol.doc ? { doc: symbol.doc } : {}),
      ...(symbol.parent ? { parent: symbol.parent } : {}),
    }));
}

export interface Reference {
  file: string;
  line: number;
  /** The symbol the mention sits inside, when it is inside one. */
  symbol?: string;
  text: string;
}

/**
 * Finds where a name is actually mentioned, by scanning the working tree and
 * mapping each hit to the enclosing symbol through the stored line ranges.
 * The index alone cannot answer this: it stores signatures, not bodies.
 */
export async function findReferences(
  ctx: RepoContext,
  index: CodeIndex,
  name: string,
  limit = 100,
): Promise<Reference[]> {
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const found: Reference[] = [];

  for (const entry of index.files) {
    if (found.length >= limit) break;
    let text: string;
    try {
      text = await readFile(join(ctx.root, entry.path), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(name)) continue; // cheap reject before the regex

    const ranges = entry.symbols
      .slice()
      .sort((a, b) => b.startLine - a.startLine || a.endLine - b.endLine);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length && found.length < limit; i += 1) {
      const line = lines[i] as string;
      if (!pattern.test(line)) continue;
      const lineNumber = i + 1;
      // Innermost enclosing symbol: the ranges are sorted so the first hit is it.
      const enclosing = ranges.find(
        (symbol) => symbol.startLine <= lineNumber && lineNumber <= symbol.endLine && symbol.name !== name,
      );
      found.push({
        file: entry.path,
        line: lineNumber,
        ...(enclosing
          ? { symbol: enclosing.parent ? `${enclosing.parent}.${enclosing.name}` : enclosing.name }
          : {}),
        text: line.trim().slice(0, 160),
      });
    }
  }
  return found;
}
