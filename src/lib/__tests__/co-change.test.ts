/**
 * Co-change rules: "a PR that touches X must also touch Y". The question has one right answer
 * (a file list against a glob list), so it is computed, never judged. Every case below is half
 * of a pair: the violated case beside the satisfied one, the touched beside the untouched.
 */
import { describe, expect, it } from 'vitest';
import { type CoChangeRule, evaluateCoChange, parseCoChangeRule, pathMatches, type StoredCoChangeRule } from '../co-change.js';

const stored = (rule: Partial<CoChangeRule> = {}, id = 'd1'): StoredCoChangeRule => ({
  ruleId: `r-${id}`,
  repo: null,
  decisionId: id,
  title: 'Every notable API change adds a changelog entry',
  summary: 'README: add an entry to docs/changelog.md in the same PR',
  rule: { when_paths: ['openapi/**'], require_paths: ['docs/changelog.md'], scope: 'same_pr', ...rule },
});

describe('pathMatches: glob edge cases', () => {
  it('openapi/** matches every depth under openapi/', () => {
    expect(pathMatches('openapi/**', 'openapi/2023-12.yaml')).toBe(true);
    expect(pathMatches('openapi/**', 'openapi/v2/schemas/order.yaml')).toBe(true);
  });
  it('openapi/** does not match a sibling that merely starts with the same letters, or a nested openapi/', () => {
    expect(pathMatches('openapi/**', 'openapi-extra/x.yaml')).toBe(false);
    expect(pathMatches('openapi/**', 'docs/openapi/x.yaml')).toBe(false);
    expect(pathMatches('openapi/**', 'openapi')).toBe(false);
  });
  it('a literal path matches only itself', () => {
    expect(pathMatches('openapi/2023-12.yaml', 'openapi/2023-12.yaml')).toBe(true);
    expect(pathMatches('openapi/2023-12.yaml', 'openapi/2024-01.yaml')).toBe(false);
    expect(pathMatches('openapi/2023-12.yaml', 'openapi/2023-12.yaml.bak')).toBe(false);
  });
  it('regex metacharacters in a path are literal', () => {
    expect(pathMatches('docs/a+b.md', 'docs/a+b.md')).toBe(true);
    expect(pathMatches('docs/a.md', 'docs/aXmd')).toBe(false);
    expect(pathMatches('docs/(x).md', 'docs/(x).md')).toBe(true);
  });
  it('* stays inside one path segment, ** crosses them', () => {
    expect(pathMatches('docs/*.md', 'docs/changelog.md')).toBe(true);
    expect(pathMatches('docs/*.md', 'docs/guides/a.md')).toBe(false);
    expect(pathMatches('docs/**/*.md', 'docs/guides/a.md')).toBe(true);
    expect(pathMatches('docs/**/*.md', 'docs/a.md')).toBe(true);
  });
  it('**/name matches the name at the root and anywhere below', () => {
    expect(pathMatches('**/changelog.md', 'changelog.md')).toBe(true);
    expect(pathMatches('**/changelog.md', 'a/b/changelog.md')).toBe(true);
    expect(pathMatches('**/changelog.md', 'a/b/changelog.mdx')).toBe(false);
  });
  it('? is one non-slash character', () => {
    expect(pathMatches('v?/a.md', 'v1/a.md')).toBe(true);
    expect(pathMatches('v?/a.md', 'v10/a.md')).toBe(false);
    expect(pathMatches('a?b', 'a/b')).toBe(false);
  });
  it('a leading ./ on either side is ignored, and a trailing / means everything under it', () => {
    expect(pathMatches('./openapi/**', 'openapi/x.yaml')).toBe(true);
    expect(pathMatches('openapi/**', './openapi/x.yaml')).toBe(true);
    expect(pathMatches('openapi/', 'openapi/x.yaml')).toBe(true);
  });
  it('matching is case sensitive, like git paths', () => {
    expect(pathMatches('docs/Changelog.md', 'docs/changelog.md')).toBe(false);
  });
});

describe('pathMatches is linear: a hostile glob cannot hang a check', () => {
  const time = (fn: () => unknown): number => { const t = performance.now(); fn(); return performance.now() - t; };
  it("'**a' x8 + '**b' against 60 a's (backtracks for ~79s as a regex) finishes in under 50ms, and does not match", () => {
    const glob = `${'**a'.repeat(8)}**b`;
    const path = 'a'.repeat(60);
    let result = true;
    expect(time(() => { result = pathMatches(glob, path); })).toBeLessThan(50);
    expect(result).toBe(false);
  });
  it('the same shape with a match available still finishes fast and matches (control: the matcher can say yes)', () => {
    const glob = `${'**a'.repeat(8)}**b`;
    let result = false;
    expect(time(() => { result = pathMatches(glob, `${'a'.repeat(60)}b`); })).toBeLessThan(50);
    expect(result).toBe(true);
  });
  it('mixed * and ** pile-ups are fast too', () => {
    const glob = `${'*a'.repeat(12)}*/**/*b`;
    let result = true;
    expect(time(() => { result = pathMatches(glob, 'a'.repeat(80)); })).toBeLessThan(50);
    expect(result).toBe(false);
  });
});

