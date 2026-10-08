import { posix } from 'node:path';

/** Extensions tried, in order, for an import written without one. */
const TS_CANDIDATES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_CANDIDATES = TS_CANDIDATES.map((extension) => `/index${extension}`);

export interface PathAlias {
  /** `@/*` becomes prefix `@/`. */
  prefix: string;
  /** Repo-relative targets the prefix expands to. */
  targets: string[];
}

/**
 * Reads `compilerOptions.paths` out of a tsconfig so aliased imports resolve.
 * Comments are stripped because tsconfig is JSONC in practice.
 */
export function parsePathAliases(tsconfigText: string, tsconfigDir: string): PathAlias[] {
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    const stripped = tsconfigText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    parsed = JSON.parse(stripped) as typeof parsed;
  } catch {
    return [];
  }

  const options = parsed.compilerOptions;
  if (!options?.paths) return [];
  const base = posix.normalize(posix.join(tsconfigDir, options.baseUrl ?? '.'));

  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (!Array.isArray(targets)) continue;
    aliases.push({
      prefix: pattern.replace(/\*$/, ''),
      targets: targets.map((target) => posix.normalize(posix.join(base, target.replace(/\*$/, '')))),
    });
  }
  // Longest prefix first, so `@/components/` wins over `@/`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

export interface ResolveContext {
  /** Every indexable file, repo-relative, for existence checks. */
  files: ReadonlySet<string>;
  aliases: PathAlias[];
}

/**
 * ESM TypeScript is written `import './foo.js'` while the file on disk is
 * `./foo.ts`. This is the dominant convention in modern TS projects (including
 * this one), so a `.js` specifier must also be tried as its TS source.
 */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const tryCandidates = (base: string, files: ReadonlySet<string>): string | null => {
  if (files.has(base)) return base;

  const dotIndex = base.lastIndexOf('.');
  const extension = dotIndex > base.lastIndexOf('/') ? base.slice(dotIndex) : '';
  for (const replacement of JS_TO_TS[extension] ?? []) {
    const candidate = base.slice(0, dotIndex) + replacement;
    if (files.has(candidate)) return candidate;
  }

  for (const suffix of TS_CANDIDATES) if (files.has(base + suffix)) return base + suffix;
  for (const suffix of INDEX_CANDIDATES) if (files.has(base + suffix)) return base + suffix;
  return null;
};

/**
 * Resolves a TS/JS module specifier to a repo-relative file, or null for
 * anything outside the repo (node_modules, node builtins, unresolved aliases).
 */
export function resolveTsImport(fromFile: string, specifier: string, ctx: ResolveContext): string | null {
  if (specifier.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
    return tryCandidates(base.replace(/\/$/, ''), ctx.files);
  }

  for (const alias of ctx.aliases) {
    if (alias.prefix !== '' && specifier.startsWith(alias.prefix)) {
      const rest = specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const found = tryCandidates(posix.normalize(posix.join(target, rest)), ctx.files);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Resolves a Python import. A leading dot counts one package level, as in
 * `from ..config import settings`.
 */
export function resolvePyImport(fromFile: string, specifier: string, ctx: ResolveContext): string | null {
  const leadingDots = /^\.*/.exec(specifier)?.[0].length ?? 0;
  const moduleParts = specifier.slice(leadingDots).split('.').filter((part) => part !== '');

  let baseDir: string;
  if (leadingDots > 0) {
    // One dot is the current package; each extra dot climbs one level.
    baseDir = posix.dirname(fromFile);
    for (let i = 1; i < leadingDots; i += 1) baseDir = posix.dirname(baseDir);
  } else {
    baseDir = '';
  }

  const joined = posix.normalize(posix.join(baseDir, ...moduleParts));
  if (ctx.files.has(`${joined}.py`)) return `${joined}.py`;
  if (ctx.files.has(`${joined}/__init__.py`)) return `${joined}/__init__.py`;

  // `from app.models import User` may name the symbol, not the module.
  if (moduleParts.length > 1) {
    const parent = posix.normalize(posix.join(baseDir, ...moduleParts.slice(0, -1)));
    if (ctx.files.has(`${parent}.py`)) return `${parent}.py`;
  }
  return null;
}
