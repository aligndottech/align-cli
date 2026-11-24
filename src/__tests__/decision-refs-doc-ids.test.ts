import { describe, expect, it } from 'vitest';
import { extractRefs } from '../lib/decision-refs.js';

/*
 * TEST LIST (a user's ADRs carry ids like DEC-ADDA-013 and ADR-0012; those are ids in a markdown file, not Jira keys)
 * 1. A key that is the tail of a longer hyphenated id is not a ticket key, in any source:
 *    DEC-ADDA-013, ENH-ADDA-024. Control: ADDA-13 alone, and PROJ-123, still are.
 * 2. In a docs file a bare KEY-N needs Jira evidence on its own line (the word Jira). Without it: no ref.
 *    ADR-0012 / PLAT-77 alone: no ref. "Jira ticket PLAT-77" and "Tracked in Jira: OPS-5": ref.
 * 3. A Jira URL in a docs file still counts. A commit body (non-docs) keeps bare keys.
 */
describe('1. an id with more than one hyphen segment is not a ticket key', () => {
  it.each(['Issue: DEC-ADDA-013', 'Gates BUG-ADDA-018, BUG-ADDA-019'])('%s yields no ref (commit body)', (t) => {
    expect(extractRefs(t, 'git')).toEqual([]);
  });
  it.each(['Refs PROJ-123', 'See ADDA-13 for this'])('control: %s still yields a tracker ref', (t) => {
    expect(extractRefs(t, 'git').map((r) => r.platform)).toEqual(['tracker']);
  });
});

describe('2. in a docs file a bare key needs Jira evidence on its line', () => {
  it.each(['Extends: ADR-0012', 'Amends: ADR-0013 and PLAT-77'])('%s yields no ref', (t) => {
    expect(extractRefs(t, 'docs')).toEqual([]);
  });
  it.each(['Jira ticket PLAT-77 asked for this.', 'Tracked in Jira: OPS-5'])('control: %s still yields a ref', (t) => {
    expect(extractRefs(t, 'docs').map((r) => r.platform)).toEqual(['tracker']);
  });
  it('a bare key on a line without Jira is dropped even when another line mentions Jira', () => {
    expect(extractRefs('We use Jira.\nSee PLAT-77.', 'docs')).toEqual([]);
  });
});

describe('3. URLs and non-docs sources are unchanged', () => {
  it('a Jira browse URL in a docs file is still a jira ref', () => {
    expect(extractRefs('see https://acme.atlassian.net/browse/PLAT-77', 'docs')).toEqual([
      { ref: 'https://acme.atlassian.net/browse/PLAT-77', platform: 'jira' },
    ]);
  });
  it('with no source given, bare keys behave as before', () => {
    expect(extractRefs('Refs APP-123')).toEqual([{ ref: 'APP-123', platform: 'tracker' }]);
  });
});
