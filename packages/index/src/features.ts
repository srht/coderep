import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RepoContext } from '@coderep/core';

export interface Feature {
  /** Globs the feature lives in. */
  paths: string[];
  /** Other words for it — where a Turkish query gets answered. */
  aliases: string[];
}

export type FeatureMap = Record<string, Feature>;

export const featuresPath = (ctx: RepoContext): string => join(ctx.root, '.coderep', 'features.yml');

export async function loadFeatures(ctx: RepoContext): Promise<FeatureMap> {
  let raw: string;
  try {
    raw = await readFile(featuresPath(ctx), 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};

  const map: FeatureMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A bare list is shorthand for just paths.
    if (Array.isArray(value)) {
      map[name] = { paths: value.map(String), aliases: [] };
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const entry = value as { paths?: unknown; aliases?: unknown };
    map[name] = {
      paths: Array.isArray(entry.paths) ? entry.paths.map(String) : [],
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
    };
  }
  return map;
}

export async function saveFeatures(ctx: RepoContext, map: FeatureMap): Promise<void> {
  const target = featuresPath(ctx);
  await mkdir(dirname(target), { recursive: true });
  const header = [
    '# Feature -> yol haritası. `coderep find` ve MCP find_feature bunu kullanır.',
    '# aliases, kod İngilizce iken Türkçe sorgu yapmanın yolu.',
    '#',
    '# login:',
    '#   paths: ["src/auth/**"]',
    '#   aliases: ["giriş", "oturum açma"]',
    '',
  ].join('\n');
  await writeFile(target, header + stringify(map), 'utf8');
}
