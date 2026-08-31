import { describe, expect, it } from 'vitest';
import { SECRET_FREE_CONNECTORS } from '../lib/secret-free-oauth.js';

/**
 * True local mode's one promise is that nothing leaves the machine. The secret-free
 * flows exist to keep that true while still offering a real sign-in (ALI-778).
 *
 * Asserted on the URLs themselves rather than by reading the code, because the
 * failure mode is a single endpoint quietly pointing at api.align.tech - which looks
 * completely normal in a diff.
 */
describe('the secret-free flows never call Align', () => {
  const ALIGN_HOSTS = /align\.tech|localhost:8080|127\.0\.0\.1:8080/i;

  it('sends every request straight to the provider', () => {
    for (const [id, cfg] of Object.entries(SECRET_FREE_CONNECTORS)) {
      for (const url of [cfg.authorizeUrl, cfg.deviceCodeUrl, cfg.tokenUrl]) {
        if (!url) continue;
        expect(url, `${id} -> ${url}`).not.toMatch(ALIGN_HOSTS);
        expect(url, `${id} -> ${url}`).toMatch(/^https:\/\//);
      }
    }
  });

  it('points each connector at its own provider, not a shared broker', () => {
    // Positive control: proves the check above is reading real, distinct hosts
    // rather than passing over an empty or uniform set.
    const hosts = Object.values(SECRET_FREE_CONNECTORS).map((c) => new URL(c.tokenUrl).hostname);
    expect(hosts).toContain('github.com');
    expect(hosts).toContain('gitlab.com');
    expect(new Set(hosts).size).toBeGreaterThan(1);
  });

  it('carries no client secret in any configured field', () => {
    const blob = JSON.stringify(SECRET_FREE_CONNECTORS);
    expect(blob).not.toMatch(/client_secret|clientSecret/i);
  });
});
