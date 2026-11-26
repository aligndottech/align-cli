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
  return { title: subject, platform: 'git', summary: `${subject}${body ? `\n\n${body}` : ''}${META}${n}`, source_url: `https://github.com/o/r/commit/${n}`, decided_at: at };
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

  it('never moves a docs row into the no-reason group', () => {
    const docs = { title: 'Never commit secrets', platform: 'docs', summary: 'Never commit secrets\n\nFrom the "Rules" section.', source_url: 'https://github.com/o/r/blob/m/README.md#rules~1' };
    expect(render([docs as never])).not.toContain(NO_REASON);
  });
});
