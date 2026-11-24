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
    // #721: a heading is printed with the prose line under it, never alone.
    expect(decisions[0]!.title).toBe('Testing: Run the tests.');
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
    expect(selectForFile([lone, ruleRow(1)], 30).decisions.map((d) => d.title)).toContain('Testing: Run the tests.');
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

  it('lists a long ordinary docs heading whole when its summary holds it (was: left cut at 80, mid-word)', () => {
    const heading = 'A very long section heading that runs well past the eighty characters the graph keeps of a title';
    const row = { title: heading.slice(0, 80), platform: 'docs', summary: `${heading}\n\nBody text goes here.`, source_url: `${U}#long` };
    // The whole heading is recovered from the summary, then the prose line under it (#721).
    expect(selectForFile([row], 30).decisions[0]!.title).toBe(`${heading}: Body text goes here.`);
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
    expect(selectForFile([prose, rule], 30).decisions.map((d) => d.title)).toContain('Core: Some prose about the core.');
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

// #721: `align up` listed bare section headings ("Commands", "Testing") under "Rules written in this repo".
// Test List: 1 a section whose body holds no prose is not listed (two shapes: a code fence, a list of commands);
// 2 a section with a rule line under it is listed as "Heading: the rule line" (two shapes: a bullet, a sentence);
// 3 a heading that states a rule is listed as written (two: "Never ...", "Always ..."); 4 the file never prints a bare heading.
describe('selectForFile - a heading is not a rule (#721)', () => {
  const U = 'https://github.com/o/r/blob/main/CLAUDE.md';
  const section = (title: string, body: string) => ({ title, platform: 'docs', summary: `${title}\n\n${body}`, source_url: `${U}#${title.toLowerCase().replace(/\W+/g, '-')}` });

  it('does not list a section whose body is a code fence', () => {
    const { decisions, leftOut } = selectForFile([section('Commands', '```bash\nnpm test\nnpm run build\n```')], 30);
    expect(decisions).toEqual([]);
    expect(leftOut).toBe(1);
  });

  it('does not list a section whose body is a list of commands', () => {
    const { decisions } = selectForFile([section('Project structure', '- `src/` - the CLI\n- `docs/` - the docs\n\n| a | b |\n|---|---|')], 30);
    expect(decisions).toEqual([]);
  });

  it('lists a section with a rule bullet as "Heading: the rule"', () => {
    const { decisions } = selectForFile([section('Testing', '- Run `npm test` before every push.\n- Keep tests next to the code.')], 30);
    expect(decisions.map((d) => d.title)).toEqual(['Testing: Run `npm test` before every push.']);
  });

  it('lists a section with a rule sentence after a code fence as "Heading: the sentence"', () => {
    const { decisions } = selectForFile([section('Code style', '```ts\nconst x = 1;\n```\n\nPrefer **named exports** over default exports.')], 30);
    expect(decisions.map((d) => d.title)).toEqual(['Code style: Prefer named exports over default exports.']);
  });

  it('keeps a heading that states a rule exactly as written', () => {
    const { decisions } = selectForFile([section('Never commit secrets', '```\n.env\n```'), section('Always run the linter', '`npm run lint`')], 30);
    expect(decisions.map((d) => d.title)).toEqual(['Never commit secrets', 'Always run the linter']);
  });

  it('the rendered file has no bare heading line', () => {
    const { decisions } = selectForFile([section('Commands', '```\nnpm test\n```'), section('Testing', '- Run `npm test` before every push.')], 30);
    const file = renderDecisionsFile(decisions);
    expect(file).not.toMatch(/^- Commands/m);
    expect(file).not.toMatch(/^- Testing( -|$)/m);
    expect(file).toContain('- Testing: Run `npm test` before every push.');
  });
});

// Review of #721. A short rule is still a rule; a comment is not text; only a heading that opens with an imperative is a rule.
describe('selectForFile - heading rows, review fixes (#721)', () => {
  const U = 'https://github.com/o/r/blob/main/CLAUDE.md';
  const section = (title: string, body: string) => ({ title, platform: 'docs', summary: body ? `${title}\n\n${body}` : title, source_url: `${U}#${title.toLowerCase().replace(/\W+/g, '-')}` });
  const titles = (rows: ReturnType<typeof section>[]) => selectForFile(rows, 30).decisions.map((d) => d.title);

  it('keeps a two-word rule, a blockquote rule and a short list item', () => {
    expect(titles([
      section('Git', 'Use rebase.'),
      section('Branches', '> Never rebase **shared** branches.'),
      section('Linting', '- Run eslint'),
    ])).toEqual(['Git: Use rebase.', 'Branches: Never rebase shared branches.', 'Linting: Run eslint']);
  });

  it('still leaves out a section that has only code, a table and a comment', () => {
    expect(titles([section('Commands', '```sh\nnpm test\n```\n\n| a | b |\n|---|---|\n\n<!-- note -->')])).toEqual([]);
  });

  it('skips the inside of a multi-line HTML comment', () => {
    expect(titles([section('Style', '<!--\nTODO fill this in\nlater\n-->\n\nPrefer small PRs.')])).toEqual(['Style: Prefer small PRs.']);
    expect(titles([section('Empty', '<!--\nTODO fill this in\n-->')])).toEqual([]);
  });

  it.each(['Must-haves', 'Always-on mode', 'Where things should live', 'Do not panic: FAQ'])('prints "%s" with its prose line, not as a rule', (h) => {
    expect(titles([section(h, 'Read the docs first.')])).toEqual([`${h}: Read the docs first.`]);
  });

  it('keeps a heading that opens with an imperative as the rule when there is no prose', () => {
    expect(titles([section('Never commit secrets', ''), section('Do not force-push', '```\ngit push\n```')])).toEqual(['Never commit secrets', 'Do not force-push']);
  });

  it('prints the whole imperative heading, not the 80 characters the graph keeps', () => {
    const full = 'Never commit generated files to the repository because reviewers cannot read them and diffs get noisy';
    const row = { ...section(full.slice(0, 80), ''), summary: full };
    expect(titles([row])).toEqual([full]);
  });
});

// #722's cut-title recovery and comment stripping must also apply to a heading row printed with its prose line (#721).
describe('selectForFile - heading rows use the whole-title logic of #722', () => {
  const U = 'https://github.com/o/r/blob/main/CLAUDE.md';
  const heading = 'A very long section heading that runs well past the eighty characters the graph keeps of a title';
  const row = (summary: string, title = heading.slice(0, 80)) => ({ title, platform: 'docs', summary, source_url: `${U}#long` });
  const first = (r: ReturnType<typeof row>) => selectForFile([r], 30).decisions[0]!.title;

  it('recovers a cut title when the summary opens with an HTML comment', () => {
    expect(first(row(`<!-- generated -->\n${heading}\n\nBody text goes here.`))).toBe(`${heading}: Body text goes here.`);
  });

  it('recovers a cut AsciiDoc heading', () => {
    expect(first(row(`= ${heading}\n\nBody text goes here.`))).toBe(`${heading}: Body text goes here.`);
  });

  it('cuts back to a whole word and marks it when the summary does not hold the heading', () => {
    const t = first(row('Body text goes here.'));
    expect(t).toBe(`${heading.slice(0, 80).replace(/\s*\S*$/, '')}...: Body text goes here.`);
  });

  it('does not print the comment as the prose line for a short heading', () => {
    expect(first(row('<!-- generated -->\nTesting\n\nRun the tests.', 'Testing'))).toBe('Testing: Run the tests.');
  });
});
