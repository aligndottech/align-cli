import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ args: string[]; opts: { timeout?: number } }>);
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<object>()),
  execFileSync: (_cmd: string, args: string[], opts: { timeout?: number }) => { calls.push({ args, opts }); throw new Error('git hung'); },
}));

import { currentRepoIdentitySync } from '../lib/repo-identity.js';

/** The synchronous git read is bounded: a hung git cannot hang the scope store, and a failure is still null. */
describe('currentRepoIdentitySync', () => {
  beforeEach(() => { calls.length = 0; });
  it('gives every git call a few-second timeout, and a failed call is null', () => {
    expect(currentRepoIdentitySync({ cwd: '/x' })).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.opts.timeout).toBeGreaterThan(0);
      expect(c.opts.timeout).toBeLessThanOrEqual(10_000);
    }
  });
});
