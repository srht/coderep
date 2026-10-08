import { MAX_STRINGS_PER_SYMBOL, isUsefulString, oneLine, type CodeSymbol, type SymbolKind } from './symbols.js';
import type { ParseResult } from './parse-ts.js';

const DEF = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DECORATOR = /^\s*@/;
const IMPORT_FROM = /^\s*from\s+([.\w]+)\s+import\b/;
const IMPORT_PLAIN = /^\s*import\s+(.+)$/;
/**
 * Route decorators across the common frameworks: FastAPI/Flask/Blueprint
 * (`@router.post(...)`, `@app.route(...)`) and Django's method guards.
 */
const ROUTE_DECORATOR =
  /^@[\w.]*\.(get|post|put|patch|delete|head|options|route|websocket)\s*\(|^@(api_view|require_http_methods)\b/i;

const STRING_LITERAL = /(?:'''|""")([\s\S]*?)(?:'''|""")|'([^'\n\\]{3,80})'|"([^"\n\\]{3,80})"/g;

/** Net bracket depth of a line, so a signature split across lines is followed to its end. */
function bracketDelta(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') break; // a comment cannot change depth
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
  }
  return depth;
}

/** Drops a trailing `#` comment without touching a `#` inside a string. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

/** The docstring opening the body, if the first statement is a string. */
function docstringAt(lines: string[], index: number): string | undefined {
  for (let i = index; i < Math.min(index + 3, lines.length); i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    const match = /^(?:[rubf]{0,2})('''|"""|'|")([\s\S]*)$/.exec(line);
    if (!match) return undefined;
    const body = (match[2] ?? '').replace(/('''|"""|'|")\s*$/, '').trim();
    return body ? oneLine(body, 160) : undefined;
  }
  return undefined;
}

function stringsIn(body: string): string[] | undefined {
  const found = new Set<string>();
  for (const match of body.matchAll(STRING_LITERAL)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\s+/g, ' ').trim();
    if (isUsefulString(value)) found.add(value);
    if (found.size >= MAX_STRINGS_PER_SYMBOL) break;
  }
  return found.size ? [...found] : undefined;
}

/**
 * Extracts Python symbols with a line scanner rather than a grammar.
 * `def`/`class`/decorator/docstring structure is regular enough that an
 * indent stack plus bracket-depth tracking covers it, which keeps the package
 * free of native and wasm dependencies.
 */
export function parsePython(path: string, text: string): ParseResult {
  const lines = text.split('\n');
  const symbols: CodeSymbol[] = [];
  const importSpecifiers: string[] = [];
  /** Open declarations, innermost last, so a method knows its class. */
  const stack: Array<{ indent: number; name: string; kind: SymbolKind; symbol: CodeSymbol }> = [];
  let pendingDecorators: string[] = [];
  let decoratorStart = -1;
  /** Last line that belonged to a body, so trailing blanks and the next
   *  declaration's decorators are not swallowed into the previous range. */
  let lastBodyLine = 0;

  const closeTo = (indent: number, endLine: number): void => {
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      const open = stack.pop();
      if (open) open.symbol.endLine = endLine;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;

    if (DECORATOR.test(line)) {
      if (decoratorStart === -1) decoratorStart = i + 1;
      pendingDecorators.push(line.trim());
      continue;
    }

    const previousBodyLine = lastBodyLine;
    lastBodyLine = i + 1;

    const fromMatch = IMPORT_FROM.exec(line);
    if (fromMatch?.[1]) {
      importSpecifiers.push(fromMatch[1]);
      continue;
    }
    const plainMatch = IMPORT_PLAIN.exec(line);
    if (plainMatch?.[1] && !line.includes('(')) {
      for (const part of plainMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) importSpecifiers.push(name);
      }
      continue;
    }

    const match = DEF.exec(line);
    if (!match) {
      pendingDecorators = [];
      decoratorStart = -1;
      continue;
    }

    const indent = (match[1] ?? '').length;
    const keyword = match[2] ?? 'def';
    const name = match[3] ?? '';

    closeTo(indent, previousBodyLine); // the sibling ended with its own last body line

    // Follow a signature that spans lines.
    let depth = bracketDelta(line);
    let last = i;
    while (depth > 0 && last + 1 < lines.length) {
      last += 1;
      depth += bracketDelta(lines[last] as string);
    }

    const parent = stack.length > 0 ? (stack[stack.length - 1] as { name: string; kind: SymbolKind }) : undefined;
    const isClass = keyword === 'class';
    const isRoute = !isClass && pendingDecorators.some((decorator) => ROUTE_DECORATOR.test(decorator));
    const kind: SymbolKind = isClass
      ? 'class'
      : isRoute
        ? 'route'
        : parent?.kind === 'class'
          ? 'method'
          : 'function';

    // A multi-line signature is part of this declaration, not the previous one.
    lastBodyLine = last + 1;

    const headRaw = lines
      .slice(i, last + 1)
      .map(stripComment)
      .join(' ')
      .replace(/\s*:\s*$/, '');
    const decoratorPrefix = pendingDecorators.length > 0 ? `${pendingDecorators.join(' ')} ` : '';
    const doc = docstringAt(lines, last + 1);

    const symbol: CodeSymbol = {
      name,
      kind,
      // A decorator is part of the declaration: a route lives there.
      startLine: decoratorStart !== -1 ? decoratorStart : i + 1,
      endLine: lines.length,
      exported: !name.startsWith('_'),
      signature: oneLine(decoratorPrefix + headRaw),
      ...(doc ? { doc } : {}),
      ...(kind === 'method' && parent ? { parent: parent.name } : {}),
    };
    symbols.push(symbol);
    stack.push({ indent, name, kind, symbol });

    pendingDecorators = [];
    decoratorStart = -1;
  }

  closeTo(0, lastBodyLine);

  // Strings come from each symbol's own body, now that the ranges are known.
  for (const symbol of symbols) {
    const body = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
    const strings = stringsIn(body);
    if (strings) symbol.strings = strings;
  }

  return { symbols, importSpecifiers };
}

export const parsePythonPath = (path: string): boolean => path.endsWith('.py') || path.endsWith('.pyi');
