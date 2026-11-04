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

function openRead(dbPath: string): DatabaseSync {
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
function ruleSourceKey(title: string, rule: CoChangeRule): string {
  const digest = createHash('sha256').update(JSON.stringify([title, rule.when_paths, rule.require_paths, rule.scope])).digest('hex').slice(0, 16);
  return `align-rule://co-change/${digest}`;
}

export function addCoChangeRule(dbPath: string, input: { title: string; summary?: string; rule: CoChangeRule }): { decisionId: string; created: boolean } {
  const rule = parseCoChangeRule(input.rule);
  const title = input.title.trim();
  if (title === '') throw new Error('A co-change rule needs a title: the decision it records');
  const summary = input.summary?.trim() || `A change touching ${rule.when_paths.join(', ')} must also touch ${rule.require_paths.join(' or ')} in the same PR.`;
  const store = createLocalDb(dbPath);
  try {
    const sourceUrl = ruleSourceKey(title, rule);
    const existing = store.findIdBySource(sourceUrl, title);
    const decisionId = store.insertDecision({ title, summary, sourceUrl, platform: 'cli', deciderKind: 'human' });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      db.prepare(`INSERT OR IGNORE INTO co_change_rules (id, decision_id, when_paths, require_paths, scope) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), decisionId, JSON.stringify(rule.when_paths), JSON.stringify(rule.require_paths), rule.scope);
    } finally {
      db.close();
    }
    return { decisionId, created: existing === null };
  } finally {
    store.close();
  }
}

/** Every rule whose decision still exists. A missing graph, or one that predates the table, lists nothing. */
export function listCoChangeRules(dbPath: string): StoredCoChangeRule[] {
  if (dbPath === '' || !fs.existsSync(dbPath)) return [];
  const db = openRead(dbPath);
  try {
    const rows = db.prepare(
      `SELECT d.id AS id, d.title AS title, d.summary AS summary, r.when_paths AS whenPaths, r.require_paths AS requirePaths, r.scope AS scope
         FROM co_change_rules r JOIN decisions d ON d.id = r.decision_id ORDER BY r.created_at, r.rowid`,
    ).all() as Array<{ id: string; title: string; summary: string; whenPaths: string; requirePaths: string; scope: string }>;
    return rows.map((r) => ({
      decisionId: r.id, title: r.title, summary: r.summary,
      rule: parseCoChangeRule({ when_paths: JSON.parse(r.whenPaths), require_paths: JSON.parse(r.requirePaths), scope: r.scope }),
    }));
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return [];
    throw e;
  } finally {
    db.close();
  }
}