describe('evaluateCoChange', () => {
  it('flags a PR that touches a when path and none of the require paths, naming both sides', () => {
    const v = evaluateCoChange([stored()], ['openapi/2023-12.yaml', 'README.md']);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ decisionId: 'd1', triggeredBy: ['openapi/2023-12.yaml'], missing: ['docs/changelog.md'] });
  });
  it('flags nothing when a require path is in the same change', () => {
    expect(evaluateCoChange([stored()], ['openapi/2023-12.yaml', 'docs/changelog.md'])).toEqual([]);
  });
  it('flags nothing when the change touches no when path', () => {
    expect(evaluateCoChange([stored()], ['src/index.ts', 'README.md'])).toEqual([]);
  });
  it('flags nothing for an empty change', () => {
    expect(evaluateCoChange([stored()], [])).toEqual([]);
  });
  it('any one of several when globs triggers, and only the files that matched are listed', () => {
    const rule = stored({ when_paths: ['openapi/**', 'schemas/*.json'] });
    const v = evaluateCoChange([rule], ['schemas/order.json', 'src/a.ts', 'openapi/x.yaml']);
    expect(v[0]?.triggeredBy.sort()).toEqual(['openapi/x.yaml', 'schemas/order.json']);
    expect(evaluateCoChange([rule], ['schemas/order.json'])).toHaveLength(1);
    expect(evaluateCoChange([rule], ['src/a.ts'])).toEqual([]);
  });
  it('any one of several require paths satisfies the rule, and all are listed as missing otherwise', () => {
    const rule = stored({ require_paths: ['docs/changelog.md', 'CHANGELOG.md'] });
    expect(evaluateCoChange([rule], ['openapi/x.yaml', 'CHANGELOG.md'])).toEqual([]);
    expect(evaluateCoChange([rule], ['openapi/x.yaml'])[0]?.missing).toEqual(['docs/changelog.md', 'CHANGELOG.md']);
  });
  it('a require glob satisfies the rule too (docs/** vs docs/changelog.md is not the same as the glob matching nothing)', () => {
    expect(evaluateCoChange([stored({ require_paths: ['docs/**'] })], ['openapi/x.yaml', 'docs/guide.md'])).toEqual([]);
  });
  it('a file that matches both lists satisfies its own rule (the changelog does not flag itself)', () => {
    const rule = stored({ when_paths: ['docs/**'], require_paths: ['docs/changelog.md'] });
    expect(evaluateCoChange([rule], ['docs/changelog.md'])).toEqual([]);
    expect(evaluateCoChange([rule], ['docs/guide.md'])).toHaveLength(1);
  });
  it('reports each violated rule against its own decision and skips the satisfied ones', () => {
    const a = stored({}, 'a');
    const b = stored({ when_paths: ['src/**'], require_paths: ['tests/**'] }, 'b');
    const c = stored({ when_paths: ['infra/**'], require_paths: ['RUNBOOK.md'] }, 'c');
    const v = evaluateCoChange([a, b, c], ['openapi/x.yaml', 'src/x.ts', 'tests/x.test.ts']);
    expect(v.map((x) => x.decisionId)).toEqual(['a']);
  });
  it('carries the decision title, summary and url through', () => {
    const v = evaluateCoChange([{ ...stored(), url: 'https://example.test/d1' }], ['openapi/x.yaml']);
    expect(v[0]).toMatchObject({ title: 'Every notable API change adds a changelog entry', url: 'https://example.test/d1' });
  });
});

describe('parseCoChangeRule', () => {
  it.each([['{'], ['}'], ['['], [']'], ['!'], ['\\']])('rejects unsupported glob syntax %s in when_paths, naming it', (ch) => {
    expect(() => parseCoChangeRule({ when_paths: [`src/a${ch}b/**`], require_paths: ['docs/changelog.md'], scope: 'same_pr' })).toThrow(/when_paths.*not supported/);
  });
  it.each([['{'], ['}'], ['['], [']'], ['!'], ['\\']])('rejects unsupported glob syntax %s in require_paths, naming it', (ch) => {
    expect(() => parseCoChangeRule({ when_paths: ['src/**'], require_paths: [`docs/a${ch}b.md`], scope: 'same_pr' })).toThrow(/require_paths.*not supported/);
  });
  it('still accepts every supported form: *, **, ?, dots, dashes, a trailing slash', () => {
    expect(() => parseCoChangeRule({ when_paths: ['src/**/*.ts', 'v?/a-b_c.d/', './x'], require_paths: ['docs/*.md'], scope: 'same_pr' })).not.toThrow();
  });
  it('accepts the shared shape', () => {
    expect(parseCoChangeRule({ when_paths: ['a/**'], require_paths: ['b.md'], scope: 'same_pr' })).toEqual({ when_paths: ['a/**'], require_paths: ['b.md'], scope: 'same_pr' });
  });
  it.each([
    ['empty require_paths (it could never be satisfied)', { when_paths: ['a'], require_paths: [], scope: 'same_pr' }],
    ['empty when_paths (it could never trigger)', { when_paths: [], require_paths: ['a'], scope: 'same_pr' }],
    ['an unknown scope', { when_paths: ['a'], require_paths: ['b'], scope: 'same_release' }],
    ['a missing scope', { when_paths: ['a'], require_paths: ['b'] }],
    ['a non-string path', { when_paths: ['a', 3], require_paths: ['b'], scope: 'same_pr' }],
    ['a blank path', { when_paths: ['  '], require_paths: ['b'], scope: 'same_pr' }],
    ['not an object', 'openapi/**'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCoChangeRule(raw)).toThrow();
  });
});
