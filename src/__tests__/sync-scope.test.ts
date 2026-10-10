import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
const fetchGitHubItemsOnly = vi.hoisted(() => vi.fn(async () => ({ items: [], report: { scanned: 0, skips: [], complete: true } })));
vi.mock('../lib/fetchers/github.js', async (orig) => ({ ...(await orig<object>()), fetchGitHubItemsOnly }));
const sourceFetch = vi.hoisted(() => vi.fn(async () => ({ items: [], report: { scanned: 0, skips: [], complete: true } })));
vi.mock('../commands/setup.js', () => ({ buildSources: () => ['jira', 'linear', 'gitlab', 'confluence', 'slack'].map((id) => ({ id, fetch: sourceFetch })) }));

import { renderOutcome } from '../lib/sync/report.js';
import { syncSource } from '../lib/sync/run-source.js';
import { fetchSource, scopeOf } from '../lib/sync/sources.js';
import { readRows } from '../lib/sync/sync-state.js';
import { inheritedWindowSince } from '../lib/sync/window.js';
import { makeDeps, memStore } from './helpers/scope-deps.js';
import { type Harness, harness, NOW } from './helpers/sync-env.js';

vi.setConfig({ testTimeout: 60_000 });

/**
 * L4 Test List (a sync under a chosen scope):
 * - scopeOf asks the scope code as a BACKGROUND or FOREGROUND run, and a background run does not widen an undisclosed folder.
 * - The option a team scope needs reaches the fetcher: Jira projects, Linear teams, a GitLab project, Confluence spaces, and for
 *   GitHub the repo with scope team. A yours scope sends none of them (and GitHub no repo).
 * - A blocked source (Confluence with no spaces) makes no request, creates no row, and says the command to run.
 * - A scope's note (why it is only yours) is part of what the run reports.
 * - A foreground disclosure is announced BEFORE the fetch, once, and is marked as told; with nobody to announce to, it is not marked.
 * - A new scope row takes the source's window (all stays all); the earlier scope's row is untouched.
 */
let h: Harness;
beforeEach(() => { h = harness(); fetchGitHubItemsOnly.mockClear(); sourceFetch.mockClear(); });
afterEach(() => h.cleanup());

describe('scopeOf', () => {
  it('a foreground run reads a detected repo as team; a background run does not until it was disclosed (both sides)', async () => {
    const table: Array<[RegExp, { status: number }]> = [[/api\.github\.com\/search/, { status: 200 }]];
    const fg = await scopeOf('github', { trigger: 'cli' }, makeDeps(undefined, { cwdRepo: async () => 'o/r', table }));
    expect(fg).toMatchObject({ scope: 'team', scopeKey: 'repo:o/r', repo: 'o/r' });
    const bg = await scopeOf('github', { trigger: 'background' }, makeDeps(undefined, { cwdRepo: async () => 'o/r', table }));
    expect(bg).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    const told = await scopeOf('github', { trigger: 'background' }, makeDeps(undefined, { store: memStore({ disclosed: ['github'] }), cwdRepo: async () => 'o/r', table }));
    expect(told).toMatchObject({ scope: 'team', repo: 'o/r' });
  });
});

describe('fetchSource', () => {
  const tokens = { token: 'tok' };

  it('passes a team scope to the source fetch as the option that fetcher takes (four sources)', async () => {
    await fetchSource('jira', tokens, { since: 'S' }, { scopeKey: 'jira:ALI', scope: 'team', extras: { projects: ['ALI'] } });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, { projects: ['ALI'] });
    await fetchSource('linear', tokens, { since: 'S' }, { scopeKey: 'linear:ENG', scope: 'team', extras: { teams: ['id-1'] } });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, { teams: ['id-1'] });
    await fetchSource('gitlab', tokens, { since: 'S' }, { scopeKey: 'gitlab:g/p', scope: 'team', extras: { projectId: 'g/p' } });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, { projectId: 'g/p' });
    await fetchSource('confluence', tokens, { since: 'S' }, { scopeKey: 'confluence:ENG', scope: 'team', extras: { spaces: ['ENG'] } });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, { spaces: ['ENG'] });
  });

  it('a yours scope sends no scope option', async () => {
    await fetchSource('jira', tokens, { since: 'S' }, { scopeKey: 'yours', scope: 'yours', extras: {} });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, {});
    await fetchSource('slack', tokens, { since: 'S' }, { scopeKey: 'yours', scope: 'yours' });
    expect(sourceFetch).toHaveBeenLastCalledWith(tokens, { since: 'S' }, {});
  });

  it('GitHub team sends the repo and scope team; GitHub yours sends neither, even when it once had a repo', async () => {
    await fetchSource('github', tokens, { since: 'S' }, { scopeKey: 'repo:o/r', scope: 'team', repo: 'o/r' });
    expect(fetchGitHubItemsOnly).toHaveBeenLastCalledWith(expect.objectContaining({ repo: 'o/r', scope: 'team' }));
    await fetchSource('github', tokens, { since: 'S' }, { scopeKey: 'yours', scope: 'yours' });
    const arg = fetchGitHubItemsOnly.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('repo');
    expect(arg).not.toHaveProperty('scope');
  });
});

