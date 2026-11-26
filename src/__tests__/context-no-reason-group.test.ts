/**
 * A commit with no stated reason is a fact about development, not a decision (reported 25 Nov 2026 on yegor256/takes).
 *
 * Test List:
 * 1. a subject-word commit with no reason is listed under "Changes with no stated reason", after the reasoned decisions
 * 2. a commit with a Why line stays in the main list
 * 3. at the cap, a reasoned row displaces a reasonless one, and not the reverse
 * 4. a docs row is never moved into the no-reason group
 */
import { describe, expect, it } from 'vitest';
import { selectForFile } from '../lib/context-from-graph.js';
import { renderDecisionsFile } from '../lib/decisions-context.js';

let n = 0;
const META = '\n\nAuthor: Ada\n\nDate: 2026-11-01T10:00:00+01:00\n\nURL: git://commit/';
const commit = (subject: string, body: string, at: string) => {
  n += 1;
  return { title: subject, platform: 'git', summary: `${subject}${body ? `\n\n${body}` : ''}${META}${n}`, source_url: `https://github.com/o/r/commit/abc${String(n).padStart(4, '0')}`, decided_at: at };
};
const BODY = 'We keep the session in memory for five minutes because the dashboard polls every second.';
const bare = (s: string, at = '2026-11-02T00:00:00Z') => commit(s, '', at);
const reasoned = (s: string, at = '2020-01-01T00:00:00Z') => commit(s, BODY, at);
const render = (rows: ReturnType<typeof commit>[], limit = 30) => renderDecisionsFile(selectForFile(rows as never[], limit).decisions);
const NO_REASON = '## Changes with no stated reason';

describe('commits with no stated reason', () => {
  it('lists a reasonless subject-word commit under its own heading, after the reasoned ones', () => {
    const out = render([bare('Use Java 1.8 instead of 11'), reasoned('Use pipes instead of sockets')]);
    const [main, rest] = out.split(NO_REASON);
    expect(rest).toContain('Use Java 1.8 instead of 11');
    expect(main).toContain('Use pipes instead of sockets');
    expect(main).not.toContain('Use Java 1.8');
  });

  it('keeps a commit that has a Why line in the main list, with no extra heading when all have one', () => {
    const out = render([reasoned('Use pipes instead of sockets')]);
    expect(out).toContain('Use pipes instead of sockets');
    expect(out).toContain('Why:');
    expect(out).not.toContain(NO_REASON);
  });

  it('at the cap a reasoned row displaces a reasonless newer one', () => {
    const out = render([bare('Use Java 1.8 instead of 11'), reasoned('Use pipes instead of sockets')], 1);
    expect(out).toContain('Use pipes instead of sockets');
    expect(out).not.toContain('Java 1.8');
  });

  it('at the cap a reasonless row never displaces a reasoned older one (order of input does not matter)', () => {
    const out = render([reasoned('Use pipes instead of sockets'), bare('Use Java 1.8 instead of 11')], 1);
    expect(out).toContain('Use pipes instead of sockets');
    expect(out).not.toContain('Java 1.8');
  });

  it('keeps newest first inside the no-reason group', () => {
    const out = render([bare('Use A instead of B', '2020-01-01T00:00:00Z'), bare('Use C instead of D', '2026-01-01T00:00:00Z')]);
    expect(out.indexOf('Use C instead of D')).toBeLessThan(out.indexOf('Use A instead of B'));
  });

  it('never moves a chat or ticket row with no reason into the no-reason group', () => {
    const chat = { title: 'Freeze deploys on Fridays', platform: 'slack', summary: '', source_url: 'https://acme.slack.com/archives/C1/p1' };
    const out = render([chat as never, bare('Use Java 1.8 instead of 11')]);
    expect(out.split(NO_REASON)[0]).toContain('Freeze deploys on Fridays');
    expect(out.split(NO_REASON)[1]).not.toContain('Freeze deploys');
  });

  it('at the cap a reasonless chat row does not outrank a reasonless commit: the old order holds between them', () => {
    const chat = { title: 'Freeze deploys on Fridays', platform: 'slack', summary: '', source_url: 'https://acme.slack.com/archives/C1/p1' };
    const out = render([chat as never, bare('Use Java 1.8 instead of 11')], 1);
    expect(out).toContain('Java 1.8');
    expect(out).not.toContain('Freeze deploys');
  });
});

