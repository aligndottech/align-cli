import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, ROOT, startHarness } from './helpers/share-harness.js';

/**
 * ALI-1540, the real binary against a fake gateway on loopback (the gateway side is a contract, not the real routes):
 * - inside an agent align launched (ALIGN_WRAPPED), `align share` stages, waits, and completes after approval: no typed answer, no
 *   direct post to /ingest/batch, and the key is in no request.
 * - `required` refuses --typed in the real command line, with nothing staged.
 * - a real Ctrl-C (SIGINT) while waiting cancels the request on the gateway and exits 130.
 * POSIX only: the harness spawns the tsx shim.
 */
vi.setConfig({ testTimeout: 90_000 });
const posix = process.platform !== 'win32';
let h: Harness;
beforeAll(async () => {
  if (!posix) return;
  h = await startHarness((db) => {
    const id = db.insertDecision({ title: 'Use sqlite for the cache', summary: 'sqlite ships with node', sourceUrl: 'https://github.com/o/r/pull/12', platform: 'github' });
    db.markRatified(id, 'me@acme.test');
    return [id];
  });
});
afterAll(async () => { await h?.close(); });

const reset = (mode: 'off' | 'available' | 'required' | null, states: string[]): void => {
  h.posts.length = 0; h.requests.length = 0; h.share.staged.length = 0; h.share.mode = mode; h.share.states = states;
};

describe.skipIf(!posix)('browser approval through the real command', () => {
  it('from inside an agent: stages, sees the approval, completes, and never posts directly or prompts', async () => {
    reset('available', ['approved']);
    const r = await h.plain([h.ids[0]!, '--no-open'], { ALIGN_WRAPPED: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Approve in your browser: ');
    expect(r.out).toContain('#k=');
    expect(r.out).toContain('Code: KJ4M-9XQT');
    expect(r.out).toContain('created: R0');
    expect(h.requests.map((q) => `${q.method} ${q.url.replace(/[0-9a-f-]{36}/, ':id')}`)).toEqual([
      'GET /share-requests/config', 'POST /share-requests', 'GET /share-requests/:id', 'POST /share-requests/:id/complete',
    ]);
    expect(h.posts.filter((p) => p.url === '/ingest/batch')).toHaveLength(0);
    const key = /#k=([A-Za-z0-9_-]{43})/.exec(r.out)![1]!;
    expect(h.requests.map((q) => q.url + q.body).join('\n')).not.toContain(key);
    expect(h.requests.every((q) => q.auth === 'Bearer tok')).toBe(true);
  });
  it('required: --typed is refused on the real command line and nothing is staged', async () => {
    reset('required', ['approved']);
    const r = await h.plain([h.ids[0]!, '--typed']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('requires approval in your browser');
    expect(h.share.staged).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });
  it('a real Ctrl-C while waiting cancels the request and exits 130', async () => {
    reset('available', ['pending']);
    const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/index.ts'), 'share', h.ids[0]!, '--no-open'], { detached: true, env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const waiting = new Promise<void>((resolve) => { const on = (b: Buffer): void => { out += b; if (out.includes('Waiting for your approval')) resolve(); }; p.stdout!.on('data', on); p.stderr!.on('data', on); });
    const closed = new Promise<number | null>((resolve) => p.on('close', (c) => resolve(c)));
    await waiting;
    process.kill(-p.pid!, 'SIGINT');
    expect(await closed).toBe(130);
    expect(out).toContain('Cancelled the request. Nothing was sent.');
    expect(h.requests.some((q) => q.method === 'POST' && q.url.endsWith('/cancel'))).toBe(true);
    expect(h.requests.some((q) => q.url.endsWith('/complete'))).toBe(false);
  });
});
