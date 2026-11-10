import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteSyncOutcome, readBlocked, writeBlocked } from '../lib/sync/blocked.js';

/**
 * A skip is chosen for ONE repo, but the blocked marker is per source for the whole machine. So:
 * - A skipped outcome leaves no marker: a skip in repo A must not stop background refresh of that source in repo B.
 * - A skipped outcome does not clear a marker that something else put there (it says nothing about whether the source can be read).
 * - A manual outcome (Confluence with no spaces) still writes one, and an ok outcome still clears it.
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-blocked-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('noteSyncOutcome', () => {
  it('skipped in this repo writes no source-wide marker', () => {
    noteSyncOutcome('linear', 'skipped', 'Linear is skipped in this repo', dir);
    expect(readBlocked('linear', dir)).toBeUndefined();
  });
  it('skipped does not clear a marker that is already there', () => {
    writeBlocked('linear', 'manual', 'needs a person', dir);
    noteSyncOutcome('linear', 'skipped', 'skipped', dir);
    expect(readBlocked('linear', dir)).toMatchObject({ state: 'manual' });
  });
  it('manual still blocks, and an ok run clears it', () => {
    noteSyncOutcome('confluence', 'manual', 'pick spaces', dir);
    expect(readBlocked('confluence', dir)).toMatchObject({ state: 'manual', reason: 'pick spaces' });
    noteSyncOutcome('confluence', 'ok', undefined, dir);
    expect(readBlocked('confluence', dir)).toBeUndefined();
  });
});
