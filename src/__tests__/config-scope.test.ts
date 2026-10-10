import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) {
        this.defaults = opts.defaults ?? {};
        store = JSON.parse(JSON.stringify(this.defaults));
      }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = JSON.parse(JSON.stringify(this.defaults)); }
    },
  };
});

/**
 * L4 Test List (where a chosen scope lives):
 * - A source's chosen scope is stored beside its token (non-secret), and read back as it was written: a team choice with its
 *   values and the labels people read, or an explicit "yours".
 * - It is owned by the connector: `align local forget` (one source or all) removes it with the token.
 * - It never reaches a fetch as a credential field: getConnectorFields is unchanged by it.
 * - A damaged entry reads as "no choice" (the narrower scope), never as a guess at a wider one.
 * - "Disclosed" is remembered per source, once.
 */
describe('connector scope storage', () => {
  beforeEach(() => { createConfigStore().forgetAllConnectors('local'); });

  it('reads null until a choice is saved, then returns it as written (two examples)', () => {
    const c = createConfigStore();
    expect(c.getConnectorScope('local', 'jira')).toBeNull();
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['ALI', 'OPS'], labels: ['ALI', 'OPS'] });
    expect(c.getConnectorScope('local', 'jira')).toEqual({ kind: 'team', values: ['ALI', 'OPS'], labels: ['ALI', 'OPS'] });
    c.setConnectorScope('local', 'github', { kind: 'yours' });
    expect(c.getConnectorScope('local', 'github')).toEqual({ kind: 'yours' });
    expect(c.getConnectorScope('local', 'linear')).toBeNull();
  });

  it('keeps a Linear choice as ids with the team keys people read', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'linear', { kind: 'team', values: ['uuid-1'], labels: ['ENG'] });
    expect(c.getConnectorScope('local', 'linear')).toEqual({ kind: 'team', values: ['uuid-1'], labels: ['ENG'] });
  });

  it('clearConnectorScope removes only that source', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    c.setConnectorScope('local', 'linear', { kind: 'team', values: ['x'], labels: ['ENG'] });
    c.clearConnectorScope('local', 'jira');
    expect(c.getConnectorScope('local', 'jira')).toBeNull();
    expect(c.getConnectorScope('local', 'linear')).not.toBeNull();
  });

  it('forgetting the connector removes its scope with its token; forgetting all removes every scope', () => {
    const c = createConfigStore();
    c.saveConnectorFields('local', 'jira', { token: 't', email: 'e', domain: 'd.atlassian.net' });
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    c.setConnectorScope('local', 'linear', { kind: 'team', values: ['x'], labels: ['ENG'] });
    c.forgetConnector('local', 'jira');
    expect(c.getConnectorScope('local', 'jira')).toBeNull();
    expect(c.getConnectorScope('local', 'linear')).not.toBeNull();
    c.forgetAllConnectors('local');
    expect(c.getConnectorScope('local', 'linear')).toBeNull();
  });

  it('never appears among the connector fields a fetch is handed (token stays a token)', () => {
    const c = createConfigStore();
    c.saveConnectorFields('local', 'jira', { token: 't', email: 'e', domain: 'd.atlassian.net' });
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    expect(c.getConnectorFields('local', 'jira')).toEqual({ token: 't', email: 'e', domain: 'd.atlassian.net' });
  });

  it('is per environment', () => {
    const c = createConfigStore();
    c.setConnectorScope('local', 'jira', { kind: 'team', values: ['ALI'], labels: ['ALI'] });
    expect(c.getConnectorScope('prod', 'jira')).toBeNull();
  });

  it('a PRESENT but unreadable entry reads as yours (never as no choice, which widens GitHub from the folder); absent stays null', () => {
    const c = createConfigStore();
    for (const bad of ['not json', '{"kind":"everyone"}', '{"kind":"team","values":"ALI","labels":["ALI"]}', '{"kind":"team","values":[],"labels":[]}']) {
      c.setConnectorToken('local', 'jira:scope', bad);
      expect(c.getConnectorScope('local', 'jira'), bad).toEqual({ kind: 'yours' });
    }
    expect(c.getConnectorScope('local', 'linear')).toBeNull();
  });
});

describe('what was told is forgotten with the connector', () => {
  it('forgetting a connector forgets its told scopes only; forgetting all forgets every one; clearing one source leaves the others', () => {
    const c = createConfigStore();
    c.markTeamScopeDisclosed('jira', 'jira:ALI');
    c.markTeamScopeDisclosed('jira', 'jira:OPS');
    c.markTeamScopeDisclosed('github', 'repo:o/r');
    c.forgetConnector('local', 'jira');
    expect(c.getTeamScopeDisclosedFor()).toEqual(['github|repo:o/r']);
    c.markTeamScopeDisclosed('linear', 'linear:ENG');
    c.clearTeamScopeDisclosed('github');
    expect(c.getTeamScopeDisclosedFor()).toEqual(['linear|linear:ENG']);
    c.forgetAllConnectors('local');
    expect(c.getTeamScopeDisclosedFor()).toEqual([]);
  });

  it('a prefix of another source name is not swept (a source named like another\'s start)', () => {
    const c = createConfigStore();
    c.markTeamScopeDisclosed('git', 'x');
    c.markTeamScopeDisclosed('github', 'repo:o/r');
    c.clearTeamScopeDisclosed('git');
    expect(c.getTeamScopeDisclosedFor()).toEqual(['github|repo:o/r']);
  });
});

describe('team scope disclosure', () => {
  it('is false until marked, then true for that source and scope only, and marking twice stores it once', () => {
    const c = createConfigStore();
    expect(c.isTeamScopeDisclosed('github', 'repo:o/r')).toBe(false);
    c.markTeamScopeDisclosed('github', 'repo:o/r');
    c.markTeamScopeDisclosed('github', 'repo:o/r');
    expect(c.isTeamScopeDisclosed('github', 'repo:o/r')).toBe(true);
    // Per (source, scope): another repo, and another source, are not told yet.
    expect(c.isTeamScopeDisclosed('github', 'repo:o/other')).toBe(false);
    expect(c.isTeamScopeDisclosed('jira', 'repo:o/r')).toBe(false);
    expect(c.getTeamScopeDisclosedFor()).toEqual(['github|repo:o/r']);
  });
});
