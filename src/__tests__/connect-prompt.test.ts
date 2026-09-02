import { describe, expect, it } from 'vitest';
import { askTrailingLine, setupSummaryLine, statusGapLine, unresolvedGaps } from '../lib/connect-prompt.js';

// ALI-796: the graph names its own gaps - a ref whose platform has no connected
// source. `unresolvedGaps` is the pure resolver: refs x connected-sources -> counts.
describe('unresolvedGaps', () => {
  it('counts DISTINCT DECISIONS with an unresolved ref, not total refs', () => {
    const refs = [
      { decisionId: 'a', platform: 'jira' },
      { decisionId: 'a', platform: 'jira' }, // same decision, two jira refs
      { decisionId: 'b', platform: 'jira' },
    ];
    const gaps = unresolvedGaps(refs, () => false);
    expect(gaps).toEqual([{ platform: 'jira', decisions: 2, connectors: ['jira'] }]);
  });

  it('drops a platform once ANY of its candidate connectors is connected', () => {
    const refs = [{ decisionId: 'a', platform: 'jira' }];
    const gaps = unresolvedGaps(refs, (id) => id === 'jira');
    expect(gaps).toEqual([]);
  });

  it('names BOTH candidate connectors for an ambiguous tracker key', () => {
    const refs = [{ decisionId: 'a', platform: 'tracker' }];
    const gaps = unresolvedGaps(refs, () => false);
    expect(gaps).toEqual([{ platform: 'tracker', decisions: 1, connectors: ['jira', 'linear'] }]);
  });

  it('resolves a tracker gap once EITHER candidate connector is connected', () => {
    const refs = [{ decisionId: 'a', platform: 'tracker' }];
    const gaps = unresolvedGaps(refs, (id) => id === 'linear');
    expect(gaps).toEqual([]);
  });

  it('sorts the biggest gap first', () => {
    const refs = [
      { decisionId: 'a', platform: 'slack' },
      { decisionId: 'b', platform: 'jira' },
      { decisionId: 'c', platform: 'jira' },
      { decisionId: 'd', platform: 'jira' },
    ];
    const gaps = unresolvedGaps(refs, () => false);
    expect(gaps.map((g) => g.platform)).toEqual(['jira', 'slack']);
  });

  it('returns nothing for an empty graph', () => {
    expect(unresolvedGaps([], () => false)).toEqual([]);
  });
});

describe('setupSummaryLine', () => {
  it('names the biggest gap with the real command, and returns null with none', () => {
    expect(setupSummaryLine([])).toBeNull();
    const line = setupSummaryLine([
      { platform: 'jira', decisions: 12, connectors: ['jira'] },
      { platform: 'slack', decisions: 3, connectors: ['slack'] },
    ]);
    expect(line).toBe(
      "12 decisions reference Jira keys I can't read - align import jira when you want them filled in.",
    );
  });

  it('singularizes a lone decision', () => {
    const line = setupSummaryLine([{ platform: 'slack', decisions: 1, connectors: ['slack'] }]);
    expect(line).toBe(
      "1 decision references Slack keys I can't read - align import slack when you want it filled in.",
    );
  });

  it('joins ambiguous connectors with "or"', () => {
    const line = setupSummaryLine([{ platform: 'tracker', decisions: 4, connectors: ['jira', 'linear'] }]);
    expect(line).toContain('align import jira or align import linear');
  });
});

describe('statusGapLine', () => {
  it('renders one platform gap with its command', () => {
    expect(statusGapLine({ platform: 'confluence', decisions: 2, connectors: ['confluence'] }))
      .toBe("  2 decisions cite Confluence I can't read - align import confluence");
  });

  it('agrees the verb with a lone decision', () => {
    expect(statusGapLine({ platform: 'tracker', decisions: 1, connectors: ['jira', 'linear'] }))
      .toBe("  1 decision cites ticket-tracker I can't read - align import jira or align import linear");
  });
});

describe('askTrailingLine', () => {
  it('names the first unresolved ref on a decision', () => {
    const line = askTrailingLine([{ platform: 'jira' }], () => false);
    expect(line).toBe("cites a Jira ref I can't read - align import jira");
  });

  it('returns null when every ref is already resolved', () => {
    expect(askTrailingLine([{ platform: 'jira' }], () => true)).toBeNull();
  });

  it('returns null for a decision with no refs', () => {
    expect(askTrailingLine([], () => false)).toBeNull();
  });

  // Copilot review finding (PR #227): 'code' labels as "issue-tracker", which starts
  // with a vowel sound - "cites a issue-tracker ref" is ungrammatical.
  it('uses "an" before a vowel-starting label', () => {
    const line = askTrailingLine([{ platform: 'code' }], () => false);
    expect(line).toBe("cites an issue-tracker ref I can't read - align import github or align import gitlab");
  });

  it('keeps "a" before a consonant-starting label', () => {
    const line = askTrailingLine([{ platform: 'tracker' }], () => false);
    expect(line).toBe("cites a ticket-tracker ref I can't read - align import jira or align import linear");
  });
});
