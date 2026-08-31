import { describe, expect, it } from 'vitest';
import { githubVariants, SECRET_FREE_CONNECTORS } from '../lib/secret-free-oauth.js';

/**
 * GitHub is the one connector where read-only and no-admin-approval cannot both be
 * had, so true local ships BOTH and lets the user choose with the trade stated.
 *
 *   GitHub App   genuinely read-only (Contents/Issues/PRs: Read), but must be
 *                INSTALLED, and "the user or organization owner who installed the
 *                app can decide what repositories the app can access" - so on an org
 *                the user does not own, someone else holds a veto.
 *   OAuth App    no installation, "can access every repository that the user who
 *                authorized the app can access" - but `repo` is read AND write,
 *                because classic OAuth has no read-only-private equivalent.
 *
 * ALI-98 permits this for true local, amended 2026-08-31. What it actually prohibits
 * is a SILENT fallback - its GitHub finding was that github-personal "silently falls
 * back to the write bot App". Disclosed choice is a different thing.
 */
describe('githubVariants', () => {
  it('offers the read-only App first', () => {
    // Order is the recommendation. The App is the preferred path and must stay so;
    // the OAuth App exists for when installation is not possible.
    expect(githubVariants()[0]?.id).toBe('github-app');
  });

  it('marks the App read-only and the OAuth App write-capable, accurately', () => {
    const [app, oauth] = githubVariants();
    expect(app?.writeCapable).toBe(false);
    // Not a hedge: `repo` genuinely grants write. Claiming otherwise would be the
    // silent fallback ALI-98 prohibits, dressed up as a label.
    expect(oauth?.writeCapable).toBe(true);
  });

  it('gives the OAuth App a reason the user can act on', () => {
    const oauth = githubVariants().find((v) => v.id === 'github-oauth');
    expect(oauth?.tradeoff).toMatch(/install|admin|owner/i);
    expect(oauth?.tradeoff).toMatch(/write/i);
  });

  it('uses device flow for both, so neither needs a client secret', () => {
    for (const v of githubVariants()) expect(v.kind).toBe('device');
  });

  it('keeps the App variant as the connector default', () => {
    // SECRET_FREE_CONNECTORS.github is what runs when nobody chooses. It must be the
    // read-only one, so the safe path is what you get by not deciding.
    expect(SECRET_FREE_CONNECTORS['github']?.writeCapable).toBe(false);
  });
});
