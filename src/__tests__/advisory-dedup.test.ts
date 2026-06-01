import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markSurfaced, recentlySurfaced } from '../lib/advisory-dedup.js';

// Unique cwd per test so the per-dir marker files never collide.
const dirs: string[] = [];
function freshCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'align-dedup-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('advisory dedup', () => {
  it('returns ids marked within the window', () => {
    const cwd = freshCwd();
    const now = 1_000_000;
    markSurfaced(cwd, ['d-1', 'd-2'], now);
    const seen = recentlySurfaced(cwd, now + 5_000);
    expect(seen.has('d-1')).toBe(true);
    expect(seen.has('d-2')).toBe(true);
  });

  it('expires marks after the TTL', () => {
    const cwd = freshCwd();
    const now = 2_000_000;
    markSurfaced(cwd, ['d-1'], now);
    expect(recentlySurfaced(cwd, now + 25_000).has('d-1')).toBe(false);
  });

  it('keeps marks isolated per project dir', () => {
    const a = freshCwd();
    const b = freshCwd();
    const now = 3_000_000;
    markSurfaced(a, ['d-1'], now);
    expect(recentlySurfaced(b, now).has('d-1')).toBe(false);
  });

  it('merges ids across runs inside the window', () => {
    const cwd = freshCwd();
    const now = 4_000_000;
    markSurfaced(cwd, ['d-1'], now);
    markSurfaced(cwd, ['d-2'], now + 1_000);
    const seen = recentlySurfaced(cwd, now + 2_000);
    expect(seen.has('d-1')).toBe(true);
    expect(seen.has('d-2')).toBe(true);
  });
});
