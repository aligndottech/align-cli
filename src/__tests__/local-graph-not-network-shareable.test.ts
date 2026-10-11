import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

// The local graph must never be reachable over the network. This scans the
// non-test source tree, parsed with the TypeScript compiler API (not grepped),
// for network server transports and for `.listen(` call sites.

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT = join(SRC, '..');

const FORBIDDEN_TRANSPORTS = new Set(['StreamableHTTPServerTransport', 'SSEServerTransport']);

// path -> reason. Add an entry only with a ticket-named reason.
const LISTEN_ALLOWLIST: Record<string, string> = {
  'src/lib/cli-oauth.ts':
    'align login callback: nonce-gated, serves no graph data, but calls s.listen(port, cb) with NO host, so it binds every interface. Binding 127.0.0.1 may break browsers resolving localhost to ::1, so the fix is its own behaviour change. Follow-up: ALI-1504.',
};

function listSrcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...listSrcFiles(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
      // repo-relative with forward slashes on every OS: the allowlist keys are written that way
      out.push(relative(ROOT, p).split(sep).join('/'));
    }
  }
  return out.sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
}

function visit(sf: ts.SourceFile, fn: (n: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    fn(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
}

interface Scan {
  ids: Set<string>;
  listens: boolean;
}

// One parse per file, shared by every test below. Parsing the whole tree used to happen inside
// each test body (up to three times over), which ran past the 5 s test timeout on a loaded CI
// runner. The walk now runs once, in beforeAll, under its own explicit hook timeout.
const scans = new Map<string, Scan>();

function scan(file: string): Scan {
  const cached = scans.get(file);
  if (cached) return cached;
  const ids = new Set<string>();
  let listens = false;
  visit(parse(file), (n) => {
    if (ts.isIdentifier(n)) ids.add(n.text);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'listen') {
      listens = true;
    }
  });
  const result = { ids, listens };
  scans.set(file, result);
  return result;
}

function identifiers(file: string): Set<string> {
  return scan(file).ids;
}

function listenSites(files: string[]): string[] {
  return files.filter((f) => scan(f).listens).sort();
}

describe('local graph is never network-shareable', () => {
  let files: string[] = [];

  beforeAll(() => {
    files = listSrcFiles();
    for (const f of files) scan(f);
  }, 60_000);

  it('scans the real tree and can match a transport (positive controls)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => identifiers(f).has('StdioServerTransport'))).toBe(true);
  });

  it('imports no network server transport', () => {
    const offenders = files.filter((f) => {
      const ids = identifiers(f);
      return [...FORBIDDEN_TRANSPORTS].some((t) => ids.has(t));
    });
    expect(offenders).toEqual([]);
  });

  it('opens a listening socket only in allowlisted files', () => {
    expect(listenSites(files)).toEqual(Object.keys(LISTEN_ALLOWLIST).sort());
  });

  it('listen detection sees a real call and ignores comments (control)', () => {
    expect(listenSites(['src/lib/cli-oauth.ts'])).toEqual(['src/lib/cli-oauth.ts']);
  });
});
