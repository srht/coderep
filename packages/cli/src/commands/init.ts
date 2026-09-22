import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, resolveRepo, saveConfig, type RepoContext } from '@coderep/core';
import { bold, cyan, dim, green, yellow } from '../format.js';

/** Every supported editor reads the same `mcpServers` shape, only from a different file. */
const EDITOR_CONFIGS: Record<string, string> = {
  claude: '.mcp.json',
  cursor: join('.cursor', 'mcp.json'),
  windsurf: join('.windsurf', 'mcp_config.json'),
};

const SERVER_ENTRY = { command: 'npx', args: ['-y', 'coderep', 'mcp'] };

interface McpFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function writeMcpConfig(root: string, relative: string, force: boolean): Promise<string> {
  const target = join(root, relative);

  let parsed: McpFile = {};
  if (existsSync(target)) {
    try {
      parsed = JSON.parse(await readFile(target, 'utf8')) as McpFile;
    } catch {
      return `${yellow('atlandı')} ${relative} ${dim('(geçerli JSON değil, elle düzeltin)')}`;
    }
  }

  const servers = (parsed.mcpServers ??= {});
  if (servers['coderep'] !== undefined && !force) {
    return `${dim('zaten var')} ${relative}`;
  }

  servers['coderep'] = SERVER_ENTRY;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return `${green('yazıldı')} ${relative}`;
}

async function writeIgnoreStub(ctx: RepoContext): Promise<string> {
  const target = join(ctx.root, '.coderepignore');
  if (existsSync(target)) return `${dim('zaten var')} .coderepignore`;
  await writeFile(
    target,
    [
      '# .gitignore\'a EK olarak, snapshot dışında tutulacak yollar.',
      '# Sırların ve büyük üretilmiş dosyaların yeri burası.',
      '# Örnek:',
      '# secrets/**',
      '# *.sqlite',
      '',
    ].join('\n'),
    'utf8',
  );
  return `${green('yazıldı')} .coderepignore`;
}

export async function initCommand(options: { editor?: string; force?: boolean }): Promise<void> {
  const ctx = await resolveRepo(process.cwd());
  const results: string[] = [];

  const existing = await loadConfig(ctx);
  await saveConfig(ctx, { ...DEFAULT_CONFIG, ...existing });
  results.push(`${green('yazıldı')} .coderep/config.json`);
  results.push(await writeIgnoreStub(ctx));

  const requested = options.editor ?? 'all';
  const editors = requested === 'all' ? Object.keys(EDITOR_CONFIGS) : [requested];

  for (const editor of editors) {
    const relative = EDITOR_CONFIGS[editor];
    if (!relative) {
      results.push(`${yellow('bilinmeyen editör')} ${editor}`);
      continue;
    }
    results.push(await writeMcpConfig(ctx.root, relative, options.force === true));
  }

  console.log(`${bold('coderep kuruldu')} ${dim(ctx.root)}\n`);
  for (const line of results) console.log(`  ${line}`);

  console.log(
    `\n${dim('Sırada:')}\n` +
      `  ${cyan('coderep watch')}   ${dim('— arka planda snapshot almaya başla')}\n` +
      `  ${cyan('coderep log')}     ${dim('— zaman çizelgesini gör')}\n` +
      `  ${cyan('coderep bisect -- npm test')}  ${dim('— hangi düzenlemenin bozduğunu bul')}\n\n` +
      `${dim('MCP sunucusunu görmesi için editörü yeniden başlatın.')}`,
  );
}
