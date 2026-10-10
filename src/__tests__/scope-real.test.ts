import { describe, expect, it, vi } from 'vitest';
import { configScopeStore, githubPlaceOf, gitlabPlaceOf } from '../lib/scope-real.js';

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

describe('place from a folder identity', () => {
  it('GitHub: github.com/o/r gives o/r; gitlab.com and a local path give nothing (two each way)', () => {
    expect(githubPlaceOf('github.com/aligndottech/align-stack')).toBe('aligndottech/align-stack');
    expect(githubPlaceOf('github.com/o/r')).toBe('o/r');
    expect(githubPlaceOf('gitlab.com/g/p')).toBeUndefined();
    expect(githubPlaceOf('/home/me/code/proj')).toBeUndefined();
    expect(githubPlaceOf(null)).toBeUndefined();
  });

  it('GitLab: gitlab.com/g/sub/p gives g/sub/p; github.com and a local path give nothing', () => {
    expect(gitlabPlaceOf('gitlab.com/g/sub/p')).toBe('g/sub/p');
    expect(gitlabPlaceOf('gitlab.com/g/p')).toBe('g/p');
    expect(gitlabPlaceOf('github.com/o/r')).toBeUndefined();
    expect(gitlabPlaceOf('C:\\code\\proj')).toBeUndefined();
    expect(gitlabPlaceOf(null)).toBeUndefined();
  });
});
