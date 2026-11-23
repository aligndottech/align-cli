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