describe('a reason stated in the subject', () => {
  it('counts: "Use X instead of Y because Z" is a decision with that Why', () => {
    const out = render([bare('Use pipes instead of sockets because pipes are faster')]);
    expect(out).not.toContain(NO_REASON);
    expect(out).toContain('Why: because pipes are faster');
  });

  it('a subject with no reason word stays a change', () => {
    expect(render([bare('Use pipes instead of sockets')])).toContain(NO_REASON);
  });
});

describe('a merged row keeps the reason of its group', () => {
  const OLD = '2020-01-01T00:00:00Z';
  it.each([
    ['newer bare, older reasoned', bare('Use pipes instead of sockets', '2020-06-01T00:00:00Z'), reasoned('Use pipes instead of sockets', OLD)],
    ['newer reasoned, older bare', reasoned('Use pipes instead of sockets', '2020-06-01T00:00:00Z'), bare('Use pipes instead of sockets', OLD)],
  ])('collapse: %s is one row with the reason, in the main list', (_n, a, b) => {
    const out = render([a, b]);
    expect(out).not.toContain(NO_REASON);
    expect(out).toContain('(2 commits)');
    expect(out).toContain('Why:');
  });

  it.each([
    ['newer bare reverses older reasoned', bare('Use A instead of B', '2021-01-01T00:00:00Z'), reasoned('Use B instead of A', OLD)],
    ['newer reasoned reverses older bare', reasoned('Use A instead of B', '2021-01-01T00:00:00Z'), bare('Use B instead of A', OLD)],
    ['both bare', bare('Use A instead of B', '2021-01-01T00:00:00Z'), bare('Use B instead of A', OLD)],
  ])('reversal: %s is a decision (the reversal tag counts), never filed as no reason', (_n, a, b) => {
    const out = render([a, b]);
    expect(out).toContain('reverses');
    expect(out).not.toContain(NO_REASON);
  });

  it('at the cap a bare reversal is not cut before a bare plain change', () => {
    const out = render([bare('Use C instead of D', '2022-01-01T00:00:00Z'), bare('Use A instead of B', '2021-01-01T00:00:00Z'), reasoned('Use B instead of A', '2020-01-01T00:00:00Z')], 1);
    expect(out).toContain('reverses');
  });
});

describe('spacing', () => {
  it('a file with no reasonless rows has exactly the bytes the renderer wrote before the heading existed', () => {
    const out = render([reasoned('Use pipes instead of sockets')]);
    const expected = '# Decisions (generated by Align)\n\nGenerated from your decision graph. Edits here are overwritten; this file is owned by\n`align`. Re-run the generator to bring it up to date.\n\n## Decisions, with the reason given where there is one\n\n';
    expect(out.startsWith(expected)).toBe(true);
    expect(out.endsWith('\n') && !out.endsWith('\n\n')).toBe(true);
    const withTail = renderDecisionsFile(selectForFile([reasoned('Use pipes instead of sockets')] as never[], 30).decisions, { leftOut: 5 });
    expect(withTail).toMatch(/\n {2}Why: [^\n]*\n\n5 more items in the graph are not listed here\. `align ask` still searches them\.\n$/);
  });

  it('with a change group: one blank line between the groups and before the tail', () => {
    const out = renderDecisionsFile(selectForFile([reasoned('Use pipes instead of sockets'), bare('Use Java 1.8 instead of 11')] as never[], 30).decisions, { leftOut: 5 });
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toMatch(/\n\n## Changes with no stated reason\n\n- /);
    expect(out).toMatch(/\n\n5 more items/);
  });
});
