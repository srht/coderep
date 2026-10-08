import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src/parse-ts.js';
import type { CodeSymbol } from '../src/symbols.js';

const find = (symbols: CodeSymbol[], name: string): CodeSymbol | undefined =>
  symbols.find((symbol) => symbol.name === name);

describe('parseTypeScript', () => {
  it('extracts kinds, export state and line ranges', () => {
    const source = `import { helper } from './util';
import type { Config } from '../config';

/**
 * Authenticates a user against the credentials store.
 * @param user the username
 */
export async function login(user: string, pass: string): Promise<boolean> {
  return helper(user, pass);
}

function localHelper(a: number) {
  return a * 2;
}

export const LOGIN_PATH = '/api/login';

const unexportedConst = 42;

export class AuthService {
  private cache = new Map<string, string>();

  /** Looks up a session. */
  async getSession(id: string) {
    return this.cache.get(id);
  }

  get ready(): boolean {
    return true;
  }

  handler = (req: Request) => {
    return new Response('ok');
  };
}

export interface Credentials {
  user: string;
}

export type Token = string | null;

export enum Role {
  Admin = 'admin',
}

export const multiLine = (
  first: string,
  second: number,
): string => {
  return first + second;
};

export default function entry() {
  return null;
}
`;
    const { symbols, importSpecifiers } = parseTypeScript('src/auth/login.ts', source);

    expect(importSpecifiers).toEqual(['./util', '../config']);

    const login = find(symbols, 'login');
    expect(login).toMatchObject({ kind: 'function', exported: true, startLine: 8 });
    expect(login?.signature).toBe('export async function login(user: string, pass: string): Promise<boolean>');
    expect(login?.doc).toBe('Authenticates a user against the credentials store.');

    // Local functions are kept: `references` needs them.
    expect(find(symbols, 'localHelper')).toMatchObject({ kind: 'function', exported: false });

    // An exported const is API surface; an unexported one is noise.
    expect(find(symbols, 'LOGIN_PATH')).toMatchObject({ kind: 'const', exported: true });
    expect(find(symbols, 'LOGIN_PATH')?.strings).toContain('/api/login');
    expect(find(symbols, 'unexportedConst')).toBeUndefined();

    expect(find(symbols, 'AuthService')).toMatchObject({ kind: 'class', exported: true });
    expect(find(symbols, 'AuthService')?.signature).toBe('export class AuthService');

    const getSession = find(symbols, 'getSession');
    expect(getSession).toMatchObject({ kind: 'method', parent: 'AuthService' });
    expect(getSession?.doc).toBe('Looks up a session.');
    expect(find(symbols, 'ready')).toMatchObject({ kind: 'method', parent: 'AuthService' });
    // An arrow assigned to a class property is still a method.
    expect(find(symbols, 'handler')).toMatchObject({ kind: 'method', parent: 'AuthService' });

    expect(find(symbols, 'Credentials')?.kind).toBe('interface');
    expect(find(symbols, 'Token')?.kind).toBe('type');
    expect(find(symbols, 'Role')?.kind).toBe('enum');

    // A multi-line signature collapses to one line.
    expect(find(symbols, 'multiLine')?.signature).toBe(
      'export const multiLine = ( first: string, second: number, ): string =>',
    );

    expect(find(symbols, 'entry')).toMatchObject({ exported: true });
  });

  it('marks names exported through an export clause', () => {
    const { symbols } = parseTypeScript('src/a.ts', `function hidden() {}\nexport { hidden };\n`);
    expect(find(symbols, 'hidden')?.exported).toBe(true);
  });

  it('recognises React components and hooks in tsx', () => {
    const source = `import { useState } from 'react';

export function LoginForm({ onSubmit }: { onSubmit: () => void }) {
  return <form onSubmit={onSubmit}><button>Giris yap</button></form>;
}

export const Badge = () => <span className="badge" />;

export function useAuth() {
  const [user, setUser] = useState(null);
  return { user, setUser };
}

export function plainHelper() {
  return 1;
}

function NotAComponent() {
  return 42;
}
`;
    const { symbols } = parseTypeScript('src/components/LoginForm.tsx', source);

    expect(find(symbols, 'LoginForm')?.kind).toBe('component');
    expect(find(symbols, 'LoginForm')?.strings).toContain('Giris yap');
    expect(find(symbols, 'Badge')?.kind).toBe('component');
    expect(find(symbols, 'useAuth')?.kind).toBe('hook');
    expect(find(symbols, 'plainHelper')?.kind).toBe('function');
    // Uppercase but no JSX, so not a component.
    expect(find(symbols, 'NotAComponent')?.kind).toBe('function');
  });

  it('recognises route handlers by file name and verb', () => {
    const source = `export async function GET(request: Request) {
  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  return Response.json({ created: true });
}

export function helper() {
  return 1;
}
`;
    const routes = parseTypeScript('src/app/api/login/route.ts', source).symbols;
    expect(find(routes, 'GET')?.kind).toBe('route');
    expect(find(routes, 'POST')?.kind).toBe('route');
    expect(find(routes, 'helper')?.kind).toBe('function');

    // The same names in an ordinary file are just functions.
    const plain = parseTypeScript('src/lib/verbs.ts', source).symbols;
    expect(find(plain, 'GET')?.kind).toBe('function');
  });

  it('collects re-export specifiers as imports', () => {
    const { importSpecifiers } = parseTypeScript('src/index.ts', `export { a } from './a';\nexport * from './b';\n`);
    expect(importSpecifiers).toEqual(['./a', './b']);
  });
});
