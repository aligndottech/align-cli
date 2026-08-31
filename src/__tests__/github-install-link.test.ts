import { describe, expect, it } from 'vitest';
import { githubInstallUrl } from '../lib/public-client-ids.js';

describe('githubInstallUrl', () => {
  it('builds the install link from the committed slug', () => {
    expect(githubInstallUrl({}, { github: { value: 'x', slug: 'align-cli' } }))
      .toBe('https://github.com/apps/align-cli/installations/new');
  });

  it('lets an environment override win, for a differently-named app', () => {
    // Distinct values on purpose: equal ones cannot tell precedence apart.
    expect(githubInstallUrl(
      { ALIGN_GITHUB_APP_SLUG: 'other-app' },
      { github: { value: 'x', slug: 'align-cli' } },
    )).toBe('https://github.com/apps/other-app/installations/new');
  });

  it('returns null rather than guessing when no slug is known', () => {
    // #196's lesson: a fabricated slug builds a plausible 404, and the user cannot
    // tell whether the app or their org is at fault. No link beats a wrong one.
    expect(githubInstallUrl({}, { github: { value: null, pending: 'no app' } })).toBeNull();
  });

  it('ignores an empty override instead of building /apps//installations/new', () => {
    expect(githubInstallUrl(
      { ALIGN_GITHUB_APP_SLUG: '' },
      { github: { value: 'x', slug: 'align-cli' } },
    )).toBe('https://github.com/apps/align-cli/installations/new');
  });
});