describe('a run under a scope', () => {
  const jira = (over: Record<string, unknown> = {}) => ({ scopeKey: 'jira:ALI', scope: 'team' as const, extras: { projects: ['ALI'] }, ...over });

  it('hands the scope to the fetch and records the run under that scope key', async () => {
    const seen: unknown[] = [];
    h.env.scopeOf = async () => jira();
    h.env.fetch = async (_s, _t, _w, scope) => { seen.push(scope); return { items: [], report: { scanned: 0, skips: [], complete: true } }; };
    await syncSource('jira', h.env);
    expect(seen).toEqual([jira()]);
    expect(readRows(h.dbPath, 'jira').map((r) => r.scope_key)).toEqual(['jira:ALI']);
  });

  it('asks scopeOf for the trigger of this run', async () => {
    const triggers: string[] = [];
    h.env.scopeOf = async (_s, o) => { triggers.push(o.trigger); return { scopeKey: 'yours', scope: 'yours' }; };
    h.script({ items: [] });
    await syncSource('jira', h.env, { trigger: 'background' });
    await syncSource('jira', h.env, { trigger: 'cli' });
    expect(triggers).toEqual(['background', 'cli']);
  });

  it('a blocked source makes no request, creates no row, and reports the command (state manual)', async () => {
    h.env.scopeOf = async () => ({ scopeKey: 'yours', scope: 'yours', blocked: 'Confluence reads only the spaces you choose. Pick them: align connect confluence --spaces ENG,OPS' });
    h.script({ items: [] });
    const out = await syncSource('confluence', h.env);
    expect(out).toMatchObject({ state: 'manual', read: 0 });
    expect(out.message).toContain('align connect confluence --spaces');
    expect(h.fetchCalls).toHaveLength(0);
    expect(readRows(h.dbPath, 'confluence')).toEqual([]);
    expect(renderOutcome(out)[0]).toContain('Confluence: Confluence reads only the spaces you choose');
  });

  it('the scope note is part of the outcome and is printed', async () => {
    h.env.scopeOf = async () => ({ scopeKey: 'yours', scope: 'yours', note: 'Your GitHub token cannot see o/r, so only items you are involved in were imported. Reconnect with repo access: align connect github' });
    h.script({ items: [] });
    const out = await syncSource('github', h.env);
    expect(out.scopeLine).toContain('cannot see o/r');
    expect(renderOutcome(out)).toContain('  Your GitHub token cannot see o/r, so only items you are involved in were imported. Reconnect with repo access: align connect github');
  });

  it('a foreground disclosure is announced before the first request, once, then marked as told', async () => {
    const events: string[] = [];
    h.env.scopeOf = async () => jira({ disclosure: 'Importing items from everyone in Jira project ALI that your token can read.' });
    h.env.fetch = async () => { events.push('fetch'); return { items: [], report: { scanned: 0, skips: [], complete: true } }; };
    h.env.announce = (s, line) => { events.push(`announce ${s}: ${line.slice(0, 20)}`); };
    h.env.markDisclosed = (s) => { events.push(`marked ${s}`); };
    await syncSource('jira', h.env);
    expect(events).toEqual(['announce jira: Importing items from', 'marked jira', 'fetch']);
  });

  it('with nobody to announce to (a background run), nothing is marked as told', async () => {
    const marked: string[] = [];
    h.env.scopeOf = async () => jira({ disclosure: 'Importing items from everyone in Jira project ALI that your token can read.' });
    h.env.markDisclosed = (s) => { marked.push(s); };
    h.script({ items: [] });
    await syncSource('jira', h.env, { trigger: 'background' });
    expect(marked).toEqual([]);
  });

  describe("an agent's waiting scope offered to a person during a sync", () => {
    const offered = (): Record<string, unknown> => jira({ disclosure: 'Importing items from everyone in Jira project ALI that your token can read.', activates: true });
    const kept = { scopeKey: 'yours', scope: 'yours' as const, extras: {}, note: 'Team scope for jira is waiting for you to confirm: run `align sync jira` (it will show what it reads)' };

    it('Yes: it is announced, asked, marked told (which activates it), and read as team', async () => {
      const seen: unknown[] = [];
      const events: string[] = [];
      h.env.scopeOf = async (_s, o) => (o.trigger === 'cli' ? offered() : kept) as never;
      h.env.announce = () => { events.push('announce'); };
      h.env.confirm = async () => { events.push('confirm'); return true; };
      h.env.markDisclosed = (s, key) => { events.push(`mark ${s} ${key}`); };
      h.env.fetch = async (_s, _t, _w, scope) => { seen.push(scope.scopeKey); return { items: [], report: { scanned: 0, skips: [], complete: true } }; };
      await syncSource('jira', h.env);
      expect(events).toEqual(['announce', 'confirm', 'mark jira jira:ALI']);
      expect(seen).toEqual(['jira:ALI']);
    });

    it('No, or nothing to ask with (no confirm wired): not marked, and the source is read under what was in force, with the waiting note (two ways)', async () => {
      for (const withConfirm of [true, false]) {
        const seen: unknown[] = [];
        const marked: string[] = [];
        h.env.scopeOf = async (_s, o) => (o.trigger === 'cli' ? offered() : kept) as never;
        h.env.announce = () => {};
        if (withConfirm) h.env.confirm = async () => false; else delete h.env.confirm;
        h.env.markDisclosed = (s) => { marked.push(s); };
        h.env.fetch = async (_s, _t, _w, scope) => { seen.push(scope.scopeKey); return { items: [], report: { scanned: 0, skips: [], complete: true } }; };
        const out = await syncSource('jira', h.env);
        expect(seen).toEqual(['yours']);
        expect(marked).toEqual([]);
        expect(out.scopeLine).toContain('waiting for you to confirm');
        h.env.fetch = async () => ({ items: [], report: { scanned: 0, skips: [], complete: true } });
      }
    });
  });

  it('no disclosure, no announcement', async () => {
    const announced: string[] = [];
    h.env.scopeOf = async () => jira();
    h.env.announce = (_s, line) => { announced.push(line); };
    h.script({ items: [] });
    await syncSource('jira', h.env);
    expect(announced).toEqual([]);
  });

  it('a new scope row takes the source window ("all" stays all) and leaves the earlier scope row untouched', async () => {
    h.script({ items: [] });
    await syncSource('jira', h.env);
    const db = new (await import('node:sqlite')).DatabaseSync(h.dbPath);
    db.prepare(`UPDATE source_sync SET window_since = NULL, high_water = '2026-09-01T00:00:00.000Z' WHERE source_id = 'jira'`).run();
    db.close();
    const before = readRows(h.dbPath, 'jira').find((r) => r.scope_key === 'yours')!;
    h.env.scopeOf = async () => jira();
    await syncSource('jira', h.env);
    const rows = readRows(h.dbPath, 'jira');
    expect(rows.find((r) => r.scope_key === 'jira:ALI')).toMatchObject({ window_since: null, scope: 'team' });
    expect(rows.find((r) => r.scope_key === 'yours')).toMatchObject({ high_water: before.high_water, window_since: null });
  });
});

describe('inheritedWindowSince', () => {
  it('is the yours row window (a date, or NULL for all); with no yours row it is the default window from now', () => {
    expect(inheritedWindowSince([{ scope_key: 'yours', window_since: '2026-01-01T00:00:00.000Z' }, { scope_key: 'repo:o/r', window_since: '2026-05-05T00:00:00.000Z' }], NOW)).toBe('2026-01-01T00:00:00.000Z');
    expect(inheritedWindowSince([{ scope_key: 'yours', window_since: null }], NOW)).toBeNull();
    expect(inheritedWindowSince([{ scope_key: 'repo:o/r', window_since: '2026-05-05T00:00:00.000Z' }], NOW)).toBe('2026-04-13T12:00:00.000Z');
    expect(inheritedWindowSince([], NOW)).toBe('2026-04-13T12:00:00.000Z');
  });
});
