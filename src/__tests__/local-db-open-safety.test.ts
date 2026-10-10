// L2 review findings 5 and 6: opening a graph a NEWER CLI migrated must refuse (not run old
// code against new tables), and a second opener must wait for the migration lock instead of
// failing with SQLITE_BUSY.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { createV6Graph } from './helpers/v6-graph.js';

vi.setConfig({ testTimeout: 30_000 });

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l2-open-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('downgrade guard', () => {
  it('refuses a graph whose user_version is newer than this build, naming the fix', () => {
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => createLocalDb(dbPath)).toThrow(/upgrade/i);
    // and it did not touch the file: still the newer version
    const check = new DatabaseSync(dbPath);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
    check.close();
  });

  it('opens a graph at exactly the current version', () => {
    createLocalDb(dbPath).close();
    expect(() => createLocalDb(dbPath).close()).not.toThrow();
  });
});

describe('a second opener waits for the lock', () => {
  it('opens a v6 file while another process holds the write lock for 600ms, then migrates it', async () => {
    const v6 = createV6Graph(dbPath);
    v6.insertDecision({ id: 'a', title: 'T1', summary: 'one', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
    v6.raw.exec('PRAGMA journal_mode = WAL'); // every real v6 file is WAL: the CLI has always set it
    v6.close();
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(${JSON.stringify(dbPath)});
      d.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => { d.exec('COMMIT'); d.close(); }, 600);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    const t = performance.now();
    createLocalDb(dbPath).close(); // blocks on busy_timeout until the holder commits
    expect(performance.now() - t).toBeGreaterThan(300); // control: it really waited
    await new Promise((resolve) => holder.once('exit', resolve));
    const check = new DatabaseSync(dbPath);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    check.close();
  });
});
