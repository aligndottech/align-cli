import { describe, expect, it } from 'vitest';
import { extractRefs } from '../lib/decision-refs.js';

/*
 * TEST LIST (a user's ADRs carry ids like DEC-ADDA-013 and ADR-0012; those are ids in a markdown file, not Jira keys)
 * 1. A key that is the tail of an UPPERCASE hyphenated id is not a ticket key: DEC-ADDA-013, ENH-ADDA-024.
 *    Controls: a branch-style prefix (hotfix-ABC-12, bugfix-PROJ-123, re-ABC-12) still yields the key; PROJ-123-PROJ-124 yields both.
 * 2. ADR joins the vocabulary prefixes: ADR-0012 / "Per ADR-0009" are not tickets, in any source.
 *    Controls: a key in a docs file keeps working (Ticket: PLAT-77, Closes PLAT-77, a table row), and ADR-0009 beside PLAT-7 leaves only PLAT-7.
 */
const keys = (t: string) => extractRefs(t).map((r) => r.ref);

describe('1. an id with an uppercase segment before it is not a ticket key', () => {
  it.each(['Issue: DEC-ADDA-013', 'Gates BUG-ADDA-018, BUG-ADDA-019', 'Issue: ENH-ADDA-024'])('%s yields no ref', (t) => {
    expect(keys(t)).toEqual([]);
  });
  it.each([
    ['Merge pull request #5 from org/hotfix-ABC-12', 'ABC-12'],
    ['branch bugfix-PROJ-123 merged', 'PROJ-123'],
    ['re-ABC-12', 'ABC-12'],
  ])('control: %s still yields %s', (t, k) => {
    expect(keys(t)).toContain(k);
  });
  it('pins PROJ-123-PROJ-124: both are keys (the first segment is a key, not an id prefix)', () => {
    expect(keys('PROJ-123-PROJ-124')).toEqual(['PROJ-123', 'PROJ-124']);
  });
});

describe('2. ADR-N is the ADR numbering, not a ticket', () => {
  it.each(['Per ADR-0009, we keep it.', 'Extends: ADR-0012', 'Amends: ADR-0013'])('%s yields no ref', (t) => {
    expect(keys(t)).toEqual([]);
  });
  it('ADR-0009 beside a real key leaves only the key', () => {
    expect(keys('ADR-0009 in Jira ticket PLAT-7')).toEqual(['PLAT-7']);
  });
  it.each(['Ticket: PLAT-77', 'Closes PLAT-77', '| Issue | PLAT-77 |'])('control: docs text "%s" still yields the key', (t) => {
    expect(keys(t)).toEqual(['PLAT-77']);
  });
  it('a Jira browse URL is still a jira ref', () => {
    expect(extractRefs('see https://acme.atlassian.net/browse/PLAT-77')).toEqual([{ ref: 'https://acme.atlassian.net/browse/PLAT-77', platform: 'jira' }]);
  });
});
