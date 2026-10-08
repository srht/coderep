export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'component'
  | 'hook'
  | 'route'
  | 'const';

export type Lang = 'ts' | 'tsx' | 'js' | 'py';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Declaration collapsed to a single line, trimmed to a readable length. */
  signature: string;
  /** First line of the JSDoc block or docstring. */
  doc?: string;
  /** Enclosing class, for methods. */
  parent?: string;
  /** Route paths, labels and other literals that help a search find this symbol. */
  strings?: string[];
}

export interface FileEntry {
  /** Repo-relative, forward slashes. */
  path: string;
  /** sha256 of the file contents — the incremental check. */
  hash: string;
  lang: Lang;
  symbols: CodeSymbol[];
  /** Repo-relative paths this file imports. */
  imports: string[];
  /** Raw module specifiers, kept so a cache hit can re-resolve them cheaply. */
  specifiers: string[];
  /** PageRank over the import graph. */
  rank: number;
}

export const SIGNATURE_LIMIT = 200;
export const MAX_STRINGS_PER_SYMBOL = 10;

/** Collapses whitespace and trims a declaration down to one readable line. */
export function oneLine(text: string, limit = SIGNATURE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** A literal worth indexing: route paths, labels, keys — not noise. */
export function isUsefulString(value: string): boolean {
  if (value.length < 3 || value.length > 80) return false;
  if (!/[a-zA-Z]/.test(value)) return false;
  // Skip imports and anything that looks like a file path fragment only.
  return !/^[./]+$/.test(value);
}

export function langFromPath(path: string): Lang | null {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'tsx';
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts';
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'js';
  if (path.endsWith('.py') || path.endsWith('.pyi')) return 'py';
  return null;
}

/** `.d.ts` files are type noise for feature search. */
export const isDeclarationFile = (path: string): boolean => /\.d\.(m|c)?ts$/.test(path);
