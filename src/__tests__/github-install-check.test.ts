import { describe, expect, it, vi } from 'vitest';
import { checkGithubAppInstallation } from '../lib/github-install-check.js';

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => body } as unknown as Response);

describe('checkGithubAppInstallation', () => {
  it('reports installed when the App is on at least one account', async () => {
    const fetchFn = ok({ total_count: 1, installations: [{ account: { login: 'aligndottech' } }] });
    const r = await checkGithubAppInstallation('tok', fetchFn);
    expect(r.installed).toBe(true);
    expect(r.accounts).toEqual(['aligndottech']);
  });

  it('reports NOT installed when authorized but installed nowhere', async () => {
    // The failure this whole check exists for: the device flow succeeded, the token
    // is valid, and it can see no repositories at all. Distinct from an error.
    const r = await checkGithubAppInstallation('tok', ok({ total_count: 0, installations: [] }));
    expect(r.installed).toBe(false);
    expect(r.errored).toBe(false);
  });

  it('sends the token, and asks GitHub for installations', async () => {
    const fetchFn = ok({ total_count: 0, installations: [] });
    await checkGithubAppInstallation('tok-abc', fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/user/installations');
    expect(init.headers.Authorization).toBe('Bearer tok-abc');
  });

  it('treats a failed request as UNKNOWN, never as not-installed', async () => {
    // Fail open on the advisory check: a network blip must not tell a user their
    // org has vetoed them. errored=true suppresses the guidance entirely.
    const r = await checkGithubAppInstallation('tok', vi.fn().mockRejectedValue(new Error('boom')));
    expect(r.errored).toBe(true);
    expect(r.installed).toBe(true);
  });

  it('treats a non-2xx as UNKNOWN too', async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const r = await checkGithubAppInstallation('tok', bad);
    expect(r.errored).toBe(true);
    expect(r.installed).toBe(true);
  });
});
