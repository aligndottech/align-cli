import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { tryOpenUrl } from '../lib/open-url.js';

function fakeChild(): EventEmitter & { pid?: number } {
  const c = new EventEmitter() as EventEmitter & { pid?: number };
  c.pid = 123;
  return c;
}

/**
 * open() resolves when the child SPAWNS; xdg-open's failure arrives afterwards as a
 * child exit nobody watches. So `await open(url).catch(...)` reports success for a
 * browser that never appeared - the 0.28.0 field report, on every connector.
 */
describe('tryOpenUrl', () => {
  it('reports failure when the opener exits non-zero just after spawning', async () => {
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    const pending = tryOpenUrl('https://x', opener, 400);
    // A real child exits via the event loop; emitting synchronously would race the
    // listener attachment that sits one microtask behind the opener await.
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 4, null);
    await expect(pending).resolves.toBe(false);
  });

  it('reports failure when spawning rejects outright', async () => {
    const opener = vi.fn().mockRejectedValue(new Error('xdg-open not found'));
    await expect(tryOpenUrl('https://x', opener, 400)).resolves.toBe(false);
  });

  it('reports failure on a child error event', async () => {
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    const pending = tryOpenUrl('https://x', opener, 400);
    await new Promise((r) => setImmediate(r));
    child.emit('error', new Error('ENOENT'));
    await expect(pending).resolves.toBe(false);
  });

  it('reports success when nothing fails within the grace window', async () => {
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    await expect(tryOpenUrl('https://x', opener, 50)).resolves.toBe(true);
  });

  it('treats signal termination as failure, not success', async () => {
    // The fixture for the side a review narrowing gave up (code === null used to
    // read as success): a signalled opener never completed a handoff.
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    const pending = tryOpenUrl('https://x', opener, 400);
    await new Promise((r) => setImmediate(r));
    child.emit('exit', null, 'SIGTERM');
    await expect(pending).resolves.toBe(false);
  });

  it('treats a clean early exit as success (some openers hand off and exit 0)', async () => {
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    const pending = tryOpenUrl('https://x', opener, 400);
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 0, null);
    await expect(pending).resolves.toBe(true);
  });

  it('an opener that resolves to no process (a mock, or an opener with no child) reads as not opened, and leaves no timer behind to throw later', async () => {
    vi.useFakeTimers();
    try {
      const answer = tryOpenUrl('https://example.com', async () => undefined as never, 400);
      // Nothing to watch, so nothing says the browser opened: the caller warns and prints the link, as before.
      await expect(answer).resolves.toBe(false);
      // The bug: a 400 ms timer was left running and threw `removeListener` of undefined outside any test.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

