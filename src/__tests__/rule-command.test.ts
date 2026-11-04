/**
 * `align rule add` / `align rule list`: writing a co-change rule by hand, into the local graph.
 *
 * Why a command and not a flag on `capture` or `mark`: `capture` takes a URL to read a decision
 * out of, and `mark` records a judgement ON a decision that already exists. A rule is neither -
 * it makes a decision and attaches a machine-checkable rule to it - so it gets its own small verb.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RuleCommandDeps, runRuleAdd, runRuleList } from '../commands/rule.js';
import { listCoChangeRules } from '../lib/co-change-store.js';

let dir: string;
let dbPath: string;
let out: string[];
let err: string[];
const deps = (graph: string | undefined = undefined): RuleCommandDeps => ({
  out: (l) => out.push(l), err: (l) => err.push(l), graphPath: () => graph ?? dbPath,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-rule-cmd-'));
  dbPath = path.join(dir, 'local.db');
  out = []; err = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('align rule add', () => {
  it('stores the rule in the shared shape and says what it will flag', async () => {
    const code = await runRuleAdd('Every notable API change adds a changelog entry', { when: ['openapi/**'], require: ['docs/changelog.md'] }, deps());
    expect(code).toBe(0);
    const [stored] = listCoChangeRules(dbPath);
    expect(stored?.rule).toEqual({ when_paths: ['openapi/**'], require_paths: ['docs/changelog.md'], scope: 'same_pr' });
    expect(stored?.title).toBe('Every notable API change adds a changelog entry');
    expect(out.join('\n')).toMatch(/openapi\/\*\*/);
    expect(out.join('\n')).toMatch(/docs\/changelog\.md/);
  });

  it('takes several globs on each side', async () => {
    await runRuleAdd('T', { when: ['a/**', 'b/*.json'], require: ['x.md', 'y.md'] }, deps());
    expect(listCoChangeRules(dbPath)[0]?.rule).toMatchObject({ when_paths: ['a/**', 'b/*.json'], require_paths: ['x.md', 'y.md'] });
  });

  it('adding the same rule again says it already exists and stores nothing new', async () => {
    await runRuleAdd('T', { when: ['a/**'], require: ['x.md'] }, deps());
    out = [];
    expect(await runRuleAdd('T', { when: ['a/**'], require: ['x.md'] }, deps())).toBe(0);
    expect(out.join('\n')).toMatch(/already/i);
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
  });

  it.each([
    ['no title', undefined, { when: ['a'], require: ['b'] }, /title/i],
    ['no --when', 'T', { require: ['b'] }, /--when/],
    ['no --require', 'T', { when: ['a'] }, /--require/],
    ['an empty --require list', 'T', { when: ['a'], require: [] }, /--require/],
  ])('is a usage error (exit 2) with %s, and stores nothing', async (_l, title, opts, msg) => {
    expect(await runRuleAdd(title, opts, deps())).toBe(2);
    expect(err.join('\n')).toMatch(msg);
    expect(listCoChangeRules(dbPath)).toEqual([]);
  });

  it('refuses when local mode is not set up, naming the command that sets it up', async () => {
    const d: RuleCommandDeps = { out: (l) => out.push(l), err: (l) => err.push(l), graphPath: () => undefined };
    expect(await runRuleAdd('T', { when: ['a'], require: ['b'] }, d)).toBe(1);
    expect(err.join('\n')).toMatch(/align setup --local|align local start/);
  });
});

describe('align rule list', () => {
  it('prints each rule with its decision title', async () => {
    await runRuleAdd('Changelog rule', { when: ['openapi/**'], require: ['docs/changelog.md'] }, deps());
    out = [];
    expect(await runRuleList(deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Changelog rule');
    expect(text).toContain('openapi/**');
    expect(text).toContain('docs/changelog.md');
  });

  it('says so when there are none', async () => {
    expect(await runRuleList(deps())).toBe(0);
    expect(out.join('\n')).toMatch(/no co-change rules/i);
  });
});
