import { describe, expect, it } from 'vitest';
import { intentLine, maxScorePerDecision } from '../lib/edit-intent-line.js';

/*
 * Test list (Given / When / Then, two examples per rule)
 *
 * Tokens come only from the edit and its path
 *  1. Given an import of a package no one has heard of, when the line is built, then its words pass through verbatim.
 *  2. Given two different URL hosts, when each line is built, then each carries its own host words and nothing of the other.
 *  3. Given the same text under two paths, when built, then the path words differ and nothing else is invented.
 * Splitting
 *  4. Given camelCase and PascalCase identifiers, then they split into lowercase words.
 *  5. Given snake_case, kebab-case and digits, then they split and bare digits and 1-2 letter pieces drop.
 *  6. Given a use/import/require/from target, then its path segments become words.
 * Stop list
 *  7. Given keywords from Rust, TypeScript and Python, then none appears.
 *  8. Given the extension, scheme and www noise (rs, ts, com, https, www), then none appears.
 * Order and cap
 *  9. Given a path and a body, then path words come first and a repeated word keeps its first position.
 * 10. Given 100 distinct words, then exactly 40 tokens come back, the first 40 in order.
 * 11. Given 41 and 39 distinct words, then the cap bites only at 41.
 * Non-source paths produce no line
 * 12. README.md and package-lock.json. 13. app.scss and Cargo.lock. 14. CHANGELOG and LICENSE with no extension.
 * 15. .gitignore and a file under node_modules. 16. A source path with the same text still produces a line.
 * Merging two queries
 * 17. Given a decision seen by one query only, then it keeps that score.
 * 18. Given a decision seen by both, then the larger score wins, whichever query gave it.
 * 19. Given equal scores, then ids break the tie by code unit.
 */

const words = (s: string) => (s ? s.split(' ') : []);

describe('intentLine: tokens come only from the edit and its path', () => {
  it('passes an unknown package name through verbatim', () => {
    const line = intentLine({ filePath: 'src/a.ts', text: "import { frobnicate } from 'zorblax-quuxify';" });
    expect(words(line)).toEqual(expect.arrayContaining(['zorblax', 'quuxify', 'frobnicate']));
  });

  it('passes a second unknown package name through verbatim', () => {
    const line = intentLine({ filePath: 'lib/b.py', text: 'import wibblesnort\nwibblesnort.go()' });
    expect(words(line)).toContain('wibblesnort');
  });

  it('keeps the words of each host and none of the other', () => {
    const a = words(intentLine({ filePath: 'x/call.ts', text: 'fetch("https://api.openai.com/v1/chat")' }));
    const b = words(intentLine({ filePath: 'x/call.ts', text: 'fetch("https://hooks.slack.com/services")' }));
    expect(a).toEqual(expect.arrayContaining(['api', 'openai', 'chat']));
    expect(a).not.toContain('slack');
    expect(b).toEqual(expect.arrayContaining(['hooks', 'slack', 'services']));
    expect(b).not.toContain('openai');
  });

  it('adds no word that is in neither the edit nor the path', () => {
    const text = 'const client = new ZorblaxClient();';
    const allowed = new Set(['src', 'billing', 'invoice', 'client', 'zorblax']);
    const out = words(intentLine({ filePath: 'src/billing/invoice.ts', text }));
    expect(out.length).toBeGreaterThan(0);
    for (const w of out) expect(allowed.has(w), w).toBe(true);
  });

  it('takes path words from the directory and the file name', () => {
    const out = words(intentLine({ filePath: 'crates/harness-core/src/llm_client.rs', text: 'let x = 1;' }));
    expect(out).toEqual(['crates', 'harness', 'core', 'src', 'llm', 'client']);
  });
});

describe('intentLine: splitting', () => {
  it('splits camelCase and PascalCase into lowercase words', () => {
    const out = words(intentLine({ filePath: 'a/b.ts', text: 'getUserProfile(); new XMLParserConfig();' }));
    expect(out).toEqual(expect.arrayContaining(['get', 'user', 'profile', 'xml', 'parser', 'config']));
    expect(out).not.toContain('getuserprofile');
  });

  it('splits snake_case, kebab-case and digits, dropping bare digits and short pieces', () => {
    const out = words(intentLine({ filePath: 'a/b.ts', text: 'max_retry_count = 3; "rate-limit-window"; sha256sum(v2)' }));
    expect(out).toEqual(expect.arrayContaining(['max', 'retry', 'count', 'rate', 'limit', 'window', 'sha', 'sum']));
    expect(out).not.toContain('256');
    expect(out).not.toContain('v');
  });

  it('turns import, require, use and from targets into words', () => {
    const out = words(intentLine({
      filePath: 'a/b.ts',
      text: "const x = require('@scope/odd-pkg/sub');\nimport y from 'left-padder';\nuse tokio::runtime::Builder;",
    }));
    expect(out).toEqual(expect.arrayContaining(['scope', 'odd', 'pkg', 'sub', 'left', 'padder', 'tokio', 'runtime']));
  });
});

