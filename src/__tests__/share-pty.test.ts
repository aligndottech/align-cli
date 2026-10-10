import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPromotion } from '../lib/share/ledger.js';
import { canPty, type Harness, startHarness } from './helpers/share-harness.js';

/**
 * L9 security review, item 1 and 6: who can complete a share.
 * - `align share <id> --yes` with stdin from /dev/null exits non-zero and makes ZERO POSTs (--yes does not exist).
 * - With no controlling terminal (own session, stdin /dev/null) a plain `align share <id>` exits 1, zero POSTs.
 * - POSITIVE CONTROL: on a real pty, typing y sends exactly once and the process exits 0 with no EBADF; typing n sends nothing.
 * - The team-text question is its own question: the first y does not answer it; a second n leaves one POST, a second y makes two.
 *   The process exits cleanly even though the terminal's input is left open.
 */
vi.setConfig({ testTimeout: 90_000 });
let h: Harness;
beforeAll(async () => {
  if (!posix) return;
  h = await startHarness((db) => {
    const id = db.insertDecision({ title: 'Use sqlite for the cache', summary: 'sqlite ships with node', sourceUrl: 'https://github.com/o/r/pull/12', platform: 'github' });
    db.markRatified(id, 'me@acme.test');
    const id2 = db.insertDecision({ title: 'Second decision', summary: 'another one', sourceUrl: 'https://github.com/o/r/pull/13', platform: 'github' });
    db.markRatified(id2, 'me@acme.test');
    const id3 = db.insertDecision({ title: 'No url decision', summary: 'kept local', sourceUrl: null, platform: 'cli' });
    db.markRatified(id3, 'me@acme.test');
    return [id, id2, id3];
  });
});
afterAll(async () => { await h?.close(); });

// POSIX only: the harness spawns the tsx shim and a python pty. The Windows console path is unit-tested in share-tty.test.ts.
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('with no person at a terminal', () => {
  it('--yes is not accepted: non-zero exit, zero POSTs', async () => {
    const r = await h.plain([h.ids[0]!, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no --yes');
    expect(h.posts).toHaveLength(0);
  });
  it('a plain share with no controlling terminal exits 1 and sends nothing', async () => {
    const r = await h.plain([h.ids[0]!]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Confirm this in your own terminal');
    expect(h.posts).toHaveLength(0);
  });
});

describe.skipIf(!posix)('inside an agent align launched', () => {
  it('ALIGN_WRAPPED makes the real binary refuse with a pointer to a normal terminal and no request', async () => {
    const r = await h.plain([h.ids[0]!], { ALIGN_WRAPPED: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('normal terminal');
    expect(h.posts).toHaveLength(0);
  });
});

describe.skipIf(!posix)('an unknown --env', () => {
  it('is refused with exit 2 and no request, never falling back to the default environment', async () => {
    for (const env of ['prd', 'local', '']) {
      const r = await h.plain([h.ids[0]!, '--env', env]);
      expect(r.code).toBe(2);
      expect(r.out).toContain('Unknown environment');
    }
    expect(h.posts).toHaveLength(0);
  });
});

describe.skipIf(!canPty)('on a real pseudo-terminal', () => {
  it('n sends nothing; y sends once and exits 0 with no EBADF', async () => {
    const no = await h.pty([h.ids[0]!], [['[y/N]', 'n\n']]);
    expect(no.code).toBe(0);
    expect(h.posts).toHaveLength(0);
    const yes = await h.pty([h.ids[0]!], [['[y/N]', 'y\n']]);
    expect(yes.code).toBe(0);
    expect(yes.out).not.toMatch(/EBADF/);
    expect(yes.out).toContain('To: Acme');
    expect(h.posts).toHaveLength(1);
  });
  it('the team-text question gets its own answer', async () => {
    const matched = (needs: boolean) => ({
      matched: [{ request_index: 0, existing_id: 'TEAM1', status: 'active', team_text_hash: 'a'.repeat(64), ...(needs ? { needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] } : {}) }],
      judgements: [{ request_index: 0, decision_id: 'TEAM1', results: [{ ok: !needs, ...(needs ? { error: 'needs_confirmation' } : { stored: true }) }] }],
    });
    h.posts.length = 0;
    h.reply.batch = () => matched(h.posts.length === 1);
    const decline = await h.pty([h.ids[1]!], [['[y/N]', 'y\n'], ['stand behind the team', 'n\n']]);
    expect(decline.code).toBe(0);
    expect(decline.out).not.toMatch(/EBADF/);
    expect(h.posts).toHaveLength(1);
    h.posts.length = 0;
    const agree = await h.pty([h.ids[1]!], [['[y/N]', 'y\n'], ['stand behind the team', 'y\n']]);
    expect(agree.code).toBe(0);
    expect(h.posts).toHaveLength(2);
  });
});

describe.skipIf(!canPty)('the real binary and the private share salt', () => {
  it('shares a decision with no URL without the local id anywhere in the body, using the salt file (not the install id)', async () => {
    h.posts.length = 0;
    h.reply.batch = (n: number) => ({ snapshots: Array.from({ length: n }, (_, i) => ({ id: `N${i}`, request_index: i, is_new: true })) }); // an earlier test left a matched reply here
    const r = await h.pty([h.ids[2]!], [['[y/N]', 'y\n']]);
    expect(r.code).toBe(0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.body).not.toContain(h.ids[2]!);
    expect(h.posts[0]!.body).toMatch(/align-local:\/\/decision\/[0-9a-f]{32}/);
    const fs = await import('node:fs'); const path = await import('node:path');
    const salt = fs.readFileSync(path.join(h.stateDir, 'share-salt'), 'utf8');
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(h.posts[0]!.body).not.toContain(salt);
  });
});

describe.skipIf(!canPty)('align local reset', () => {
  it('wipes the graph but keeps the record of what was shared, so a share stays retractable', async () => {
    const id = h.ids[0]!;
    if (getPromotion(h.dbPath, id, 'prod', 'T1') === null) await h.pty([id], [['[y/N]', 'y\n']]);
    expect(getPromotion(h.dbPath, id, 'prod', 'T1')).not.toBeNull();
    const r = await h.ptyAlign(['local', 'reset'], [['Continue', 'y\r']]);
    expect(r.out).toContain('Kept your record of');
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(h.dbPath);
    expect((d.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n).toBe(0);
    d.close();
    expect(getPromotion(h.dbPath, id, 'prod', 'T1')).toMatchObject({ remoteId: 'R0' });
  });
});
