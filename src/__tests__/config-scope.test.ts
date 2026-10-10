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

describe('team scope disclosure', () => {
  it('is false until marked, then true for that source only, and marking twice stores it once', () => {
    const c = createConfigStore();
    expect(c.isTeamScopeDisclosed('github')).toBe(false);
    c.markTeamScopeDisclosed('github');
    c.markTeamScopeDisclosed('github');
    expect(c.isTeamScopeDisclosed('github')).toBe(true);
    expect(c.isTeamScopeDisclosed('jira')).toBe(false);
    expect(c.getTeamScopeDisclosedFor()).toEqual(['github']);
  });
});