describe('intentLine: stop list', () => {
  it('drops keywords from Rust, TypeScript and Python', () => {
    const text = 'pub async fn run() {} const x = await y; let z; var w; impl S {} struct T; mod m; class C {} def d(): return export function f() { if (a) {} else {} } new N true false null';
    const out = words(intentLine({ filePath: 'zzz/qqq.ts', text }));
    for (const k of ['const', 'let', 'var', 'fn', 'pub', 'use', 'mod', 'impl', 'struct', 'class', 'def', 'function', 'return', 'import', 'export', 'from', 'async', 'await', 'new', 'if', 'else', 'true', 'false', 'null']) {
      expect(out, k).not.toContain(k);
    }
    expect(out).toEqual(expect.arrayContaining(['zzz', 'qqq']));
  });

  it('drops extension, scheme and www noise and tokens under 3 characters', () => {
    const out = words(intentLine({ filePath: 'a/main.rs', text: 'x("https://www.example.com/ab/xyz.js", py, ts, http)' }));
    for (const k of ['rs', 'ts', 'js', 'py', 'com', 'www', 'http', 'https', 'ab']) expect(out, k).not.toContain(k);
    expect(out).toEqual(expect.arrayContaining(['example', 'xyz']));
  });
});

describe('intentLine: order and cap', () => {
  it('puts path words first and keeps the first occurrence of a repeat', () => {
    const out = words(intentLine({ filePath: 'billing/ledger.ts', text: 'ledger ledger audit billing audit' }));
    expect(out).toEqual(['billing', 'ledger', 'audit']);
  });

  const tokens = (n: number) => Array.from({ length: n }, (_, i) => `tok${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`);

  it('caps at 40 tokens and keeps the first 40 in order', () => {
    const all = tokens(100);
    // the path words are all under 3 characters, so every token comes from the text
    expect(words(intentLine({ filePath: 'a/b.ts', text: all.join(' ') }))).toEqual(all.slice(0, 40));
  });

  it('applies the cap only above 40 distinct tokens', () => {
    expect(words(intentLine({ filePath: 'a/b.ts', text: tokens(39).join(' ') }))).toHaveLength(39);
    expect(words(intentLine({ filePath: 'a/b.ts', text: tokens(41).join(' ') }))).toHaveLength(40);
  });
});

describe('intentLine: non-source paths produce no line', () => {
  const text = 'This tool helps you check changes before they merge, see docs for setup';
  it.each(['README.md', 'docs/guide.mdx', 'notes.txt', 'docs/spec.rst'])('is empty for %s', (p) => {
    expect(intentLine({ filePath: p, text })).toBe('');
  });
  it.each(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'uv.lock', 'poetry.lock', 'go.sum', 'deps.lock'])('is empty for lock file %s', (p) => {
    expect(intentLine({ filePath: `sub/${p}`, text })).toBe('');
  });
  it.each(['src/styles/app.scss', 'a/b.css', 'logo.svg'])('is empty for style or image %s', (p) => {
    expect(intentLine({ filePath: p, text })).toBe('');
  });
  it.each(['CHANGELOG', 'CHANGELOG.md', 'LICENSE', 'LICENSE-MIT', '.gitignore', 'node_modules/left-pad/index.js'])('is empty for %s', (p) => {
    expect(intentLine({ filePath: p, text })).toBe('');
  });
  it('still builds a line for a source path with the same text', () => {
    expect(intentLine({ filePath: 'src/review.ts', text })).not.toBe('');
  });
});

describe('maxScorePerDecision', () => {
  it('keeps the score of a decision only one query saw', () => {
    const out = maxScorePerDecision([{ decisionId: 'a', score: 0.4 }], [{ decisionId: 'b', score: 0.5 }]);
    expect(out).toEqual([{ decisionId: 'b', score: 0.5 }, { decisionId: 'a', score: 0.4 }]);
  });
  it('takes the larger score whichever query gave it', () => {
    expect(maxScorePerDecision([{ decisionId: 'a', score: 0.2 }], [{ decisionId: 'a', score: 0.6 }])).toEqual([{ decisionId: 'a', score: 0.6 }]);
    expect(maxScorePerDecision([{ decisionId: 'a', score: 0.7 }], [{ decisionId: 'a', score: 0.3 }])).toEqual([{ decisionId: 'a', score: 0.7 }]);
  });
  it('breaks ties by id code unit', () => {
    const out = maxScorePerDecision([{ decisionId: 'b', score: 0.5 }], [{ decisionId: 'B', score: 0.5 }]);
    expect(out.map((x) => x.decisionId)).toEqual(['B', 'b']);
  });
});
