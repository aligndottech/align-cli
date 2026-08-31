import { describe, expect, it } from 'vitest';
import {
  overrideVarFor,
  pendingConnectors,
  PUBLIC_CLIENT_IDS,
  resolveClientId,
} from '../lib/public-client-ids.js';
import { SECRET_FREE_CONNECTORS } from '../lib/secret-free-oauth.js';

describe('public client ids', () => {
  it('covers exactly the connectors that declare a secret-free flow', () => {
    // Two writers of one fact: SECRET_FREE_CONNECTORS says which connectors have a
    // secret-free flow, and this map says whether we can actually run it. A connector
    // added to one and not the other is the defect that made ALI-778 inert.
    expect(Object.keys(PUBLIC_CLIENT_IDS).sort()).toEqual(
      Object.keys(SECRET_FREE_CONNECTORS).sort(),
    );
  });

  it('requires a stated reason for every id that is not shipped', () => {
    // A null with no reason is how "nobody got round to it" becomes indistinguishable
    // from "this provider cannot support it".
    for (const [id, entry] of Object.entries(PUBLIC_CLIENT_IDS)) {
      if (entry.value === null) {
        expect(entry.pending, `${id} is unshipped and must say why`).toBeTruthy();
      } else {
        expect(entry.value, `${id} must not ship an empty id`).not.toBe('');
        expect(entry.pending, `${id} ships an id so must not be pending`).toBeUndefined();
      }
    }
  });

  // Every baked value is null today, so a fixture is REQUIRED here: asserting
  // against the real map would compare null to null and pass whether or not the
  // fallback works at all. The precedence is the behaviour under test, and it has
  // to stay pinned for the day the ids are populated.
  const SHIPPED = { gitlab: { value: 'baked-gitlab-id' } } as Record<
    string,
    { value: string | null; pending?: string }
  >;

  it('prefers the environment override over the baked id', () => {
    // Self-managed GitLab runs its own OAuth app, so the shipped id is wrong there.
    // The two values differ deliberately: equal ones cannot tell precedence apart.
    const r = resolveClientId(
      'gitlab',
      { ALIGN_GITLAB_PUBLIC_CLIENT_ID: 'self-hosted-id' },
      SHIPPED,
    );
    expect(r).toBe('self-hosted-id');
  });

  it('falls back to the baked id when no override is set', () => {
    expect(resolveClientId('gitlab', {}, SHIPPED)).toBe('baked-gitlab-id');
  });

  it('returns null for a connector with no secret-free flow at all', () => {
    expect(resolveClientId('notion', {})).toBeNull();
  });

  it('ignores an empty-string override rather than treating it as configured', () => {
    // `FOO= align setup` sets the variable to '', which must not read as "configured"
    // and produce an authorize URL with client_id=.
    expect(resolveClientId('gitlab', { ALIGN_GITLAB_PUBLIC_CLIENT_ID: '' }, SHIPPED))
      .toBe('baked-gitlab-id');
  });

  it('derives the override var name uniformly, with no per-connector exception', () => {
    expect(overrideVarFor('github')).toBe('ALIGN_GITHUB_PUBLIC_CLIENT_ID');
    expect(overrideVarFor('gitlab')).toBe('ALIGN_GITLAB_PUBLIC_CLIENT_ID');
    // Asserting the SHAPE for every member, not a spot check: a reintroduced
    // exception would pass a two-connector sample.
    for (const id of Object.keys(PUBLIC_CLIENT_IDS)) {
      expect(overrideVarFor(id)).toBe(`ALIGN_${id.toUpperCase()}_PUBLIC_CLIENT_ID`);
    }
  });

  it('lists every pending connector with its reason', () => {
    const pending = pendingConnectors();
    // Positive control: the map is populated, so an empty pending list would mean
    // "all shipped" rather than "the function found nothing".
    expect(Object.keys(PUBLIC_CLIENT_IDS).length).toBeGreaterThan(0);
    for (const p of pending) {
      expect(PUBLIC_CLIENT_IDS[p.id].value).toBeNull();
      expect(p.reason).toBeTruthy();
    }
  });
});
