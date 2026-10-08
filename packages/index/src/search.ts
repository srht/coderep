import picomatch from 'picomatch';
import type { CodeIndex } from './store.js';
import type { FeatureMap } from './features.js';
import type { CodeSymbol, SymbolKind } from './symbols.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Splits camelCase, snake_case, kebab-case and paths into lowercase terms. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 1);
}

export interface SearchHit {
  file: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature: string;
  doc?: string;
  parent?: string;
  score: number;
  /** Which signals fired — lets a reader tell a name match from a path match. */
  why: string[];
}

interface Doc {
  file: string;
  symbol: CodeSymbol;
  rank: number;
  terms: string[];
  length: number;
}

function buildDocs(index: CodeIndex): Doc[] {
  const docs: Doc[] = [];
  for (const entry of index.files) {
    const pathTerms = tokenize(entry.path);
    for (const symbol of entry.symbols) {
      const terms = [
        ...tokenize(symbol.name),
        ...pathTerms,
        ...(symbol.parent ? tokenize(symbol.parent) : []),
        ...(symbol.doc ? tokenize(symbol.doc) : []),
        ...(symbol.strings ?? []).flatMap((value) => tokenize(value)),
      ];
      docs.push({ file: entry.path, symbol, rank: entry.rank, terms, length: terms.length });
    }
  }
  return docs;
}

export interface SearchOptions {
  limit?: number;
  features?: FeatureMap;
  /** Restrict to one kind, e.g. only components. */
  kind?: SymbolKind;
}

/**
 * Ranks symbols for a natural-language query with BM25 over each symbol's
 * name, path, doc and literals, then boosts exact names, feature aliases and
 * well-connected files.
 */
export function search(index: CodeIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const docs = buildDocs(index).filter((doc) => (options.kind ? doc.symbol.kind === options.kind : true));
  if (docs.length === 0) return [];

  // --- feature aliases: expand the query and collect the globs it points at
  const featureGlobs: string[] = [];
  const matchedFeatures: string[] = [];
  const lowerQuery = query.toLowerCase().trim();
  for (const [name, feature] of Object.entries(options.features ?? {})) {
    const labels = [name, ...feature.aliases].map((label) => label.toLowerCase());
    const hit = labels.some((label) => lowerQuery.includes(label) || label.includes(lowerQuery));
    if (!hit) continue;
    matchedFeatures.push(name);
    featureGlobs.push(...feature.paths);
    // The feature's own name joins the query, so "giriş" also searches "login".
    queryTerms.push(...tokenize(name));
  }
  const inFeature = featureGlobs.length > 0 ? picomatch(featureGlobs, { dot: true }) : null;

  /**
   * Names the query could be asking for directly. A matched alias says the
   * feature's own name is what the user meant, so "giriş" must earn the same
   * exact-name boost that "login" does.
   */
  const intentNames = new Set<string>([lowerQuery.replace(/\s+/g, ''), ...matchedFeatures.map((name) => name.toLowerCase())]);

  // --- BM25 statistics
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = docs.reduce((total, doc) => total + doc.length, 0) / docs.length;
  const uniqueQueryTerms = [...new Set(queryTerms)];

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);

    let score = 0;
    let matchedTerms = 0;
    for (const term of uniqueQueryTerms) {
      const frequency = counts.get(term);
      if (!frequency) continue;
      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 1;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score +=
        idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength))));
    }

    if (matchedTerms === 0 && !(inFeature && inFeature(doc.file))) continue;

    const why: string[] = [];
    const nameTerms = new Set(tokenize(doc.symbol.name));
    const lowerName = doc.symbol.name.toLowerCase();

    if (intentNames.has(lowerName)) {
      score *= 3;
      why.push('tam ad');
    } else if (uniqueQueryTerms.some((term) => nameTerms.has(term))) {
      score *= 1.8;
      why.push('ad');
    }

    if (inFeature && inFeature(doc.file)) {
      score *= 2.2;
      why.push(`feature:${matchedFeatures.join(',')}`);
    }

    if (doc.symbol.doc && uniqueQueryTerms.some((term) => tokenize(doc.symbol.doc as string).includes(term))) {
      why.push('doc');
    }
    if ((doc.symbol.strings ?? []).some((value) => uniqueQueryTerms.some((term) => tokenize(value).includes(term)))) {
      score *= 1.3;
      why.push('literal');
    }
    if (tokenize(doc.file).some((term) => uniqueQueryTerms.includes(term))) {
      why.push('yol');
    }

    if (doc.symbol.exported) score *= 1.15;
    // Rank is a tiebreak, never the main signal.
    score *= 1 + Math.min(doc.rank * 5, 0.5);

    hits.push({
      file: doc.file,
      name: doc.symbol.name,
      kind: doc.symbol.kind,
      startLine: doc.symbol.startLine,
      endLine: doc.symbol.endLine,
      signature: doc.symbol.signature,
      ...(doc.symbol.doc ? { doc: doc.symbol.doc } : {}),
      ...(doc.symbol.parent ? { parent: doc.symbol.parent } : {}),
      score,
      why: why.length ? why : ['metin'],
    });
  }

  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, options.limit ?? 10);
}
