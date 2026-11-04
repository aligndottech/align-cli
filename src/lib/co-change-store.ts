/**
 * Reads and writes of `co_change_rules` (local-db-cochange.ts). Same short-lived-handle pattern as
 * curation/judgements-db.ts, so the MCP server and a sync child can both be live. A reader never
 * creates a missing graph.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertSchemaSupported } from './local-db-migrate.js';
import { tightenGraphFiles } from './private-files.js';
import { createLocalDb } from './local-db.js';
import { type CoChangeRule, parseCoChangeRule, type StoredCoChangeRule } from './co-change.js';

/** A graph from before the repo column has the table but not the column. The write-lock migration lives in createLocalDb, so run that once and read again. */
function ensureCurrent(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  let stale = false;
  try {
    stale = (db.prepare('PRAGMA table_info(co_change_rules)').all() as Array<{ name: string }>).length > 0
      && !(db.prepare('PRAGMA table_info(co_change_rules)').all() as Array<{ name: string }>).some((c) => c.name === 'repo');
  } finally {
    db.close();
  }
  if (stale) createLocalDb(dbPath).close();
}

function openRead(dbPath: string): DatabaseSync {
  ensureCurrent(dbPath);
  tightenGraphFiles(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 30000');
  assertSchemaSupported((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, db);
  return db;
}

/**
 * The decision's identity is (source_url, title), so the url is derived from the rule: the same title
 * and rule re-added is the same decision, and the same title with a different rule is another one.
 * It is an opaque key, never a link, and the listing does not surface it as one.
 */
function ruleSourceKey(title: string, rule: CoChangeRule, repo: string | null): string {
  const digest = createHash('sha256').update(JSON.stringify([title, repo, rule.when_paths, rule.require_paths, rule.scope])).digest('hex').slice(0, 16);
  return `align-rule://co-change/${digest}`;
}

export function addCoChangeRule(dbPath: string, input: { title: string; summary?: string; rule: CoChangeRule; repo?: string | null }): { decisionId: string; created: boolean } {
  const rule = parseCoChangeRule(input.rule);
  const title = input.title.trim();
  const repo = input.repo ?? null;
  if (title === '') throw new Error('A co-change rule needs a title: the decision it records');
  const summary = input.summary?.trim() || `A change touching ${rule.when_paths.join(', ')} must also touch ${rule.require_paths.join(' or ')} in the same PR.`;
  const store = createLocalDb(dbPath);
  try {
    const sourceUrl = ruleSourceKey(title, rule, repo);
    const existing = store.findIdBySource(sourceUrl, title);
    const decisionId = store.insertDecision({ title, summary, sourceUrl, platform: 'cli', repo, deciderKind: 'human' });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.prepare(`INSERT OR IGNORE INTO co_change_rules (id, decision_id, repo, when_paths, require_paths, scope) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), decisionId, repo, JSON.stringify(rule.when_paths), JSON.stringify(rule.require_paths), rule.scope);
    } finally {
      db.close();
    }
    return { decisionId, created: existing === null };
  } finally {
    store.close();
  }
}

/**
 * The docs import's writer: the rules on `decisionId` become exactly `raw` (one rule, or none).
 * Replacing rather than adding is what lets a README that drops a rule drop it here too. Only the
 * imported decision's own rules are touched; a hand-added rule lives on its own decision
 * (addCoChangeRule). A rule that does not parse is skipped, never thrown: one bad section must not
 * fail the import of every other one. True when a rule was stored.
 */
export function syncImportedCoChangeRule(dbPath: string, decisionId: string, repo: string | null, raw: unknown): boolean {
  let rule: CoChangeRule | undefined;
  try {
    rule = raw === undefined ? undefined : parseCoChangeRule(raw);
  } catch {
    rule = undefined;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.prepare('DELETE FROM co_change_rules WHERE decision_id = ?').run(decisionId);
    if (rule === undefined) return false;
    db.prepare(`INSERT INTO co_change_rules (id, decision_id, repo, when_paths, require_paths, scope) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), decisionId, repo, JSON.stringify(rule.when_paths), JSON.stringify(rule.require_paths), rule.scope);
    return true;
  } finally {
    db.close();
  }
}

/** Every rule whose decision still exists. A missing graph, or one that predates the table, lists nothing. */
export function listCoChangeRules(dbPath: string, scope: { repo?: string | null } = {}): StoredCoChangeRule[] {
  if (dbPath === '' || !fs.existsSync(dbPath)) return [];
  const db = openRead(dbPath);
  try {
    const rows = db.prepare(
      `SELECT r.id AS ruleId, r.repo AS repo, d.id AS id, d.title AS title, d.summary AS summary, r.when_paths AS whenPaths, r.require_paths AS requirePaths, r.scope AS scope
         FROM co_change_rules r JOIN decisions d ON d.id = r.decision_id ORDER BY r.created_at, r.rowid`,
    ).all() as Array<{ ruleId: string; repo: string | null; id: string; title: string; summary: string; whenPaths: string; requirePaths: string; scope: string }>;
    // Asking for a repo keeps that repo's rules and the ones with no repo; asking for none keeps all.
    const wanted = scope.repo === undefined ? rows : rows.filter((r) => r.repo === null || r.repo === scope.repo);
    return wanted.map((r) => ({
      ruleId: r.ruleId, repo: r.repo, decisionId: r.id, title: r.title, summary: r.summary,
      rule: parseCoChangeRule({ when_paths: JSON.parse(r.whenPaths), require_paths: JSON.parse(r.requirePaths), scope: r.scope }),
    }));
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return [];
    throw e;
  } finally {
    db.close();
  }
}

/** Deletes the rule and keeps its decision. False when no rule has that id. */
export function removeCoChangeRule(dbPath: string, ruleId: string): boolean {
  if (dbPath === '' || !fs.existsSync(dbPath)) return false;
  const db = openRead(dbPath);
  try {
    return Number(db.prepare('DELETE FROM co_change_rules WHERE id = ?').run(ruleId).changes) > 0;
  } finally {
    db.close();
  }
}
