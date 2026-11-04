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
import { addCoChangeRule, listCoChangeRules, removeCoChangeRule } from '../lib/co-change-store.js';

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

  it('a rule is scoped to the repo it was added in: listing for another repo skips it, listing for its own includes it', () => {
    addCoChangeRule(dbPath, { title: 'T', rule: RULE, repo: 'github.com/acme/a' });
    expect(listCoChangeRules(dbPath, { repo: 'github.com/acme/a' })).toHaveLength(1);
    expect(listCoChangeRules(dbPath, { repo: 'github.com/acme/b' })).toEqual([]);
    expect(listCoChangeRules(dbPath)).toHaveLength(1); // no repo asked for = everything, as `align rule list` wants
  });

  it('a rule added outside any repo (repo null) applies to every repo', () => {
    addCoChangeRule(dbPath, { title: 'T', rule: RULE, repo: null });
    expect(listCoChangeRules(dbPath, { repo: 'github.com/acme/b' })).toHaveLength(1);
  });

  it('the same title and rule in two repos is two decisions and two rules', () => {
    const a = addCoChangeRule(dbPath, { title: 'T', rule: RULE, repo: 'github.com/acme/a' });
    const b = addCoChangeRule(dbPath, { title: 'T', rule: RULE, repo: 'github.com/acme/b' });
    expect(b.decisionId).not.toBe(a.decisionId);
    expect(b.created).toBe(true);
  });

  it('the rule decision carries the same repo identity as decisions.repo', () => {
    const { decisionId } = addCoChangeRule(dbPath, { title: 'T', rule: RULE, repo: 'github.com/acme/a' });
    const raw = new DatabaseSync(dbPath);
    expect((raw.prepare('SELECT repo FROM decisions WHERE id = ?').get(decisionId) as { repo: string }).repo).toBe('github.com/acme/a');
    raw.close();
  });

  it('a table from before the repo column gains it on open, and its rules read as applying everywhere', () => {
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE co_change_rules');
    raw.exec(`CREATE TABLE co_change_rules (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE, when_paths TEXT NOT NULL, require_paths TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'same_pr' CHECK (scope IN ('same_pr')), created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (decision_id, when_paths, require_paths))`);
    raw.exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ('d', 'old', 's', 'cli')`);
    raw.exec(`INSERT INTO co_change_rules (id, decision_id, when_paths, require_paths) VALUES ('r', 'd', '["a/**"]', '["b.md"]')`);
    raw.close();
    createLocalDb(dbPath).close();
    expect(listCoChangeRules(dbPath, { repo: 'github.com/acme/x' })).toHaveLength(1);
  });

  it('listing a graph whose table predates the repo column migrates it first instead of failing (the read does not depend on an earlier open)', () => {
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE co_change_rules');
    raw.exec(`CREATE TABLE co_change_rules (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, when_paths TEXT NOT NULL, require_paths TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'same_pr', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (decision_id, when_paths, require_paths))`);
    raw.exec(`INSERT INTO decisions (id, title, summary, platform) VALUES ('d', 'old', 's', 'cli')`);
    raw.exec(`INSERT INTO co_change_rules (id, decision_id, when_paths, require_paths) VALUES ('r', 'd', '["a/**"]', '["b.md"]')`);
    raw.close();
    expect(listCoChangeRules(dbPath, { repo: 'github.com/acme/x' })).toHaveLength(1);
    expect(removeCoChangeRule(dbPath, 'r')).toBe(true);
  });

  it('removing a rule deletes the rule and keeps its decision', () => {
    const { decisionId } = addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    const [stored] = listCoChangeRules(dbPath);
    expect(removeCoChangeRule(dbPath, stored!.ruleId)).toBe(true);
    expect(listCoChangeRules(dbPath)).toEqual([]);
    const raw = new DatabaseSync(dbPath);
    expect(raw.prepare('SELECT 1 AS x FROM decisions WHERE id = ?').get(decisionId)).toBeDefined();
    raw.close();
  });

  it('removing an unknown rule id removes nothing and says so', () => {
    addCoChangeRule(dbPath, { title: 'T', rule: RULE });
    expect(removeCoChangeRule(dbPath, 'nope')).toBe(false);
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
  });

  it('a missing graph lists nothing and is not created', () => {
    expect(listCoChangeRules(path.join(dir, 'nope.db'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'nope.db'))).toBe(false);
  });
});
