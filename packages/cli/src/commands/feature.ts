import { resolveRepo } from '@coderep/core';
import { ensureIndex, featuresPath, loadFeatures, saveFeatures } from '@coderep/index';
import { bold, cyan, dim, green, yellow } from '../format.js';

export async function featureListCommand(): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const features = await loadFeatures(ctx);
  const names = Object.keys(features);

  if (names.length === 0) {
    console.log(dim('Tanımlı feature yok.'));
    console.log(dim('Öneri almak için: coderep feature suggest'));
    return;
  }

  for (const name of names.sort()) {
    const feature = features[name];
    console.log(`${bold(name)}`);
    for (const path of feature?.paths ?? []) console.log(`  ${cyan(path)}`);
    if (feature?.aliases.length) console.log(`  ${dim(`alias: ${feature.aliases.join(', ')}`)}`);
  }
  console.log(dim(`\n${featuresPath(ctx)}`));
}

export async function featureAddCommand(
  name: string,
  paths: string[],
  options: { alias?: string[] },
): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const features = await loadFeatures(ctx);
  const existing = features[name];

  features[name] = {
    paths: [...new Set([...(existing?.paths ?? []), ...paths])],
    aliases: [...new Set([...(existing?.aliases ?? []), ...(options.alias ?? [])])],
  };
  await saveFeatures(ctx, features);

  console.log(`${green(existing ? 'güncellendi' : 'eklendi')} ${bold(name)}`);
  for (const path of features[name]?.paths ?? []) console.log(`  ${cyan(path)}`);
  if (features[name]?.aliases.length) console.log(`  ${dim(`alias: ${features[name]?.aliases.join(', ')}`)}`);
}

export async function featureRemoveCommand(name: string): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const features = await loadFeatures(ctx);
  if (!(name in features)) {
    console.error(`Böyle bir feature yok: ${name}`);
    process.exitCode = 1;
    return;
  }
  delete features[name];
  await saveFeatures(ctx, features);
  console.log(`${green('silindi')} ${name}`);
}

/**
 * Proposes features from the directories that actually hold ranked code, and
 * from route files, which name a feature better than a folder does.
 */
export async function featureSuggestCommand(): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const [index, existing] = await Promise.all([ensureIndex(ctx), loadFeatures(ctx)]);

  const byDirectory = new Map<string, { files: number; rank: number }>();
  const routeNames = new Set<string>();

  for (const entry of index.files) {
    const parts = entry.path.split('/');
    // The folder under the source root is the feature-shaped one.
    const directory = parts.length >= 3 ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
    if (directory === '') continue;
    const current = byDirectory.get(directory) ?? { files: 0, rank: 0 };
    byDirectory.set(directory, { files: current.files + 1, rank: current.rank + entry.rank });

    if (entry.symbols.some((symbol) => symbol.kind === 'route')) {
      const name = parts[parts.length - 2];
      if (name && !['src', 'app', 'api'].includes(name)) routeNames.add(name);
    }
  }

  // A directory counts as covered only when a feature already names that
  // directory itself. One file inside it must not hide the whole tree.
  const covered = new Set(
    Object.values(existing).flatMap((feature) =>
      feature.paths.map((path) => path.replace(/\/?\*+.*$/, '').replace(/\/$/, '')),
    ),
  );
  const candidates = [...byDirectory.entries()]
    .filter(([directory]) => !covered.has(directory))
    .sort((a, b) => b[1].rank - a[1].rank)
    .slice(0, 10);

  if (candidates.length === 0 && routeNames.size === 0) {
    console.log(dim('Önerilecek bir şey bulunamadı.'));
    return;
  }

  console.log(bold('Aday feature\'lar') + dim(' (kopyalayıp çalıştırın)\n'));
  const suggested = new Set<string>();

  for (const [directory, info] of candidates) {
    const name = directory.split('/').pop() ?? directory;
    if (suggested.has(name)) continue;
    suggested.add(name);
    console.log(`  ${dim(`# ${info.files} dosya`)}`);
    console.log(`  ${cyan(`coderep feature add ${name} "${directory}/**"`)}`);
  }
  for (const name of routeNames) {
    if (suggested.has(name)) continue;
    suggested.add(name);
    console.log(`  ${dim('# route dosyası bulundu')}`);
    console.log(`  ${cyan(`coderep feature add ${name} "**/${name}/**"`)}`);
  }
  console.log(
    dim(`\nTürkçe sorgu için alias ekleyin:\n  `) +
      yellow('coderep feature add login "src/auth/**" --alias "giriş" --alias "oturum açma"'),
  );
}
