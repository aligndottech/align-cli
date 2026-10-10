import { describe, expect, it } from 'vitest';
import { type BackgroundSyncInput, reauthSources, shouldBackgroundSync, SYNC_MIN_INTERVAL_MS } from '../lib/sync/should-background-sync.js';
import type { SummarySource, SyncSummary } from '../lib/sync/summary-read.js';

/**
 * L6 Test List (the pure launch decision, Decisions 8, 9, 23):
 * - Due: a last success 16 min ago is due; 14 min ago is not; exactly 15 is (both sides of the boundary).
 * - A source that ATTEMPTED recently is not retried even if its last success is old (always-partial sources).
 * - Gates: no TTY, wrapped, ALIGN_NO_SYNC, CI, `align sync --off`, no summary -> []. None of them -> a spawn.
 * - Teams (not background-eligible) and needs_reauth sources are never asked for; error/partial/never are.
 * - A source whose sync or backfill is running (busy) is left out.
 * - A bad timestamp counts as stale, never as fresh; an id that could be read as a flag never reaches argv.
 * - The re-auth line: only for eligible needs_reauth sources, at most once per interval, same gates.
 */
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const src = (id: string, over: Partial<SummarySource> = {}): SummarySource => ({ id, backgroundEligible: true, status: 'ok', ...over });
const summary = (...sources: SummarySource[]): SyncSummary => ({ version: 1, generated_at: minutesAgo(1), sources });

function input(over: Partial<BackgroundSyncInput> = {}): BackgroundSyncInput {
  return { isTty: true, wrapped: false, noSync: false, ci: false, disabled: false, summary: summary(src('github', { lastSuccessAt: minutesAgo(16) })), now: NOW, minIntervalMs: SYNC_MIN_INTERVAL_MS, ...over };
}

describe('shouldBackgroundSync: which sources are due', () => {
  it('a last success 16 minutes ago is due; 14 minutes ago is not', () => {
    expect(shouldBackgroundSync(input())).toEqual(['github']);
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { lastSuccessAt: minutesAgo(14) })) }))).toEqual([]);
  });

  it('the boundary: exactly the interval is due, one second short is not', () => {
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { lastSuccessAt: minutesAgo(15) })) }))).toEqual(['github']);
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { lastSuccessAt: new Date(NOW - SYNC_MIN_INTERVAL_MS + 1000).toISOString() })) }))).toEqual([]);
  });

  it('judges each source on its own clock', () => {
    const s = summary(src('github', { lastSuccessAt: minutesAgo(16) }), src('jira', { lastSuccessAt: minutesAgo(3) }), src('linear', { lastSuccessAt: minutesAgo(90) }));
    expect(shouldBackgroundSync(input({ summary: s }))).toEqual(['github', 'linear']);
  });

  it('a source nobody has ever synced by hand is NOT started: a person runs `align sync` or a backfill once first', () => {
    expect(shouldBackgroundSync(input({ summary: summary(src('slack', { status: 'never' })) }))).toEqual([]);
    expect(shouldBackgroundSync(input({ summary: summary(src('slack', { status: 'never' }), src('github', { lastSuccessAt: minutesAgo(90) })) }))).toEqual(['github']);
  });
  it('a source stuck on manual or not_connected is not scheduled (its runs write no timestamp, so it would respawn every interval)', () => {
    for (const status of ['manual', 'not_connected'] as const) {
      expect(shouldBackgroundSync(input({ summary: summary(src('confluence', { status, lastSuccessAt: minutesAgo(90) }), src('github', { lastSuccessAt: minutesAgo(90) })) }))).toEqual(['github']);
    }
  });

  it('a recent ATTEMPT holds a source back even when its last success is old (always-partial sources are not retried every launch)', () => {
    const old = minutesAgo(180);
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { status: 'partial', lastSuccessAt: old, lastAttemptAt: minutesAgo(5) })) }))).toEqual([]);
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { status: 'partial', lastSuccessAt: old, lastAttemptAt: minutesAgo(20) })) }))).toEqual(['github']);
  });

  it('an unparseable timestamp is stale, never fresh', () => {
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { lastSuccessAt: 'yesterday-ish' })) }))).toEqual(['github']);
    // an unparseable ATTEMPT is ignored, so the (fresh) success still holds the source back
    expect(shouldBackgroundSync(input({ summary: summary(src('github', { lastSuccessAt: minutesAgo(2), lastAttemptAt: 'x' })) }))).toEqual([]);
  });
});

describe('shouldBackgroundSync: a timestamp from the future', () => {
  it('is ignored: a past stamp beside it decides (two examples)', () => {
    const fresh = src('github', { lastSuccessAt: minutesAgo(-600), lastAttemptAt: minutesAgo(3) });
    const old = src('github', { lastSuccessAt: minutesAgo(-600), lastAttemptAt: minutesAgo(40) });
    expect(shouldBackgroundSync(input({ summary: summary(fresh) }))).toEqual([]);
    expect(shouldBackgroundSync(input({ summary: summary(old) }))).toEqual(['github']);
  });
  it('with only future stamps the source counts as tried when the summary was written: not due on every launch, due once the interval has passed', () => {
    const futureOnly = src('github', { lastSuccessAt: minutesAgo(-600) });
    const written = (m: number): SyncSummary => ({ version: 1, generated_at: minutesAgo(m), sources: [futureOnly] });
    expect(shouldBackgroundSync(input({ summary: written(2) }))).toEqual([]);
    expect(shouldBackgroundSync(input({ summary: written(20) }))).toEqual(['github']);
  });
  it('future stamps and an unusable generated_at: due (the launch claim, not this function, holds it back)', () => {
    const s: SyncSummary = { version: 1, generated_at: 'nope', sources: [src('github', { lastSuccessAt: minutesAgo(-600) })] };
    expect(shouldBackgroundSync(input({ summary: s }))).toEqual(['github']);
  });
});

