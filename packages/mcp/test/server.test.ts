import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/index.js';

const exec = promisify(execFile);

const PROJECT: Record<string, string> = {
  '.gitignore': 'node_modules/\n',
  'src/auth/login.ts': `import { hashPassword } from '../util/crypto';

/** Authenticates a user and returns a session token. */
export async function login(username: string, password: string) {
  return hashPassword(password);
}
`,
  'src/util/crypto.ts': `export function hashPassword(value: string) {\n  return value;\n}\n`,
  'src/billing/invoice.ts': `export function createInvoice(amount: number) {\n  return { amount };\n}\n`,
};

let repoDir: string;
let client: Client;

/** Reads the one text block a coderep tool returns. */
const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
};

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'coderep-mcp-'));
  await exec('git', ['init', '-b', 'main'], { cwd: repoDir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  for (const [path, contents] of Object.entries(PROJECT)) {
    const target = join(repoDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  await exec('git', ['add', '-A'], { cwd: repoDir });
  await exec('git', ['commit', '-m', 'init'], { cwd: repoDir });

  // The server resolves its repo from here.
  process.env['CODEREP_ROOT'] = repoDir;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
}, 60_000);

afterAll(async () => {
  delete process.env['CODEREP_ROOT'];
  await client?.close();
  await rm(repoDir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes both halves of the tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'checkpoint_begin',
      'checkpoint_bisect',
      'checkpoint_diff',
      'checkpoint_end',
      'checkpoint_list',
      'checkpoint_restore',
      'find_feature',
      'get_symbol',
      'outline',
      'references',
      'repo_map',
    ]);
  });

  it('keeps the schema weight inside budget', async () => {
    const { tools } = await client.listTools();
    // Every tool's schema is re-sent on every request, so the tool that saves
    // tokens must not spend them. Roughly 4 characters per token.
    const characters = tools.reduce(
      (total, tool) => total + (tool.description ?? '').length + JSON.stringify(tool.inputSchema).length,
      0,
    );
    expect(Math.round(characters / 4)).toBeLessThan(1400);

    // One line each, so the list stays scannable.
    for (const tool of tools) {
      expect(tool.description ?? '').not.toContain('\n');
    }
  });

  it('find_feature locates a symbol with its line range', async () => {
    const result = await client.callTool({ name: 'find_feature', arguments: { query: 'login', limit: 3 } });
    const text = textOf(result);
    expect(text).toContain('src/auth/login.ts:');
    expect(text).toContain('login [function]');
    expect(text).toContain('Authenticates a user');
  });

  it('get_symbol returns one symbol, not the file', async () => {
    const result = await client.callTool({
      name: 'get_symbol',
      arguments: { file: 'src/util/crypto.ts', name: 'hashPassword' },
    });
    const text = textOf(result);
    expect(text).toContain('hashPassword');
    expect(text).toContain('src/util/crypto.ts:1-3');
    expect(text).not.toContain('createInvoice');
  });

  it('explains a miss instead of leaking a git error', async () => {
    const result = await client.callTool({
      name: 'get_symbol',
      arguments: { file: 'src/util/crypto.ts', name: 'nothingHere' },
    });
    const text = textOf(result);
    expect(text).toContain('bulunamadı');
    expect(text).toContain('outline');
    expect(text).not.toContain('git ');
  });

  it('outline lists signatures without bodies', async () => {
    const result = await client.callTool({ name: 'outline', arguments: { file: 'src/auth/login.ts' } });
    const text = textOf(result);
    expect(text).toContain('export function login');
    expect(text).not.toContain('return hashPassword(password);');
  });

  it('references names the enclosing symbol', async () => {
    const result = await client.callTool({ name: 'references', arguments: { name: 'hashPassword' } });
    expect(textOf(result)).toContain('(login)');
  });

  it('repo_map honours its budget', async () => {
    const generous = textOf(await client.callTool({ name: 'repo_map', arguments: { budgetTokens: 2000 } }));
    const tight = textOf(await client.callTool({ name: 'repo_map', arguments: { budgetTokens: 15 } }));

    expect(generous).toContain('src/auth/login.ts');
    expect(tight.length).toBeLessThan(generous.length);
  });

  it('refuses an agent restore while the gate is closed', async () => {
    const list = textOf(await client.callTool({ name: 'checkpoint_end', arguments: { label: 'test' } }));
    const id = /^([0-9a-f]{8})/m.exec(list)?.[1];
    expect(id).toBeDefined();

    const result = textOf(await client.callTool({ name: 'checkpoint_restore', arguments: { id: id as string } }));
    expect(result).toContain('allowAgentRestore');
    expect(result).toContain('coderep restore');
  });
});
