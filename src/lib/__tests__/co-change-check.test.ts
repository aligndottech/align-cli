/**
 * The seams around the matcher: the changed-file list (real git, a temp repo) and how a violation
 * is folded into whatever the LLM judge said, including when it said nothing.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlignmentResult } from '../gateway-client.js';
import type { CoChangeViolation } from '../co-change.js';
import { changedFiles, mergeCoChange } from '../co-change-check.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cochange-git-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', 'x\n');
  write('docs/changelog.md', 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('changedFiles', () => {
  it('base: lists what the branch changed since the merge base, not what main did meanwhile', () => {
    git('checkout', '-q', '-b', 'feature');
    write('openapi/a.yaml', 'a\n');
    git('add', '.'); git('commit', '-q', '-m', 'feat');
    git('checkout', '-q', 'main');
    write('other.txt', 'o\n');
    git('add', '.'); git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'feature');
    return changedFiles({ kind: 'base', ref: 'main' }, repo).then((files) => expect(files).toEqual(['openapi/a.yaml']));
  });

  it('base: a rename counts as the old path and the new one, and a deletion counts', async () => {
    git('checkout', '-q', '-b', 'feature');
    git('mv', 'docs/changelog.md', 'docs/CHANGES.md');
    git('rm', '-q', 'README.md');
    git('commit', '-q', '-m', 'move');
    expect((await changedFiles({ kind: 'base', ref: 'main' }, repo)).sort()).toEqual(['README.md', 'docs/CHANGES.md', 'docs/changelog.md']);
  });

  it('base: paths with spaces and non-ASCII characters come back verbatim, not quoted', async () => {
    git('checkout', '-q', '-b', 'feature');
    write('docs/my file.md', 'x\n');
    write('docs/café.md', 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'odd names');
    expect((await changedFiles({ kind: 'base', ref: 'main' }, repo)).sort()).toEqual(['docs/café.md', 'docs/my file.md']);
  });

  it('staged: only what is staged', async () => {
    write('a.txt', 'a\n'); git('add', 'a.txt');
    write('b.txt', 'b\n');
    expect(await changedFiles({ kind: 'staged' }, repo)).toEqual(['a.txt']);
  });

  it('head: staged and unstaged edits to tracked files, against HEAD', async () => {
    write('README.md', 'changed\n');
    write('docs/changelog.md', 'changed\n'); git('add', 'docs/changelog.md');
    expect((await changedFiles({ kind: 'head' }, repo)).sort()).toEqual(['README.md', 'docs/changelog.md']);
  });

  it('an unresolvable base throws rather than listing nothing', async () => {
    await expect(changedFiles({ kind: 'base', ref: 'no-such-ref' }, repo)).rejects.toThrow();
  });
});

const VIOLATION: CoChangeViolation = {
  decisionId: 'd-rule', title: 'Every API change adds a changelog entry', summary: 'README rule',
  triggeredBy: ['openapi/2023-12.yaml'], missing: ['docs/changelog.md'],
};
const ALIGNED: AlignmentResult = { status: 'aligned', confidence: 0.9, relevant_decisions: [{ id: 'x', title: 'X', summary: 's', similarity: 0.8 }], conflicts: [], message: 'Found 1' };

describe('mergeCoChange', () => {
  it('turns a violation into a critical conflict citing the decision, the triggering files and the missing one', () => {
    const r = mergeCoChange(ALIGNED, null, [VIOLATION]);
    expect(r.status).toBe('conflicting');
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts![0]!;
    expect(c).toMatchObject({ decision_id: 'd-rule', title: VIOLATION.title, severity: 'critical' });
    expect(c.reason).toContain('openapi/2023-12.yaml');
    expect(c.reason).toContain('docs/changelog.md');
    expect(r.message).toMatch(/file rule/i);
  });

  it('lists at most a few triggering files and says how many more', () => {
    const many = { ...VIOLATION, triggeredBy: Array.from({ length: 9 }, (_, i) => `openapi/f${i}.yaml`) };
    const reason = mergeCoChange(ALIGNED, null, [many]).conflicts![0]!.reason;
    expect(reason).toContain('openapi/f0.yaml');
    expect(reason).not.toContain('openapi/f8.yaml');
    expect(reason).toMatch(/and 6 more/);
  });

  it('still conflicts when the judge threw, and says the judge did not run', () => {
    const r = mergeCoChange(null, new Error('provider down'), [VIOLATION]);
    expect(r.status).toBe('conflicting');
    expect(r.conflicts!.map((c) => c.decision_id)).toEqual(['d-rule']);
    expect((r.notes ?? []).join('\n')).toMatch(/provider down/);
  });

  it('a conflict beats an unknown judge: unknown does not hide the violation', () => {
    const unknown: AlignmentResult = { status: 'unknown', reason: 'classifier_unparseable', confidence: 0, relevant_decisions: [], conflicts: [], message: 'Could not check' };
    const r = mergeCoChange(unknown, null, [VIOLATION]);
    expect(r.status).toBe('conflicting');
    expect(r.conflicts).toHaveLength(1);
  });

  it('keeps the judge\'s own conflicts beside the rule conflicts, without duplicating one decision', () => {
    const judged: AlignmentResult = {
      ...ALIGNED, status: 'conflicting', check_event_id: 'ev-1',
      conflicts: [{ decision_id: 'other', title: 'Other', reason: 'judge says so', severity: 'warning' }, { decision_id: 'd-rule', title: VIOLATION.title, reason: 'judge also says so', severity: 'warning' }],
    };
    const r = mergeCoChange(judged, null, [VIOLATION]);
    expect(r.conflicts!.map((c) => c.decision_id).sort()).toEqual(['d-rule', 'other']);
    expect(r.conflicts!.find((c) => c.decision_id === 'd-rule')!.severity).toBe('critical');
    expect(r.check_event_id).toBe('ev-1');
  });

  it('drops the judge\'s unknown-reason fields, which describe a verdict that is no longer the result', () => {
    const unknown: AlignmentResult = { status: 'unknown', reason: 'no_llm_key', reason_class: 'unavailable', confidence: 0, relevant_decisions: [], conflicts: [], message: 'Could not check' };
    const r = mergeCoChange(unknown, null, [VIOLATION]);
    expect(r).not.toHaveProperty('reason');
    expect(r).not.toHaveProperty('reason_class');
  });

  it('lists the rule\'s decision among the relevant decisions, so a later `align mark check` knows the check covered it', () => {
    const r = mergeCoChange(ALIGNED, null, [VIOLATION]);
    expect(r.relevant_decisions.map((d) => d.id).sort()).toEqual(['d-rule', 'x']);
    expect(mergeCoChange(null, new Error('x'), [VIOLATION]).relevant_decisions.map((d) => d.id)).toEqual(['d-rule']);
  });

  it('keeps the judge\'s related decisions and notes', () => {
    const r = mergeCoChange({ ...ALIGNED, notes: ['a mark applied'] }, null, [VIOLATION]);
    expect(r.relevant_decisions.map((d) => d.id)).toContain('x');
    expect(r.notes).toContain('a mark applied');
  });
});
