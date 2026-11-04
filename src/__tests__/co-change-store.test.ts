/**
 * Co-change rules in the local graph: a `co_change_rules` table keyed to a decision.
 *
 * Test List:
 * 1. add creates a decision and one rule; list returns both, with the rule in the shared shape
 * 2. adding the same rule twice stores one (idempotent), a different rule on the same title stores two
 * 3. an invalid rule is refused and nothing is stored
 * 4. a fresh graph has the table; a graph that predates it gains it on open WITHOUT bumping user_version
 *    (an older CLI keeps opening it)
 * 5. deleting a decision removes its rules; a rule whose decision is gone (older CLI delete) is not listed
 * 6. a missing graph lists nothing and is not created
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { deleteDecisionWithDependents } from '../lib/local-db-migrate.js';
import { addCoChangeRule, listCoChangeRules } from '../lib/co-change-store.js';

const RULE = { when_paths: ['openapi/**'], require_paths: ['docs/changelog.md'], scope: 'same_pr' as const };
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cochange-'));
  dbPath = path.join(dir, 'local.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('co-change rule storage', () => {
  it('stores a rule on a new decision and lists it in the shared shape', () => {
    const { decisionId, created } = addCoChangeRule(dbPath, { title: 'Changelog entry for API changes', summary: 'Add docs/changelog.md in the same PR', rule: RULE });
    expect(created).toBe(true);
    const listed = listCoChangeRules(dbPath);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ decisionId, title: 'Changelog entry for API changes', summary: 'Add docs/changelog.md in the same PR', rule: RULE });
  });

  it('is idempotent for the same title and rule, and keeps a different rule apart', () => {
    const a = addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    const b = addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    expect(b).toEqual({ decisionId: a.decisionId, created: false });
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
    addCoChangeRule(dbPath, { title: 'T', rule: { ...RULE, require_paths: ['CHANGELOG.md'] } });
    expect(listCoChangeRules(dbPath)).toHaveLength(2);
  });

  it('refuses an invalid rule and stores nothing', () => {
    expect(() => addCoChangeRule(dbPath, { title: 'T', rule: { ...RULE, require_paths: [] } })).toThrow(/require_paths/);
    expect(listCoChangeRules(dbPath)).toEqual([]);
  });

  it('refuses a blank title', () => {
    expect(() => addCoChangeRule(dbPath, { title: '  ', rule: RULE })).toThrow(/title/);
  });

  it('a fresh graph has the table', () => {
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='co_change_rules'`).all()).toHaveLength(1);
    raw.close();
  });

  it('a graph that predates the table gains it on open and keeps its user_version', () => {
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE co_change_rules');
    const before = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    raw.close();
    createLocalDb(dbPath).close();
    const again = new DatabaseSync(dbPath);
    expect(again.prepare(`SELECT name FROM sqlite_master WHERE name='co_change_rules'`).all()).toHaveLength(1);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(before);
    expect(before).toBe(SCHEMA_VERSION);
    again.close();
  });

  it('deleting a decision removes its rules', () => {
    const { decisionId } = addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    const raw = new DatabaseSync(dbPath);
    deleteDecisionWithDependents(raw, decisionId);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM co_change_rules').get() as { n: number }).n).toBe(0);
    raw.close();
  });

  it('does not list a rule whose decision row is gone', () => {
    const { decisionId } = addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    const raw = new DatabaseSync(dbPath);
    raw.prepare('DELETE FROM decisions WHERE id = ?').run(decisionId); // what an older CLI's delete leaves behind
    raw.close();
    expect(listCoChangeRules(dbPath)).toEqual([]);
  });

  it('a missing graph lists nothing and is not created', () => {
    expect(listCoChangeRules(path.join(dir, 'nope.db'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'nope.db'))).toBe(false);
  });
});
