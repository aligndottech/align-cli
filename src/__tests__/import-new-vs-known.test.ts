import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';

/**
 * ALI-770. `align setup --local` already imports from git, so running `align import git`
 * afterwards is a natural next move - and it reported "Imported 2 decisions" while the graph
 * stayed at 2. A tester read that as having imported twice, which is exactly what it looks
 * like, and there was no way to tell whether the graph now held 2 or 4.
 *
 * The dedup work makes re-importing SAFE; this makes it legible. Nothing downstream could
 * tell an insert from a refresh, because insertDecision upserts and returns the surviving id
 * either way.
 */
describe('findIdBySource: telling a new decision from one already in the graph', () => {
  let dir: string;
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-known-'));
    dbPath = path.join(dir, 'local.db');
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a decision the graph has never seen', () => {
    db = createLocalDb(dbPath);
    expect(db.findIdBySource('git://commit/abc', 'Use Postgres')).toBeNull();
  });

  it('returns the existing id for one it already holds', () => {
    db = createLocalDb(dbPath);
    const id = db.insertDecision({
      title: 'Use Postgres', summary: 's', sourceUrl: 'git://commit/abc', platform: 'git',
    });
    expect(db.findIdBySource('git://commit/abc', 'Use Postgres')).toBe(id);
  });

  // The pair key is (source_url, title), so a changed title is a DIFFERENT decision and must
  // read as new - the same rule insertDecision's unique index enforces.
  it('treats a changed title as a decision it has not seen', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Old title', summary: 's', sourceUrl: 'git://commit/abc', platform: 'git' });
    expect(db.findIdBySource('git://commit/abc', 'New title')).toBeNull();
  });

  /**
   * insertDecision stores `identifyingSourceUrl(sourceUrl)`, not the raw one, so this lookup
   * has to apply the same rule or it reports rows as new that are not.
   *
   * The first draft of this test asserted that a query string and fragment are stripped, so
   * the bare URL would find the same row. That is not what identifyingSourceUrl does - it
   * keeps the value verbatim and only nulls a URL addressing a host and nothing on it. The
   * test failed and the assumption was wrong, not the code. Pinning the REAL contract here,
   * both halves.
   */
  it('stores and finds a URL with a query and fragment verbatim', () => {
    db = createLocalDb(dbPath);
    const url = 'https://github.com/o/r/pull/1?utm_source=slack#comment-2';
    const id = db.insertDecision({ title: 'Use Postgres', summary: 's', sourceUrl: url, platform: 'github' });
    expect(db.findIdBySource(url, 'Use Postgres')).toBe(id);
    // A different URL is a different decision, even one that only differs by the query.
    expect(db.findIdBySource('https://github.com/o/r/pull/1', 'Use Postgres')).toBeNull();
  });

  /**
   * The parity that actually matters. A bare origin is NOT an identity - connector-core's
   * Teams fetcher substitutes `https://teams.microsoft.com` when a message has no permalink,
   * so treating it as one would collapse every such message onto a single row.
   * insertDecision normalises it to null; if this lookup did not, it would match the first
   * such row and report every later Teams message as already known.
   */
  it('treats a bare-origin URL as no identity, exactly as insertDecision does', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Ship on Friday', summary: 'a', sourceUrl: 'https://teams.microsoft.com', platform: 'teams' });
    expect(db.findIdBySource('https://teams.microsoft.com', 'Ship on Friday')).toBeNull();
    expect(db.findIdBySource('https://teams.microsoft.com', 'A different message')).toBeNull();
  });

  // A null source_url never conflicts (SQLite treats each NULL in a unique index as
  // distinct), so `align capture` with no URL always inserts and must always read as new.
  it('reports a decision with no source URL as never seen', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'Captured', summary: 's', sourceUrl: null, platform: 'cli' });
    expect(db.findIdBySource(null, 'Captured')).toBeNull();
  });
});