describe('shouldBackgroundSync: when nothing may start', () => {
  it.each([
    ['no terminal', { isTty: false }],
    ['already inside a launched agent', { wrapped: true }],
    ['ALIGN_NO_SYNC', { noSync: true }],
    ['CI', { ci: true }],
    ['align sync --off', { disabled: true }],
    ['no summary file', { summary: undefined }],
  ] as Array<[string, Partial<BackgroundSyncInput>]>)('%s -> nothing, and none of the gates -> a spawn', (_n, over) => {
    expect(shouldBackgroundSync(input(over))).toEqual([]);
    expect(shouldBackgroundSync(input())).toEqual(['github']);
  });

  it('Teams alone is never asked for; Teams with Slack leaves Teams out', () => {
    const teams = src('teams', { backgroundEligible: false, status: 'never' });
    expect(shouldBackgroundSync(input({ summary: summary(teams) }))).toEqual([]);
    expect(shouldBackgroundSync(input({ summary: summary(teams, src('slack', { status: 'ok', lastSuccessAt: minutesAgo(90) })) }))).toEqual(['slack']);
  });

  it('a needs_reauth source is not asked for; error and partial sources are', () => {
    const s = summary(
      src('github', { status: 'needs_reauth', lastSuccessAt: minutesAgo(900) }),
      src('jira', { status: 'error', lastSuccessAt: minutesAgo(900) }),
      src('slack', { status: 'partial', lastSuccessAt: minutesAgo(900) }),
    );
    expect(shouldBackgroundSync(input({ summary: s }))).toEqual(['jira', 'slack']);
  });

  it('a source with a sync or backfill running is left out', () => {
    const s = summary(src('github', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('jira', { status: 'ok', lastSuccessAt: minutesAgo(90) }));
    expect(shouldBackgroundSync(input({ summary: s, busy: new Set(['jira']) }))).toEqual(['github']);
    expect(shouldBackgroundSync(input({ summary: s, busy: new Set(['linear']) }))).toEqual(['github', 'jira']);
  });

  it('an id that could be read as a flag or a second word never reaches the argv', () => {
    const s = summary(src('--yes', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('a b', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('github', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('github', { status: 'ok', lastSuccessAt: minutesAgo(90) }));
    expect(shouldBackgroundSync(input({ summary: s }))).toEqual(['github']);
  });

  it('an id that is well formed but is not a source does not stop the real ones, and does not start (two examples)', () => {
    expect(shouldBackgroundSync(input({ summary: summary(src('myspace', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('github', { status: 'ok', lastSuccessAt: minutesAgo(90) })) }))).toEqual(['github']);
    expect(shouldBackgroundSync(input({ summary: summary(src('myspace', { status: 'ok', lastSuccessAt: minutesAgo(90) })) }))).toEqual([]);
  });
});

describe('reauthSources: the re-connect line', () => {
  const stuck = summary(src('github', { status: 'needs_reauth' }), src('jira'), src('teams', { backgroundEligible: false, status: 'needs_reauth' }));
  const base = { isTty: true, wrapped: false, noSync: false, ci: false, disabled: false, summary: stuck, now: NOW, lastShownAt: undefined as string | undefined, intervalMs: 24 * 3_600_000 };

  it('names eligible needs_reauth sources only (not Teams, which is refreshed by hand)', () => {
    expect(reauthSources(base)).toEqual(['github']);
  });
  it('never shown: shown. 2 hours ago: not. 25 hours ago: shown. exactly 24 hours: shown', () => {
    expect(reauthSources({ ...base, lastShownAt: minutesAgo(120) })).toEqual([]);
    expect(reauthSources({ ...base, lastShownAt: minutesAgo(25 * 60) })).toEqual(['github']);
    expect(reauthSources({ ...base, lastShownAt: minutesAgo(24 * 60) })).toEqual(['github']);
  });
  it('an unreadable last-shown time counts as never shown', () => {
    expect(reauthSources({ ...base, lastShownAt: 'garbage' })).toEqual(['github']);
  });
  it('the same gates as the spawn: no terminal, wrapped, ALIGN_NO_SYNC, CI, --off, no summary -> nothing', () => {
    for (const over of [{ isTty: false }, { wrapped: true }, { noSync: true }, { ci: true }, { disabled: true }, { summary: undefined }]) {
      expect(reauthSources({ ...base, ...over })).toEqual([]);
    }
  });
  it('a clean summary has nothing to say', () => {
    expect(reauthSources({ ...base, summary: summary(src('github')) })).toEqual([]);
  });
});
