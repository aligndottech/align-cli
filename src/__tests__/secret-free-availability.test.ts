import { describe, expect, it } from 'vitest';
import {
  canRunSecretFreeOAuth,
  supportsSecretFreeOAuth,
} from '../lib/secret-free-oauth.js';
import { pendingConnectors, PUBLIC_CLIENT_IDS } from '../lib/public-client-ids.js';

/**
 * Two different questions, which setup's copy conflated into one and got wrong.
 *
 *   supports  - the PROVIDER offers a secret-free flow. Permanent. Notion and
 *               Atlassian never will, because their exchange mandates a secret.
 *   canRun    - WE can run it here, which additionally needs a shipped client id.
 *
 * The printed split used `supports`, so it told the user GitHub/GitLab/Linear would
 * not ask for a paste, and then asked for one - the failure being that the reason it
 * had already committed to was the provider's design, when the real reason was ours.
 */
describe('secret-free availability', () => {
  // Fixtures, not the live map. The first version of this test used github as its
  // example of "supported but our app is missing", so it went red the moment github's
  // App shipped - punishing the good outcome and training the next person to edit the
  // test rather than read it. The LOGIC is what belongs here; the live data gets its
  // own assertion below, which is meant to change deliberately.
  const SHIPPED = { gitlab: { value: 'an-id' } } as Record<string, { value: string | null }>;
  const PENDING = { gitlab: { value: null, pending: 'no app yet' } } as Record<
    string,
    { value: string | null; pending?: string }
  >;

  it('separates "the provider allows it" from "we can do it today"', () => {
    // Same connector, same provider support, opposite answers - so the only thing
    // under test is whether an id is available.
    expect(supportsSecretFreeOAuth('gitlab')).toBe(true);
    expect(canRunSecretFreeOAuth('gitlab', {}, PENDING)).toBe(false);
    expect(canRunSecretFreeOAuth('gitlab', {}, SHIPPED)).toBe(true);
  });

  it('records which connectors are live today, and which are still waiting', () => {
    // A deliberate snapshot of the live map, not logic. Update it when an app ships;
    // if it fails unexpectedly, an id changed and someone should know why.
    const live = Object.keys(PUBLIC_CLIENT_IDS).filter((id) => canRunSecretFreeOAuth(id));
    const waiting = pendingConnectors().map((p) => p.id).sort();
    expect(live).toEqual(['github']);
    expect(waiting).toEqual(['gitlab', 'linear', 'zoom']);
  });

  it('never claims we can run one the provider does not offer', () => {
    for (const id of ['notion', 'jira', 'confluence', 'slack', 'teams']) {
      expect(supportsSecretFreeOAuth(id)).toBe(false);
      expect(canRunSecretFreeOAuth(id)).toBe(false);
    }
  });

  it('becomes runnable as soon as a client id is available', () => {
    // The day an id lands, this flips with no other edit. Proven by the override
    // rather than by waiting, so the wiring is pinned now instead of on that day.
    expect(canRunSecretFreeOAuth('gitlab', { ALIGN_GITLAB_PUBLIC_CLIENT_ID: 'x' })).toBe(true);
    expect(canRunSecretFreeOAuth('gitlab', {})).toBe(false);
  });

  it('stays false for an unsupported provider even with an id set', () => {
    // A stray env var must not conjure a flow the provider cannot complete.
    expect(canRunSecretFreeOAuth('notion', { ALIGN_NOTION_PUBLIC_CLIENT_ID: 'x' })).toBe(false);
  });
});
