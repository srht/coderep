import ts from 'typescript';
import {
  MAX_STRINGS_PER_SYMBOL,
  isUsefulString,
  oneLine,
  type CodeSymbol,
  type SymbolKind,
} from './symbols.js';

export interface ParseResult {
  symbols: CodeSymbol[];
  /** Raw module specifiers, unresolved. */
  importSpecifiers: string[];
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Files whose exported HTTP-verb names are route handlers (Next.js, SvelteKit, Nuxt). */
const ROUTE_FILE = /(^|\/)(route|\+server|\+page\.server|api)\.[mc]?[jt]sx?$/;

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isExported = (node: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;

/** The declaration up to its body — what a reader needs and nothing more. */
function declarationHead(node: ts.Node, sf: ts.SourceFile, from?: number): string {
  const start = from ?? node.getStart(sf);
  const body = (node as { body?: ts.Node }).body;
  if (body) return oneLine(sf.text.slice(start, body.pos));

  const members = (node as { members?: ts.NodeArray<ts.Node> }).members;
  if (members) return oneLine(sf.text.slice(start, members.pos).replace(/\{\s*$/, ''));

  const full = sf.text.slice(start, node.end);
  return oneLine(full.split('\n')[0] ?? full);
}

/** First meaningful line of the JSDoc block, tags skipped. */
function docOf(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const range = ranges[i];
    if (!range) continue;
    const raw = sf.text.slice(range.pos, range.end);
    if (!raw.startsWith('/**')) continue;
    const line = raw
      .replace(/^\/\*\*+/, '')
      .replace(/\*+\/$/, '')
      .split('\n')
      .map((entry) => entry.replace(/^\s*\*?\s?/, '').trim())
      .find((entry) => entry !== '' && !entry.startsWith('@'));
    if (line) return oneLine(line, 160);
  }
  return undefined;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Literals inside a declaration: route paths, labels, keys — the words a human would search for. */
function stringsIn(node: ts.Node): string[] | undefined {
  const found = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (found.size >= MAX_STRINGS_PER_SYMBOL) return;
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
      if (isUsefulString(child.text)) found.add(child.text);
    } else if (ts.isJsxText(child)) {
      // Visible UI labels live in JsxText, not in string literals, and they are
      // exactly the words someone would search a feature by.
      const label = child.text.replace(/\s+/g, ' ').trim();
      if (isUsefulString(label)) found.add(label);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found.size ? [...found] : undefined;
}

/**
 * Picks the most specific kind. A Next.js `GET` is a route before it is a
 * function; `useAuth` is a hook; `LoginForm` returning JSX is a component.
 */
function callableKind(name: string, node: ts.Node, path: string, fallback: SymbolKind): SymbolKind {
  if (ROUTE_FILE.test(path) && HTTP_METHODS.has(name)) return 'route';
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name) && containsJsx(node)) return 'component';
  return fallback;
}

export function parseTypeScript(path: string, text: string): ParseResult {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const symbols: CodeSymbol[] = [];
  const importSpecifiers: string[] = [];
  /** Names re-exported through `export { a, b }`, applied in a second pass. */
  const exportedLater = new Set<string>();

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const push = (
    name: string,
    kind: SymbolKind,
    node: ts.Node,
    options: { exported?: boolean; parent?: string; signature?: string; signatureFrom?: number } = {},
  ): void => {
    const doc = docOf(node, sf);
    const strings = stringsIn(node);
    symbols.push({
      name,
      kind,
      startLine: lineOf(node.getStart(sf)),
      endLine: lineOf(node.end),
      exported: options.exported ?? isExported(node),
      signature: options.signature ?? declarationHead(node, sf, options.signatureFrom),
      ...(doc ? { doc } : {}),
      ...(options.parent ? { parent: options.parent } : {}),
      ...(strings ? { strings } : {}),
    });
  };

  for (const statement of sf.statements) {
    // --- imports -------------------------------------------------------
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      importSpecifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        importSpecifiers.push(statement.moduleSpecifier.text);
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exportedLater.add((element.propertyName ?? element.name).text);
        }
      }
      continue;
    }

    // --- declarations --------------------------------------------------
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      push(name, callableKind(name, statement, path, 'function'), statement);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      push(className, 'class', statement);
      for (const member of statement.members) {
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const isCallable =
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member) ||
          (ts.isPropertyDeclaration(member) &&
            member.initializer !== undefined &&
            (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)));
        if (!isCallable) continue;
        push(member.name.text, 'method', member, { exported: isExported(statement), parent: className });
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      push(statement.name.text, 'interface', statement);
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      push(statement.name.text, 'type', statement);
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      push(statement.name.text, 'enum', statement);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const statementStart = statement.getStart(sf);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        const callable =
          initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));

        if (callable) {
          push(name, callableKind(name, initializer, path, 'function'), statement, {
            signature: oneLine(sf.text.slice(statementStart, initializer.body.pos)),
          });
          continue;
        }
        // A plain local const is noise; an exported one is part of the API.
        if (isExported(statement)) {
          push(name, 'const', statement, { signatureFrom: statementStart });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const expression = statement.expression;
      const name = ts.isIdentifier(expression) ? expression.text : 'default';
      push(name, callableKind(name, expression, path, 'function'), statement, { exported: true });
      continue;
    }
  }

  if (exportedLater.size) {
    for (const symbol of symbols) {
      if (exportedLater.has(symbol.name)) symbol.exported = true;
    }
  }

  return { symbols, importSpecifiers };
}
