import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIndex, listSourceFiles, loadIndex } from '../src/store.js';
import { makeRepo, write } from './helpers.js';

const PROJECT = {
  'src/auth/login.ts': `import { hash } from '../util/crypto';\nexport function login(u: string) { return hash(u); }\n`,
  'src/util/crypto.ts': `export function hash(v: string) { return v; }\n`,
  'src/index.ts': `export { login } from './auth/login';\n`,
  'app/service.py': `from .models import User\n\ndef get_user(uid):\n    return User(uid)\n`,
  'app/models.py': `class User:\n    def __init__(self, uid):\n        self.uid = uid\n`,
  'README.md': '# not indexed\n',
  'node_modules/pkg/index.js': 'module.exports = 1;\n',
};

describe('listSourceFiles', () => {
  it('takes only source files and honours gitignore', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const files = await listSourceFiles(repo);
      expect(files).toEqual([
        'app/models.py',
        'app/service.py',
        'src/auth/login.ts',
        'src/index.ts',
        'src/util/crypto.ts',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('honours .coderepignore and skips .d.ts', async () => {
    const repo = await makeRepo({
      ...PROJECT,
      '.coderepignore': 'app/**\n',
      'src/types.d.ts': 'export declare const a: number;\n',
    });
    try {
      const files = await listSourceFiles(repo);
      expect(files.some((path) => path.startsWith('app/'))).toBe(false);
      expect(files).not.toContain('src/types.d.ts');
      expect(files).toContain('src/auth/login.ts');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('buildIndex', () => {
  it('indexes both languages and resolves imports across them', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const result = await buildIndex(repo);
      expect(result.parsed).toBe(5);
      expect(result.reused).toBe(0);
      // login, hash, get_user, User, User.__init__ — src/index.ts only
      // re-exports, so it contributes no symbol of its own.
      expect(result.symbols).toBe(5);

      const login = result.index.files.find((entry) => entry.path === 'src/auth/login.ts');
      // An extensionless relative import resolves to the real file.
      expect(login?.imports).toEqual(['src/util/crypto.ts']);

      const barrel = result.index.files.find((entry) => entry.path === 'src/index.ts');
      expect(barrel?.imports).toEqual(['src/auth/login.ts']);

      const service = result.index.files.find((entry) => entry.path === 'app/service.py');
      expect(service?.imports).toEqual(['app/models.py']);
    } finally {
      await repo.cleanup();
    }
  });

  it('re-parses only the files whose contents changed', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      await buildIndex(repo);

      const reparsed: string[] = [];
      await write(repo, 'src/auth/login.ts', `export function login(u: string) { return u.trim(); }\n`);
      const second = await buildIndex(repo, { onParse: (path) => reparsed.push(path) });

      expect(reparsed).toEqual(['src/auth/login.ts']);
      expect(second.parsed).toBe(1);
      expect(second.reused).toBe(4);
    } finally {
      await repo.cleanup();
    }
  });

  it('re-parses everything with --force', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      await buildIndex(repo);
      const forced = await buildIndex(repo, { force: true });
      expect(forced.parsed).toBe(5);
      expect(forced.reused).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it('re-resolves a cached file whose import target appeared later', async () => {
    const repo = await makeRepo({
      'src/a.ts': `import { b } from './b';\nexport const a = b;\n`,
    });
    try {
      const first = await buildIndex(repo);
      // The target does not exist yet, so nothing resolves.
      expect(first.index.files.find((entry) => entry.path === 'src/a.ts')?.imports).toEqual([]);

      await write(repo, 'src/b.ts', `export const b = 1;\n`);
      const second = await buildIndex(repo);

      // src/a.ts was unchanged, yet its import now points somewhere real.
      expect(second.parsed).toBe(1);
      expect(second.index.files.find((entry) => entry.path === 'src/a.ts')?.imports).toEqual(['src/b.ts']);
    } finally {
      await repo.cleanup();
    }
  });

  it('drops files that were deleted', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      await buildIndex(repo);
      await rm(join(repo.root, 'app/service.py'));
      const second = await buildIndex(repo);
      expect(second.index.files.map((entry) => entry.path)).not.toContain('app/service.py');
    } finally {
      await repo.cleanup();
    }
  });

  it('invalidates a stored index from another schema version', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      await buildIndex(repo);
      const stored = await loadIndex(repo);
      expect(stored).not.toBeNull();

      const { writeFile } = await import('node:fs/promises');
      const { indexPath } = await import('../src/store.js');
      await writeFile(indexPath(repo), JSON.stringify({ ...stored, schemaVersion: 999 }), 'utf8');

      expect(await loadIndex(repo)).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  it('resolves an ESM .js specifier to its TypeScript source', async () => {
    // The dominant convention in modern TS ESM: write `./b.js`, ship `./b.ts`.
    const repo = await makeRepo({
      'src/a.ts': `import { b } from './b.js';\nexport const a = b;\n`,
      'src/b.ts': `export const b = 1;\n`,
      'src/c.ts': `import { D } from './d.jsx';\nexport const c = D;\n`,
      'src/d.tsx': `export const D = () => <i />;\n`,
    });
    try {
      const { index } = await buildIndex(repo);
      expect(index.files.find((entry) => entry.path === 'src/a.ts')?.imports).toEqual(['src/b.ts']);
      expect(index.files.find((entry) => entry.path === 'src/c.ts')?.imports).toEqual(['src/d.tsx']);
    } finally {
      await repo.cleanup();
    }
  });

  it('still prefers a real .js file over its .ts sibling guess', async () => {
    const repo = await makeRepo({
      'src/a.ts': `import { b } from './b.js';\nexport const a = b;\n`,
      'src/b.js': `export const b = 1;\n`,
    });
    try {
      const { index } = await buildIndex(repo);
      expect(index.files.find((entry) => entry.path === 'src/a.ts')?.imports).toEqual(['src/b.js']);
    } finally {
      await repo.cleanup();
    }
  });

  it('resolves tsconfig path aliases', async () => {
    const repo = await makeRepo({
      'tsconfig.json': `{
  // JSONC comments are tolerated
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
`,
      'src/consumer.ts': `import { thing } from '@/lib/thing';\nexport const x = thing;\n`,
      'src/lib/thing.ts': `export const thing = 1;\n`,
    });
    try {
      const result = await buildIndex(repo);
      expect(result.index.files.find((entry) => entry.path === 'src/consumer.ts')?.imports).toEqual([
        'src/lib/thing.ts',
      ]);
    } finally {
      await repo.cleanup();
    }
  });
});
