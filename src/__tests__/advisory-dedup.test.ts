import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupScope, markSurfaced, MAX_MARKER_FILES, recentlySurfaced, SESSION_DEDUP_TTL_MS } from '../lib/advisory-dedup.js';
import { privateTmpDir } from '../lib/advisory-verdict.js';

const BASE_TMP = tmpdir();

// Unique cwd per test so the per-dir marker files never collide.
const dirs: string[] = [];
function freshCwd(): string {
  const d = mkdtempSync(join(BASE_TMP, 'align-dedup-'));
  dirs.push(d);
  return d;
}

// Marker files live in tmpdir()/align-<uid>. Redirect the temp folder before each test so
// marker creation and overflow pruning never touch the developer's real per-user marker store.
beforeEach(() => {
  const tmp = freshCwd();
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  // The window exists so one edit's pre and post hooks do not repeat each other. Keyed on the folder
  // alone it also silenced a second session, or a subagent, working in the same checkout: seen on a
  // real run, session B got nothing for 20 seconds after session A was told.
  it('a second session in the same folder is told what the first was told', () => {
    const cwd = freshCwd();
    const now = 4_000_000;
    markSurfaced(dedupScope(cwd, 'session-a'), ['d-1'], now);
    expect(recentlySurfaced(dedupScope(cwd, 'session-b'), now + 1_000).has('d-1')).toBe(false);
    // Control: the same session still gets its pre and post hooks deduplicated.
    expect(recentlySurfaced(dedupScope(cwd, 'session-a'), now + 1_000).has('d-1')).toBe(true);
  });

  it('with no session id from the host, the folder is the scope, as before', () => {
    const cwd = freshCwd();
    const now = 5_000_000;
    markSurfaced(dedupScope(cwd, undefined), ['d-1'], now);
    expect(recentlySurfaced(cwd, now + 1_000).has('d-1')).toBe(true);
    expect(recentlySurfaced(cwd, now + 25_000).has('d-1')).toBe(false);
    expect(dedupScope(cwd, '')).toBe(cwd);
  });

  // Real sessions pause 40-600s between edits while the agent thinks or runs tests. Once a host
  // names its session, keeping the mark across turns stops repeating the same decision on every
  // edit in that session, without silencing any other session in the same folder.
  it('keeps session-scoped marks across multi-minute turns and expires them after the session TTL', () => {
    const cwd = freshCwd();
    const scope = dedupScope(cwd, 'session-long');
    const now = 6_000_000;
    markSurfaced(scope, ['d-1'], now);
    expect(recentlySurfaced(scope, now + 120_000).has('d-1')).toBe(true);
    expect(recentlySurfaced(scope, now + 30 * 60_000).has('d-1')).toBe(true);
    expect(recentlySurfaced(scope, now + SESSION_DEDUP_TTL_MS + 1_000).has('d-1')).toBe(false);
    // A second session in the same folder is still unaffected inside the session window.
    expect(recentlySurfaced(dedupScope(cwd, 'session-other'), now + 120_000).has('d-1')).toBe(false);
  });

  // Every unique session id hashes to its own marker file in privateTmpDir(); without a sweep,
  // long-running machines accumulate orphaned advisory-*.json files without bound.
  it('bounds advisory marker files in privateTmpDir across many sessions', () => {
    const cwd = freshCwd();
    const base = 10_000_000;
    const total = MAX_MARKER_FILES + 44;
    for (let i = 0; i < total; i++) {
      markSurfaced(dedupScope(cwd, `sweep-session-${i}`), ['d-1'], base + i * 1_000);
    }
    const dir = privateTmpDir();
    expect(dir).not.toBeNull();
    const markers = readdirSync(dir!).filter((f) => f.startsWith('advisory-') && f.endsWith('.json'));
    expect(markers.length).toBeLessThanOrEqual(MAX_MARKER_FILES);
    // The newest session's marker survived the sweep.
    expect(recentlySurfaced(dedupScope(cwd, `sweep-session-${total - 1}`), base + total * 1_000).has('d-1')).toBe(true);
  });

  it('reaps expired 20s folder markers before evicting an older live session marker', () => {
    const base = 20_000_000;
    const sessionScope = dedupScope('/repo/live-session', 'sess-1');
    markSurfaced(sessionScope, ['d-keep'], base);

    // 255 folder-only markers written 30s later (each has a 20s TTL).
    for (let i = 0; i < MAX_MARKER_FILES - 1; i++) {
      markSurfaced(`/repo/folder-only-${i}`, ['d-short'], base + 30_000);
    }

    // At +60s all 255 folder markers are expired (age 30s > 20s), while the older session
    // marker (age 60s < 60m) is still live and must survive the overflow sweep.
    markSurfaced(dedupScope('/repo/trigger', 'sess-trigger'), ['d-new'], base + 60_000);

    expect(recentlySurfaced(sessionScope, base + 60_000).has('d-keep')).toBe(true);
    const dir = privateTmpDir()!;
    const markers = readdirSync(dir).filter((f) => f.startsWith('advisory-') && f.endsWith('.json'));
    expect(markers).toHaveLength(2);
  });
});
