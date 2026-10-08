import { describe, expect, it } from 'vitest';
import { parsePython } from '../src/parse-py.js';
import type { CodeSymbol } from '../src/symbols.js';

const find = (symbols: CodeSymbol[], name: string): CodeSymbol | undefined =>
  symbols.find((symbol) => symbol.name === name);

describe('parsePython', () => {
  it('extracts functions, classes, methods and their ranges', () => {
    const source = `import os
import sys as system
from .models import User
from ..config import settings


def login(user, password):
    """Authenticate a user and return a session token."""
    return _hash(password)


def _hash(value):
    return value


async def refresh(token):
    """Refresh an expired token."""
    return token


class AuthService:
    """Holds the session cache."""

    def __init__(self, store):
        self.store = store

    def get_session(self, session_id):
        """Look up a session."""
        return self.store.get(session_id)

    async def revoke(self, session_id):
        return None


def trailing():
    return 1
`;
    const { symbols, importSpecifiers } = parsePython('app/auth.py', source);

    expect(importSpecifiers).toEqual(['os', 'sys', '.models', '..config']);

    const login = find(symbols, 'login');
    expect(login).toMatchObject({ kind: 'function', exported: true, startLine: 7, endLine: 9 });
    expect(login?.signature).toBe('def login(user, password)');
    expect(login?.doc).toBe('Authenticate a user and return a session token.');

    // A leading underscore means private, not exported.
    expect(find(symbols, '_hash')?.exported).toBe(false);

    expect(find(symbols, 'refresh')).toMatchObject({ kind: 'function' });
    expect(find(symbols, 'refresh')?.signature).toBe('async def refresh(token)');

    const service = find(symbols, 'AuthService');
    expect(service).toMatchObject({ kind: 'class', startLine: 21 });
    expect(service?.doc).toBe('Holds the session cache.');
    // The class ends with its last method's body, not at the blank lines after.
    expect(service?.endLine).toBe(32);

    expect(find(symbols, 'get_session')).toMatchObject({ kind: 'method', parent: 'AuthService' });
    expect(find(symbols, 'get_session')?.doc).toBe('Look up a session.');
    expect(find(symbols, '__init__')).toMatchObject({ kind: 'method', parent: 'AuthService' });
    expect(find(symbols, 'revoke')).toMatchObject({ kind: 'method', parent: 'AuthService' });

    expect(find(symbols, 'trailing')).toMatchObject({ startLine: 35, endLine: 36 });
  });

  it('keeps decorators in the signature and range, so routes are findable', () => {
    const source = `from fastapi import APIRouter

router = APIRouter()


@router.post("/api/login")
async def login_endpoint(credentials: dict):
    """Log a user in."""
    return {"ok": True}


@property
def name(self):
    return self._name
`;
    const { symbols } = parsePython('app/routes.py', source);

    const endpoint = find(symbols, 'login_endpoint');
    // The decorator line opens the declaration.
    expect(endpoint?.startLine).toBe(6);
    expect(endpoint?.signature).toBe('@router.post("/api/login") async def login_endpoint(credentials: dict)');
    expect(endpoint?.strings).toContain('/api/login');
    expect(find(symbols, 'name')?.signature).toBe('@property def name(self)');
  });

  it('follows a signature that spans several lines', () => {
    const source = `def create_user(
    name: str,
    email: str,
    role: str = "member",
):
    """Create and persist a user."""
    return {"name": name}
`;
    const { symbols } = parsePython('app/users.py', source);
    const create = find(symbols, 'create_user');
    expect(create?.signature).toBe('def create_user( name: str, email: str, role: str = "member", )');
    expect(create?.doc).toBe('Create and persist a user.');
    expect(create?.startLine).toBe(1);
  });

  it('nests an inner def under its enclosing function', () => {
    const source = `def outer():
    def inner():
        return 1
    return inner()


def after():
    return 2
`;
    const { symbols } = parsePython('app/nested.py', source);
    expect(find(symbols, 'outer')).toMatchObject({ kind: 'function', startLine: 1, endLine: 4 });
    // Nested in a function, not a class, so it stays a function with no parent.
    expect(find(symbols, 'inner')).toMatchObject({ kind: 'function', startLine: 2 });
    expect(find(symbols, 'inner')?.parent).toBeUndefined();
    expect(find(symbols, 'after')?.startLine).toBe(7);
  });

  it('is not fooled by brackets inside strings or comments', () => {
    const source = `def tricky(pattern="(unclosed"):  # a ) comment
    return pattern


def next_one():
    return 1
`;
    const { symbols } = parsePython('app/tricky.py', source);
    expect(find(symbols, 'tricky')?.signature).toBe('def tricky(pattern="(unclosed")');
    expect(find(symbols, 'next_one')?.startLine).toBe(5);
  });
});
