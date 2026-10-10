import { afterAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { canPty, type Harness, startHarness } from './helpers/share-harness.js';

/**
 * macOS keeps config and data under HOME/Library/..., not XDG_*, and the CI macOS leg failed 5 share tests because the
 * fixtures seeded an XDG-shaped path the binary never read. This simulates that layout on any POSIX host (XDG_* unset in
 * the child, process.platform = darwin via a preload) and pins both halves:
 * - seeding where THE PRODUCT says (its own path helpers, asked in a child with the child's env) is found by the binary;
 * - seeding at the Linux XDG guess is NOT found (the control that proves this test can fail, i.e. the old fixture bug).
 * The simulation proves path handling only; pty behaviour on a real macOS is not exercised here.
 */
vi.setConfig({ testTimeout: 90_000 });
const posix = process.platform !== 'win32';
const harnesses: Harness[] = [];
afterAll(async () => { for (const h of harnesses) await h.close(); });
const seed = (db: { insertDecision: (r: Record<string, unknown>) => string; markRatified: (id: string, by: string) => unknown }) => {
  const id = db.insertDecision({ title: 'Use sqlite', summary: 'because node', sourceUrl: 'https://github.com/o/r/pull/12', platform: 'github' });
  db.markRatified(id, 'me@acme.test');
  return [id];
};

describe.skipIf(!posix)('the macOS layout (simulated)', () => {
  it('the product puts the graph under HOME/Library/Preferences, not XDG', async () => {
    const h = await startHarness(seed as never, { simulateMac: true }); harnesses.push(h);
    expect(h.dbPath).toBe(path.join(h.dir, 'Library', 'Preferences', 'align-cli', 'local.db'));
    expect(h.env['XDG_CONFIG_HOME']).toBeUndefined();
  });
  it('a share finds the graph it was seeded into by the product helper', async () => {
    const h = await startHarness(seed as never, { simulateMac: true }); harnesses.push(h);
    const r = await h.plain([h.ids[0]!]);
    expect(r.out).toContain('Confirm this in your own terminal');
    expect(r.out).not.toContain('no local graph');
  });
  it('control: a graph seeded at the Linux XDG guess is not found, exactly the failure macOS CI showed', async () => {
    const h = await startHarness(seed as never, { simulateMac: true, seedAtXdgGuess: true }); harnesses.push(h);
    const r = await h.plain([h.ids[0]!]);
    expect(r.out).toContain('There is no local graph');
  });
  it.skipIf(!canPty)('and a real pty share with y sends once under that layout', async () => {
    const h = await startHarness(seed as never, { simulateMac: true }); harnesses.push(h);
    const r = await h.pty([h.ids[0]!], [['[y/N]', 'y\n']]);
    expect(r.code).toBe(0);
    expect(h.posts).toHaveLength(1);
  });
});
