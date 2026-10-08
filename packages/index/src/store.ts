import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { git, type RepoContext } from '@coderep/core';
import { rankFiles } from './graph.js';
import { parsePathAliases, resolvePyImport, resolveTsImport, type PathAlias } from './imports.js';
import { parsePython } from './parse-py.js';
import { parseTypeScript } from './parse-ts.js';
import { isDeclarationFile, langFromPath, type FileEntry, type Lang } from './symbols.js';

/** Bumping this invalidates every stored index. */
export const SCHEMA_VERSION = 1;

export interface CodeIndex {
  schemaVersion: number;
  builtAt: number;
  files: FileEntry[];
}

export const indexPath = (ctx: RepoContext): string => join(ctx.stateDir, 'index.json');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The indexable file list, straight from git so `.gitignore` is honoured
 * without reimplementing it. `-c` adds tracked files, `-o` untracked ones.
 */
export async function listSourceFiles(ctx: RepoContext): Promise<string[]> {
  const out = await git(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ctx.root });
  const paths = out.split('\0').filter((path) => path !== '');

  let ignore: ((path: string) => boolean) | null = null;
  try {
    const patterns = (await readFile(join(ctx.root, '.coderepignore'), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    if (patterns.length) {
      const matches = picomatch(patterns, { dot: true });
      ignore = (path: string) => matches(path);
    }
  } catch {
    ignore = null;
  }

  return paths
    .filter((path) => langFromPath(path) !== null)
    .filter((path) => !isDeclarationFile(path))
    .filter((path) => (ignore ? !ignore(path) : true))
    .sort();
}

export async function loadIndex(ctx: RepoContext): Promise<CodeIndex | null> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(ctx), 'utf8')) as CodeIndex;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveIndex(ctx: RepoContext, index: CodeIndex): Promise<void> {
  await mkdir(ctx.stateDir, { recursive: true });
  await writeFile(indexPath(ctx), JSON.stringify(index), 'utf8');
}

async function readAliases(ctx: RepoContext): Promise<PathAlias[]> {
  try {
    return parsePathAliases(await readFile(join(ctx.root, 'tsconfig.json'), 'utf8'), '.');
  } catch {
    return [];
  }
}

export interface BuildOptions {
  /** Re-parse everything, ignoring stored hashes. */
  force?: boolean;
  /** Called once per file that actually needed parsing. */
  onParse?: (path: string) => void;
}

export interface BuildResult {
  index: CodeIndex;
  parsed: number;
  reused: number;
  removed: number;
  symbols: number;
  elapsedMs: number;
}

/**
 * Builds or refreshes the index. Files whose content hash is unchanged keep
 * their stored symbols, so a second run costs almost nothing.
 */
export async function buildIndex(ctx: RepoContext, options: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const [paths, previous, aliases] = await Promise.all([
    listSourceFiles(ctx),
    options.force ? Promise.resolve(null) : loadIndex(ctx),
    readAliases(ctx),
  ]);

  const stored = new Map((previous?.files ?? []).map((entry) => [entry.path, entry]));
  const fileSet = new Set(paths);
  const resolveCtx = { files: fileSet, aliases };

  /**
   * Re-resolves a cached file's specifiers: a module it points at may have
   * appeared or been renamed even though this file did not change.
   */
  const resolveAll = (path: string, entry: FileEntry, lang: Lang): string[] => {
    if (!entry.specifiers) return entry.imports.filter((target) => fileSet.has(target));
    const resolved = entry.specifiers
      .map((specifier) =>
        lang === 'py' ? resolvePyImport(path, specifier, resolveCtx) : resolveTsImport(path, specifier, resolveCtx),
      )
      .filter((value): value is string => value !== null);
    return [...new Set(resolved)];
  };

  const entries: FileEntry[] = [];
  let parsed = 0;
  let reused = 0;

  for (const path of paths) {
    const lang = langFromPath(path) as Lang;
    let text: string;
    try {
      text = await readFile(join(ctx.root, path), 'utf8');
    } catch {
      continue; // deleted between listing and reading
    }
    const hash = sha256(text);

    const existing = stored.get(path);
    if (existing && existing.hash === hash) {
      entries.push({ ...existing, lang, imports: resolveAll(path, existing, lang) });
      reused += 1;
      continue;
    }

    options.onParse?.(path);
    parsed += 1;
    const result = lang === 'py' ? parsePython(path, text) : parseTypeScript(path, text);
    const imports = result.importSpecifiers
      .map((specifier) =>
        lang === 'py' ? resolvePyImport(path, specifier, resolveCtx) : resolveTsImport(path, specifier, resolveCtx),
      )
      .filter((resolved): resolved is string => resolved !== null);

    entries.push({
      path,
      hash,
      lang,
      symbols: result.symbols,
      imports: [...new Set(imports)],
      specifiers: result.importSpecifiers,
      rank: 0,
    });
  }

  rankFiles(entries);

  const index: CodeIndex = { schemaVersion: SCHEMA_VERSION, builtAt: Date.now(), files: entries };
  await saveIndex(ctx, index);

  return {
    index,
    parsed,
    reused,
    removed: Math.max(0, stored.size - reused),
    symbols: entries.reduce((total, entry) => total + entry.symbols.length, 0),
    elapsedMs: Date.now() - started,
  };
}

/** Loads the stored index, building it first if there is none. */
export async function ensureIndex(ctx: RepoContext): Promise<CodeIndex> {
  const existing = await loadIndex(ctx);
  if (existing) return existing;
  return (await buildIndex(ctx)).index;
}
