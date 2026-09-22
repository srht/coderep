import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath, type RepoContext } from './paths.js';

export interface Config {
  version: 1;
  /** When false, the MCP restore tool refuses and only proposes. */
  allowAgentRestore: boolean;
  /** Quiet period after the last write before the watcher snapshots. */
  debounceMs: number;
  /** Extra paths the watcher ignores, on top of .gitignore. */
  watchIgnore: string[];
  /** Paths symlinked into a bisect worktree so commands can actually run. */
  bisectLink: string[];
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  allowAgentRestore: false,
  debounceMs: 500,
  watchIgnore: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/target/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/coverage/**',
    '**/.coderep/**',
  ],
  bisectLink: ['node_modules', '.venv', 'venv'],
};

export async function loadConfig(ctx: RepoContext): Promise<Config> {
  try {
    const raw = await readFile(configPath(ctx), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(ctx: RepoContext, config: Config): Promise<void> {
  const target = configPath(ctx);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
