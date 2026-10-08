import { describe, expect, it } from 'vitest';
import { buildIndex } from '../src/store.js';
import { loadFeatures, saveFeatures } from '../src/features.js';
import { search, tokenize } from '../src/search.js';
import { buildMap } from '../src/map.js';
import { findReferences, getSymbolSource, outline } from '../src/read.js';
import { makeRepo, write } from './helpers.js';

/** A project with real noise, so a hit has to beat something. */
const PROJECT: Record<string, string> = {
  'src/auth/login.ts': `import { hashPassword } from '../util/crypto';

/** Authenticates a user and returns a session token. */
export async function login(username: string, password: string) {
  return hashPassword(password);
}

export const LOGIN_ENDPOINT = '/api/login';
`,
  'src/auth/session.ts': `export function createSession(userId: string) {
  return { userId };
}
`,
  'src/components/LoginForm.tsx': `export function LoginForm() {
  return <form><button>Giris yap</button></form>;
}
`,
  'src/util/crypto.ts': `export function hashPassword(value: string) {
  return value;
}
`,
  'src/billing/invoice.ts': `export function createInvoice(amount: number) {
  return { amount };
}

export function renderInvoicePdf(id: string) {
  return id;
}
`,
  'src/reports/analytics.ts': `export function trackEvent(name: string) {
  return name;
}
`,
};

describe('tokenize', () => {
  it('splits camelCase, snake_case and paths', () => {
    expect(tokenize('hashPassword')).toEqual(['hash', 'password']);
    expect(tokenize('get_user_by_id')).toEqual(['get', 'user', 'by', 'id']);
    expect(tokenize('src/auth/login.ts')).toEqual(['src', 'auth', 'login', 'ts']);
    expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
  });
});

describe('search', () => {
  it('puts the right symbol on top for an English query', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);
      const hits = search(index, 'login');

      expect(hits[0]?.name).toBe('login');
      expect(hits[0]?.file).toBe('src/auth/login.ts');
      expect(hits[0]?.why).toContain('tam ad');

      // Billing has nothing to do with it.
      expect(hits.slice(0, 3).some((hit) => hit.file.startsWith('src/billing/'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('reports which signal fired', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);

      // A docstring word that appears in no symbol name.
      const byDoc = search(index, 'authenticates');
      expect(byDoc[0]?.name).toBe('login');
      expect(byDoc[0]?.why).toContain('doc');

      // A visible UI label, which only exists as JSX text.
      const byLabel = search(index, 'Giris yap');
      expect(byLabel[0]?.name).toBe('LoginForm');
      expect(byLabel[0]?.why).toContain('literal');

      // A path-only match.
      const byPath = search(index, 'billing');
      expect(byPath[0]?.file).toBe('src/billing/invoice.ts');
      expect(byPath[0]?.why).toContain('yol');
    } finally {
      await repo.cleanup();
    }
  });

  it('answers a Turkish query through a feature alias', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);

      // Without an alias, a Turkish word finds nothing.
      expect(search(index, 'giriş')).toHaveLength(0);

      await saveFeatures(repo, {
        login: { paths: ['src/auth/**', 'src/components/LoginForm.tsx'], aliases: ['giriş', 'oturum açma'] },
      });
      const features = await loadFeatures(repo);
      expect(features['login']?.aliases).toContain('giriş');

      const hits = search(index, 'giriş', { features });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.file.startsWith('src/auth/')).toBe(true);
      expect(hits[0]?.why.some((reason) => reason.startsWith('feature:'))).toBe(true);

      // The same answer as the English query.
      expect(hits[0]?.name).toBe(search(index, 'login', { features })[0]?.name);
    } finally {
      await repo.cleanup();
    }
  });

  it('round-trips a features file written as a bare path list', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      await write(repo, '.coderep/features.yml', 'billing:\n  - "src/billing/**"\n');
      const features = await loadFeatures(repo);
      expect(features['billing']).toEqual({ paths: ['src/billing/**'], aliases: [] });
    } finally {
      await repo.cleanup();
    }
  });

  it('can be narrowed to one kind', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);
      const hits = search(index, 'login', { kind: 'component' });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.name).toBe('LoginForm');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('read helpers', () => {
  it('returns one symbol instead of the whole file', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);
      const source = await getSymbolSource(repo, index, 'src/billing/invoice.ts', 'createInvoice');

      expect(source?.body).toContain('createInvoice');
      // The sibling function in the same file is not included.
      expect(source?.body).not.toContain('renderInvoicePdf');

      const signatureOnly = await getSymbolSource(repo, index, 'src/billing/invoice.ts', 'createInvoice', 'signature');
      expect(signatureOnly?.body).toBeUndefined();
      expect(signatureOnly?.signature).toContain('createInvoice');

      expect(await getSymbolSource(repo, index, 'src/billing/invoice.ts', 'nope')).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  it('outlines a file as signatures only', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);
      const rows = outline(index, 'src/billing/invoice.ts');
      expect(rows?.map((row) => row.name)).toEqual(['createInvoice', 'renderInvoicePdf']);
      expect(rows?.[0]?.startLine).toBe(1);
      expect(outline(index, 'nope.ts')).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });

  it('finds call sites and names the enclosing symbol', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);
      const refs = await findReferences(repo, index, 'hashPassword');

      const callSite = refs.find((ref) => ref.file === 'src/auth/login.ts' && ref.symbol === 'login');
      expect(callSite).toBeDefined();
      expect(callSite?.text).toContain('hashPassword');

      // Its own declaration line is not reported as a reference to itself.
      expect(refs.some((ref) => ref.file === 'src/util/crypto.ts' && ref.symbol === 'hashPassword')).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('buildMap', () => {
  it('stays inside the token budget and reports what it dropped', async () => {
    const repo = await makeRepo(PROJECT);
    try {
      const { index } = await buildIndex(repo);

      const generous = buildMap(index, { budgetTokens: 2000 });
      expect(generous).toContain('src/auth/login.ts');
      expect(generous).toContain('login');
      expect(generous).not.toContain('sığmadı');

      const tight = buildMap(index, { budgetTokens: 20 });
      expect(tight.length).toBeLessThan(generous.length);
      expect(tight).toContain('sığmadı');
    } finally {
      await repo.cleanup();
    }
  });
});
