/**
 * What goes in a LOCAL graph's decisions file. Measured on objectionary/eo (18 Nov 2026): the git importer kept 1,817
 * commits that state a reason, 1,317 of them shaped like fixes ("#7357: make Dep.equals() symmetric"), and the file was
 * their newest 200 titles. A user called it garbage, and it was.
 *
 * Test List:
 * 1. the repo's written rules (docs) come first and are always kept
 * 2. a fix-shaped commit is left out, however it states its reason (two shapes: "fix(...)" and "#1234:")
 * 3. a commit that reads as a decision is kept (two verbs: "Replace ... with", "instead of"), with its stated reason
 * 4. a commit that is neither is left out
 * 5. the list is capped, and the count left out is reported
 */
import { describe, expect, it } from 'vitest';
import { selectForFile } from '../lib/context-from-graph.js';
import { renderDecisionsFile } from '../lib/decisions-context.js';

const row = (title: string, platform = 'git', summary = '') => ({ title, platform, summary, source_url: `https://github.com/o/r/commit/${title.length}` });

describe('selectForFile', () => {
  it('keeps the repo\'s written rules first', () => {
    const { decisions } = selectForFile([row('Replace eo-inference with the per-copy engine'), row('Tests for EO objects', 'docs', 'Keep the test of an EO object inside it.')], 30);
    expect(decisions.map((d) => d.title)).toEqual(['Tests for EO objects', 'Replace eo-inference with the per-copy engine']);
  });

  it('leaves out fix-shaped commits, whatever reason they state', () => {
    const { decisions, leftOut } = selectForFile([
      row('fix(#7286): drop the self-fibo snippet that relied on %', 'git', 'Because the token was removed.'),
      row('#7357: make Dep.equals() symmetric', 'git', 'Because equals must be symmetric.'),
    ], 30);
    expect(decisions).toEqual([]);
    expect(leftOut).toBe(2);
  });

  it('keeps a commit that reads as a decision, with its stated reason', () => {
    const { decisions } = selectForFile([
      row('Replace the failure object with the I glyph', 'git', 'Replace the failure object with the I glyph\n\nWe do this because one glyph reads better in listings than a named object.'),
      row('Encode TRUE as FF- instead of 01-'),
    ], 30);
    expect(decisions.map((d) => d.title)).toEqual(['Replace the failure object with the I glyph', 'Encode TRUE as FF- instead of 01-']);
    expect(decisions[0]!.reason).toMatch(/because one glyph reads better/);
  });

  it('leaves out a commit that is neither a rule nor a decision', () => {
    const { decisions, leftOut } = selectForFile([row('Look records up by meta through keys in rendering.xsl')], 30);
    expect(decisions).toEqual([]);
    expect(leftOut).toBe(1);
  });

  it('caps the list and counts what it left out', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`Use library ${i} instead of library ${i + 1}`));
    const { decisions, leftOut } = selectForFile(rows, 3);
    expect(decisions).toHaveLength(3);
    expect(leftOut).toBe(2);
  });

  it('a feat: prefix does not hide a fix: "feat: fix retry policy" is left out, "feat: use Postgres instead of MySQL" is kept', () => {
    const { decisions } = selectForFile([row('feat: fix retry policy instead of failing'), row('feat: use Postgres instead of MySQL')], 30);
    expect(decisions.map((d) => d.title)).toEqual(['use Postgres instead of MySQL']);
  });
});

describe('selectForFile - one docs row per rule', () => {
  const RULE = 'Never force-push to main or run `git reset --hard` without asking first, because other agents build on that branch';
  const cut = RULE.slice(0, 80); // the graph keeps 80 characters of a title

  it('prints the whole rule, recovered from the summary, when the stored title was cut', () => {
    const { decisions } = selectForFile(
      [{ title: cut, platform: 'docs', summary: `${RULE}.\n\nFrom the "Core principles" section.`, source_url: 'https://github.com/o/r/blob/main/AGENTS.md#core-principles--never-force-push' }],
      50,
    );
    expect(decisions[0]!.title).toBe(`${RULE}.`);
    expect(renderDecisionsFile(decisions)).toContain(`${RULE}.`);
  });

  it('leaves a short docs title alone', () => {
    const { decisions } = selectForFile([{ title: 'Testing', platform: 'docs', summary: 'Testing\n\nRun the tests.', source_url: 'https://github.com/o/r/blob/main/AGENTS.md#testing' }], 50);
    expect(decisions[0]!.title).toBe('Testing');
  });
});

