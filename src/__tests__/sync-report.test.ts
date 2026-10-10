import { describe, expect, it } from 'vitest';
import { renderOutcome } from '../lib/sync/report.js';
import type { SourceOutcome } from '../lib/sync/run-source.js';

const base: SourceOutcome = { source: 'github', state: 'ok', read: 45, created: 12, updated: 3, skips: [] };

describe('renderOutcome', () => {
  it('a complete run says what was read, since when, and what changed', () => {
    expect(renderOutcome({ ...base, since: '2026-10-09T10:00:00.000Z' })).toEqual(['GitHub: 45 read since 2026-10-09 (12 new, 3 changed).']);
  });

  it('a second example: Jira, nothing new', () => {
    expect(renderOutcome({ source: 'jira', state: 'ok', read: 0, created: 0, updated: 0, skips: [] })).toEqual(['Jira: 0 read (0 new, 0 changed).']);
  });

  it('an incomplete run names the skip that stopped it and the date it reached', () => {
    const lines = renderOutcome({
      ...base, state: 'partial', reachedBack: '2026-09-20T00:00:00.000Z',
      skips: [{ kind: 'vendor_cap', count: 1, detail: 'search ceiling: GitHub returns at most 1,000 results' }],
    });
    expect(lines.join('\n')).toContain('Stopped early: 1 search ceiling: GitHub returns at most 1,000 results.');
    expect(lines.join('\n')).toContain('Reached back to 2026-09-20; the next sync carries on from there.');
  });

  it('a shape skip is information, not the reason a read stopped', () => {
    const lines = renderOutcome({ ...base, state: 'partial', reachedBack: '2026-09-20T00:00:00.000Z', skips: [
      { kind: 'shape', count: 4, detail: 'threads with no human message left out' },
      { kind: 'time_budget', count: 2, detail: 'channels not read (the 8 minute budget ran out)' },
    ] });
    expect(lines[1]).toContain('Stopped early: 2 channels not read');
    expect(lines.join('\n')).toContain('4 threads with no human message left out.');
  });

  it('the drain says how much of the discussion is still to come, and is silent when there was nothing to do', () => {
    expect(renderOutcome({ ...base, drain: { enriched: 150, remaining: 150, skips: [] } }).join('\n')).toContain('Discussion: 150 read, 150 still to come (the next sync continues).');
    expect(renderOutcome({ ...base, drain: { enriched: 0, remaining: 0, skips: [] } })).toHaveLength(1);
  });

  it('a refused token says the command, and never says anything was deleted', () => {
    const out = renderOutcome({ source: 'github', state: 'needs_reauth', read: 0, created: 0, updated: 0, skips: [], message: 'github needs the person to re-authenticate. Run: align connect github' });
    expect(out).toEqual(['GitHub: github needs the person to re-authenticate. Run: align connect github']);
    expect(out.join(' ')).not.toMatch(/forgot|deleted|removed/i);
  });

  it('a failed run says the token is untouched', () => {
    expect(renderOutcome({ source: 'slack', state: 'error', read: 0, created: 0, updated: 0, skips: [], message: 'socket hang up' })[0])
      .toBe('Slack: the sync failed (socket hang up). Nothing about the saved token changed; the next sync tries again.');
  });

  it('a team-scope read says whose items it covered', () => {
    expect(renderOutcome({ ...base, scopeNote: "everyone's PRs and issues in o/r, as far as your token can see" }).join('\n'))
      .toContain("Read everyone's PRs and issues in o/r, as far as your token can see.");
  });
});
