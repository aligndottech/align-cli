import { describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { activeStoredScope, configScopeStore, gitlabPlaceOf, realScopeDeps, scopeStatusHooks } from '../lib/scope-real.js';

const resolveRepo = vi.hoisted(() => vi.fn());
vi.mock('../lib/fetchers/github.js', () => ({ resolveGitHubRepoScope: resolveRepo }));
vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) { this.defaults = opts.defaults ?? {}; store = JSON.parse(JSON.stringify(this.defaults)); }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = JSON.parse(JSON.stringify(this.defaults)); }
    },
  };
});

/**
 * L4 Test List (the real wiring under the scope code):
 * - The store adapter reads and writes the LOCAL environment's choice, token fields and disclosure through the config store.
 * - A folder's remote identity becomes `owner/repo` only for the right host: a gitlab.com folder is not a GitHub repo, and the
 *   reverse; a bare local path is neither.
 */
describe('configScopeStore', () => {
  it('round-trips a team choice, an explicit yours and a clear, in the local environment', () => {
    const s = configScopeStore();
    expect(s.getScope('jira')).toBeNull();
    s.saveScope('jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    expect(s.getScope('jira')).toEqual({ kind: 'team', values: ['ALI'], labels: ['ALI'] });
    s.saveScope('github', { kind: 'yours' });
    expect(s.getScope('github')).toEqual({ kind: 'yours' });
    s.clearScope('jira');
    expect(s.getScope('jira')).toBeNull();
  });

  it('reads the saved connector fields (null when not connected) and remembers the disclosure per source', () => {
    const s = configScopeStore();
    expect(s.fields('linear')).toBeNull();
    s.isDisclosed('github');
    expect(s.isDisclosed('github')).toBe(false);
    s.markDisclosed('github');
    expect(s.isDisclosed('github')).toBe(true);
    expect(s.isDisclosed('gitlab')).toBe(false);
  });
});

describe('scopeStatusHooks', () => {
  it('the active scope key and the waiting scope come from the stored choice: team, yours, waiting over nothing, waiting over a team', () => {
    const c = configScopeStore();
    const h = scopeStatusHooks();
    expect(h.activeScopeKey('slack')).toBeUndefined();
    c.saveScope('jira', { kind: 'team', values: ['ALI', 'OPS'], labels: ['ALI', 'OPS'] });
    expect(h.activeScopeKey('jira')).toBe('jira:ALI,OPS');
    expect(h.pendingScope('jira')).toBeUndefined();
    c.saveScope('github', { kind: 'yours' });
    expect(h.activeScopeKey('github')).toBe('yours');
    c.saveScope('linear', { kind: 'team', values: ['i'], labels: ['ENG'], pending: { previous: null } });
    // Nothing was chosen before the waiting scope: the scope in force is the default, never the waiting one (it was reported as in force).
    expect(h.activeScopeKey('linear')).toBe('yours');
    expect(h.pendingScope('linear')).toBe("everyone's items in Linear team ENG");
    c.saveScope('gitlab', { kind: 'team', values: ['g/p'], labels: ['g/p'], pending: { previous: { kind: 'team', values: ['a/b'], labels: ['a/b'] } } });
    expect(h.activeScopeKey('gitlab')).toBe('gitlab:a/b');
    c.saveScope('confluence', { kind: 'team', values: ['ENG'], labels: ['ENG'], pending: { previous: { kind: 'yours' } } });
    expect(h.activeScopeKey('confluence')).toBe('yours');
  });
});

describe('activeStoredScope (what the per-source subcommands honour)', () => {
  it('is the stored choice in force: team, yours, and for a waiting agent choice the one it replaces; null when nothing was chosen', () => {
    const config = createConfigStore();
    const c = configScopeStore(config);
    expect(activeStoredScope('local-x', config)).toBeNull();
    c.saveScope('jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    expect(activeStoredScope('jira', config)).toEqual({ kind: 'team', values: ['ALI'], labels: ['ALI'] });
    c.saveScope('github', { kind: 'yours' });
    expect(activeStoredScope('github', config)).toEqual({ kind: 'yours' });
    c.saveScope('confluence', { kind: 'team', values: ['ENG'], labels: ['ENG'], pending: { previous: null } });
    expect(activeStoredScope('confluence', config)).toBeNull();
    c.saveScope('linear', { kind: 'team', values: ['i'], labels: ['ENG'], pending: { previous: { kind: 'yours' } } });
    expect(activeStoredScope('linear', config)).toEqual({ kind: 'yours' });
  });
});

describe('place from a folder', () => {
  it('GitHub: the folder is read by ALI-917\'s resolveGitHubRepoScope, so there is one reader of it', async () => {
    resolveRepo.mockResolvedValueOnce('o/r');
    expect(await realScopeDeps(undefined).cwdRepo()).toBe('o/r');
    expect(resolveRepo).toHaveBeenLastCalledWith({});
    resolveRepo.mockResolvedValueOnce(undefined);
    expect(await realScopeDeps(undefined).cwdRepo()).toBeUndefined();
  });

  it('GitLab: gitlab.com/g/sub/p gives g/sub/p; github.com and a local path give nothing', () => {
    expect(gitlabPlaceOf('gitlab.com/g/sub/p')).toBe('g/sub/p');
    expect(gitlabPlaceOf('gitlab.com/g/p')).toBe('g/p');
    expect(gitlabPlaceOf('github.com/o/r')).toBeUndefined();
    expect(gitlabPlaceOf('C:\\code\\proj')).toBeUndefined();
    expect(gitlabPlaceOf(null)).toBeUndefined();
  });
});