describe('selectForFile - rule rows and the file cap', () => {
  const U = 'https://github.com/o/r/blob/main/AGENTS.md';
  const ruleRow = (i: number, title = `Never touch file number ${i}.`) => ({
    title, platform: 'docs', summary: `${title}\n\nFrom the "Core principles" section.`, source_url: `${U}#core-principles~rule-${i}`,
  });

  it('keeps a commit row when 35 rule rows would fill the cap', () => {
    const rows = [...Array.from({ length: 35 }, (_, i) => ruleRow(i)), { title: 'Use Postgres instead of Mongo', platform: 'github', summary: 'because of joins', source_url: 'https://github.com/o/r/pull/1' }];
    const { decisions } = selectForFile(rows, 30);
    expect(decisions.filter((d) => d.kind === 'rule')).toHaveLength(29);
    expect(decisions.some((d) => d.title === 'Use Postgres instead of Mongo')).toBe(true);
  });

  it('hides an old whole-section row that sits beside its own rule rows', () => {
    const old = { title: 'Core principles', platform: 'docs', summary: 'Core principles\n\n- Never a.\n- Never b.', source_url: `${U}#core-principles` };
    const { decisions } = selectForFile([old, ruleRow(1), ruleRow(2)], 30);
    expect(decisions.map((d) => d.title)).not.toContain('Core principles');
    expect(decisions).toHaveLength(2);
  });

  it('keeps a whole-section row whose section has no rule rows', () => {
    const lone = { title: 'Testing', platform: 'docs', summary: 'Testing\n\nRun the tests.', source_url: `${U}#testing` };
    expect(selectForFile([lone, ruleRow(1)], 30).decisions.map((d) => d.title)).toContain('Testing');
  });

  it('shows the first 300 characters of a long rule, ending in ..., with no ** markers', () => {
    const long = `**Never** ${'x'.repeat(327)}`; // 337 characters as written
    expect(long).toHaveLength(337);
    const { decisions } = selectForFile([ruleRow(1, long.slice(0, 80))].map((r) => ({ ...r, summary: `${long}\n\nFrom the "Core principles" section.` })), 30);
    const t = decisions[0]!.title;
    expect(t.endsWith('...')).toBe(true);
    expect(t).not.toContain('**');
    expect(t).toHaveLength(303);
  });

  it('leaves a long ordinary docs heading and a long ADR title alone', () => {
    const heading = 'A very long section heading that runs well past the eighty characters the graph keeps of a title';
    const row = { title: heading.slice(0, 80), platform: 'docs', summary: `${heading}\n\nBody text.`, source_url: `${U}#long` };
    expect(selectForFile([row], 30).decisions[0]!.title).toBe(heading.slice(0, 80));
  });

  it('keeps the stored rule title in `selected`, so the committed-file check still finds it', () => {
    const long = `**Never** ${'x'.repeat(327)}`;
    const row = { ...ruleRow(1, long.slice(0, 80)), summary: `${long}\n\nFrom the "Core principles" section.` };
    expect(selectForFile([row], 30).selected[0]!.title).toBe(long.slice(0, 80));
  });

  const commit = (n: number) => ({ title: `Use queue number ${n} instead of polling`, platform: 'github', summary: 'because of load', source_url: `https://github.com/o/r/pull/${n}` });

  it('gives unused non-rule slots to rules: 9 rules, no commits, limit 9 shows 9', () => {
    expect(selectForFile(Array.from({ length: 9 }, (_, i) => ruleRow(i)), 9).decisions).toHaveLength(9);
  });

  it('limit 4 with 6 rules and 1 commit shows 3 rules and the commit', () => {
    const { decisions } = selectForFile([...Array.from({ length: 6 }, (_, i) => ruleRow(i)), commit(1)], 4);
    expect(decisions.filter((d) => d.kind === 'rule')).toHaveLength(3);
    expect(decisions.filter((d) => d.kind !== 'rule')).toHaveLength(1);
  });

  it('limit 1 with only rule rows shows 1', () => {
    expect(selectForFile([ruleRow(1), ruleRow(2)], 1).decisions).toHaveLength(1);
  });

  it('a prose section stays visible beside the rule rows of a section whose heading starts with its name', () => {
    const prose = { title: 'Core', platform: 'docs', summary: 'Core\n\nSome prose about the core.', source_url: `${U}#core` };
    const rule = { title: 'Never a.', platform: 'docs', summary: 'Never a.\n\nFrom the "Core - x" section.', source_url: `${U}#core---x~never-a-1234abcd` };
    expect(selectForFile([prose, rule], 30).decisions.map((d) => d.title)).toContain('Core');
  });

  it('still hides the genuine whole-section row of the section that was split', () => {
    const old = { title: 'Core - x', platform: 'docs', summary: 'Core - x\n\n- Never a.', source_url: `${U}#core---x` };
    const rule = { title: 'Never a.', platform: 'docs', summary: 'Never a.\n\nFrom the "Core - x" section.', source_url: `${U}#core---x~never-a-1234abcd` };
    expect(selectForFile([old, rule], 30).decisions.map((d) => d.title)).toEqual(['Never a.']);
  });

  it('still holds rules to two thirds of the cap when there are plenty of commits', () => {
    const rows = [...Array.from({ length: 40 }, (_, i) => ruleRow(i)), ...Array.from({ length: 40 }, (_, i) => commit(i + 1))];
    const { decisions } = selectForFile(rows, 30);
    expect(decisions.filter((d) => d.kind === 'rule')).toHaveLength(20);
    expect(decisions).toHaveLength(30);
  });

  const overflowRow = () => ({
    title: 'Further rules from the Core principles section', platform: 'docs',
    summary: 'Further rules from the Core principles section\n\n- Never x.\n\nFrom the "Core principles" section. (further rules, graph only)',
    source_url: `${U}#core-principles~further-rules`,
  });

  it('keeps the overflow row out of the file, out of `selected`, and out of the left-out count', () => {
    const r = selectForFile([ruleRow(1), ruleRow(2), overflowRow()], 30);
    expect(r.decisions.map((d) => d.title)).toEqual(['Never touch file number 1.', 'Never touch file number 2.']);
    expect(r.selected.map((x) => x.title)).not.toContain('Further rules from the Core principles section');
    expect(r.leftOut).toBe(0);
  });
});
