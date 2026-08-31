import { describe, expect, it } from 'vitest';
import {
  canRunSecretFreeOAuth,
  supportsSecretFreeOAuth,
} from '../lib/secret-free-oauth.js';
import { PUBLIC_CLIENT_IDS } from '../lib/public-client-ids.js';

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
  it('separates "the provider allows it" from "we can do it today"', () => {
    // github's provider supports device flow; our App does not exist yet.
    expect(supportsSecretFreeOAuth('github')).toBe(true);
    expect(PUBLIC_CLIENT_IDS.github.value).toBeNull();
    expect(canRunSecretFreeOAuth('github')).toBe(false);
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
