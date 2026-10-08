import { resolveRepo } from '@coderep/core';
import { buildMap, ensureIndex } from '@coderep/index';
import { dim } from '../format.js';

export async function mapCommand(options: { budget?: string; private?: boolean }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const index = await ensureIndex(ctx);

  const output = buildMap(index, {
    budgetTokens: options.budget ? Number.parseInt(options.budget, 10) : 2000,
    ...(options.private ? { includePrivate: true } : {}),
  });

  console.log(output);
  console.log(dim(`\n~${Math.round(output.length / 3.6)} token`));
}
