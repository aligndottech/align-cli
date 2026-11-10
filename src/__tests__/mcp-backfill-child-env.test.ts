import { rmDir } from './helpers/rm-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const started = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../lib/backfill-state.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startBackfillChild: (...a: unknown[]) => { started.calls.push(a); return Promise.resolve({ ok: true, pid: 1 }); },
}));

import { defaultBackfillDeps } from '../lib/mcp-backfill.js';
import { currentRepoIdentitySync } from '../lib/repo-identity.js';
import { startSyncChild, syncChildEnv } from '../lib/sync/spawn-background.js';

/** L6 review: `align_backfill` and `align_sync run` children follow ONE env policy (the reduced one) and both are attributed to the agent. */
describe('the two MCP-started children', () => {
  afterEach(() => { vi.unstubAllEnvs(); started.calls.length = 0; });

  it('align_backfill\'s child gets the reduced env and caller mcp, with no secrets from this process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-bf-'));
    vi.stubEnv('XDG_STATE_HOME', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-planted');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_planted');
    try {
      await defaultBackfillDeps({ mode: 'local-embedded', localDbPath: path.join(dir, 'g.db') } as never).start('github', ['connect']);
      const call = started.calls[0]!;
      // The one addition is the repo the child was started for (ALIGN_SYNC_REPO, ALI-2089); everything else is the reduced env.
    const { ALIGN_SYNC_REPO: _repo, ...rest } = call[5] as Record<string, string>;
    expect(rest).toEqual(syncChildEnv(process.env));
      expect(Object.keys(call[5] as object)).not.toContain('ANTHROPIC_API_KEY');
      // The child runs from home, so it is told the repo (this checkout is one): without it the child resolves another scope than the person chose.
      const repo = currentRepoIdentitySync();
      expect(repo).not.toBeNull();
      expect((call[5] as Record<string, string>)['ALIGN_SYNC_REPO']).toBe(repo);
      expect(call[4]).toBe('mcp');
    } finally { rmDir(dir); }
  });

  it('align_sync run (startSyncChild with its defaults) is the same policy: reduced env, caller mcp', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_planted');
    await startSyncChild(['github']);
    const call = started.calls[0]!;
    // The one addition is the repo the child was started for (ALIGN_SYNC_REPO, ALI-2089); everything else is the reduced env.
    const { ALIGN_SYNC_REPO: _repo, ...rest } = call[5] as Record<string, string>;
    expect(rest).toEqual(syncChildEnv(process.env));
    expect(call[4]).toBe('mcp');
  });
});
