import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  GitError,
  bisect,
  changedFiles,
  createSnapshot,
  diffSnapshots,
  listSnapshots,
  loadConfig,
  resolveRepo,
  resolveSnapshot,
  restore,
  type RepoContext,
  type Snapshot,
} from '@coderep/core';

/** Tool descriptions stay terse on purpose: they are re-sent on every request. */
const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

const summarise = (snapshot: Snapshot): string =>
  `${snapshot.short} ${new Date(snapshot.ts * 1000).toISOString()} [${snapshot.meta.source}] ${snapshot.meta.label}`;

async function repo(): Promise<RepoContext> {
  return resolveRepo(process.env['CODEREP_ROOT'] ?? process.cwd());
}

/**
 * Turns failures into plain sentences. A raw GitError would spend the agent's
 * context on a command line and an absolute path it cannot act on.
 */
function guard<Args>(handler: (args: Args) => Promise<ReturnType<typeof text>>) {
  return async (args: Args): Promise<ReturnType<typeof text>> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof GitError) {
        if (/needed a single revision|unknown revision|bad revision/i.test(error.result.stderr)) {
          return text('Bu id ile bir snapshot bulunamadı. checkpoint_list ile geçerli idleri görün.');
        }
        if (/not a git repository/i.test(error.result.stderr)) {
          return text('Burası bir git reposu değil; coderep git üzerine kurulu çalışır.');
        }
        return text(`Git işlemi başarısız: ${error.result.stderr.trim().split('\n')[0] ?? 'bilinmeyen hata'}`);
      }
      return text(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'coderep', version: '0.1.0' });

  server.registerTool(
    'checkpoint_begin',
    {
      description: 'Snapshot the working tree before editing. Returns a snapshot id.',
      inputSchema: {
        label: z.string().describe('What you are about to do'),
        turn: z.string().optional().describe('Id shared with the matching checkpoint_end'),
      },
    },
    guard(async ({ label, turn }) => {
      const ctx = await repo();
      const snapshot = await createSnapshot(ctx, {
        label: `başlangıç: ${label}`,
        source: 'agent',
        ...(turn ? { turn } : {}),
      });
      return text(snapshot ? summarise(snapshot) : 'Değişiklik yok, yeni snapshot alınmadı.');
    }),
  );

  server.registerTool(
    'checkpoint_end',
    {
      description: 'Snapshot after editing. Returns the snapshot id and changed files.',
      inputSchema: {
        label: z.string().describe('What you changed'),
        turn: z.string().optional().describe('Id shared with the matching checkpoint_begin'),
      },
    },
    guard(async ({ label, turn }) => {
      const ctx = await repo();
      const snapshot = await createSnapshot(ctx, {
        label,
        source: 'agent',
        ...(turn ? { turn } : {}),
      });
      if (!snapshot) return text('Değişiklik yok, yeni snapshot alınmadı.');
      const files = await changedFiles(ctx, snapshot.id);
      return text(`${summarise(snapshot)}\n${files.join('\n')}`);
    }),
  );

  server.registerTool(
    'checkpoint_list',
    {
      description: 'List recent snapshots, newest first.',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional(),
        sinceMinutes: z.number().int().positive().optional(),
        file: z.string().optional().describe('Only snapshots touching this path'),
      },
    },
    guard(async ({ limit, sinceMinutes, file }) => {
      const ctx = await repo();
      const snapshots = await listSnapshots(ctx, {
        limit: limit ?? 20,
        ...(sinceMinutes ? { since: Date.now() - sinceMinutes * 60_000 } : {}),
        ...(file ? { file } : {}),
      });
      return text(snapshots.length ? snapshots.map(summarise).join('\n') : 'Snapshot yok.');
    }),
  );

  server.registerTool(
    'checkpoint_diff',
    {
      description: 'Diff two snapshots, or one snapshot against the working tree.',
      inputSchema: {
        from: z.string(),
        to: z.string().optional().describe('Omit to compare against the working tree'),
        paths: z.array(z.string()).optional(),
        stat: z.boolean().optional().describe('Summary only — prefer this first'),
      },
    },
    guard(async ({ from, to, paths, stat }) => {
      const ctx = await repo();
      const output = await diffSnapshots(ctx, from, to, {
        ...(paths?.length ? { paths } : {}),
        ...(stat ? { stat: true } : {}),
      });
      return text(output.trim() === '' ? 'Fark yok.' : output);
    }),
  );

  server.registerTool(
    'checkpoint_bisect',
    {
      description: 'Find the first snapshot where a command starts failing. Runs in a throwaway worktree.',
      inputSchema: {
        command: z.array(z.string()).describe('e.g. ["npm","test"]'),
        limit: z.number().int().positive().max(500).optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      },
    },
    guard(async ({ command, limit, timeoutSeconds }) => {
      const ctx = await repo();
      const config = await loadConfig(ctx);
      const result = await bisect(ctx, command, {
        limit: limit ?? 200,
        link: config.bisectLink,
        timeoutMs: (timeoutSeconds ?? 300) * 1000,
      });

      if (!result.firstBad) return text(result.reason ?? 'Bozulma bulunamadı.');

      const files = await changedFiles(ctx, result.firstBad.id);
      const lines = [
        `İlk bozuk snapshot: ${summarise(result.firstBad)}`,
        result.lastGood ? `Son sağlam snapshot: ${summarise(result.lastGood)}` : 'Zincirde sağlam snapshot yok.',
        `${result.tested} deneme / ${result.candidates} snapshot.`,
        '',
        'Değişen dosyalar:',
        ...files,
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'checkpoint_restore',
    {
      description:
        'Rewind the working tree to a snapshot. Disabled unless allowAgentRestore is set — otherwise it returns the command for the human to run.',
      inputSchema: {
        id: z.string(),
        files: z.array(z.string()).optional().describe('Restore only these paths'),
      },
    },
    guard(async ({ id, files }) => {
      const ctx = await repo();
      const config = await loadConfig(ctx);
      const target = await resolveSnapshot(ctx, id);

      // The agent that broke things should not be the one silently rewinding them.
      if (!config.allowAgentRestore) {
        const suffix = files?.length ? ` --files ${files.join(' ')}` : '';
        return text(
          [
            'Ajan tarafından geri alma kapalı (.coderep/config.json → allowAgentRestore).',
            `Hedef: ${summarise(target)}`,
            '',
            'Kullanıcının çalıştırması için:',
            `  coderep restore ${target.short}${suffix}`,
          ].join('\n'),
        );
      }

      const result = await restore(ctx, id, { ...(files?.length ? { files } : {}) });
      if (result.noop) return text('Çalışma dizini zaten bu snapshot ile aynı.');
      return text(
        [`Geri alındı → ${summarise(target)}`, result.stat.trim(), '', `Geri almayı geri al: coderep restore ${result.preRestore.slice(0, 8)}`].join('\n'),
      );
    }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
