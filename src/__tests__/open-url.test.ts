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

  it('treats a clean early exit as success (some openers hand off and exit 0)', async () => {
    const child = fakeChild();
    const opener = vi.fn().mockResolvedValue(child);
    const pending = tryOpenUrl('https://x', opener, 400);
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 0, null);
    await expect(pending).resolves.toBe(true);
  });
});
