import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';

// Regression for the first-run crash: on a clean machine the local DB's parent
// directory (e.g. ~/.config/align-cli) does not exist, and better-sqlite3 creates
// the file but NOT the directory, so `align setup --local` / `align local start`
// died with `SqliteError: unable to open database file`. createLocalDb must create
// the parent directory itself.
describe('createLocalDb on a clean machine (no parent dir)', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  it('creates the parent directory if it does not exist', () => {
    const base = path.join(os.tmpdir(), `align-mkdir-${process.pid}-${Math.random().toString(36).slice(2)}`);
    created.push(base);
    const dbPath = path.join(base, 'config', 'align-cli', 'local.db');
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    const db = createLocalDb(dbPath); // must NOT throw "unable to open database file"
    db.close();

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('still supports an in-memory database', () => {
    const db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 't', summary: 's', sourceUrl: null, platform: 'cli' });
    expect(db.getDecisionById(id)?.title).toBe('t');
    db.close();
  });
});