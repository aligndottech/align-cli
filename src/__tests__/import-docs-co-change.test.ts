/**
 * A README / CONTRIBUTING / changelog section that states a co-change rule ("an API change must
 * also update docs/changelog.md") arrives from the docs fetcher as `co_change_rule`. The local
 * import stores it in `co_change_rules`, on the decision that SAME import wrote, so `align check`
 * flags a PR breaking it with no `align rule add` by hand.
 *
 * Test List:
 * 1. a docs item with a rule stores it on its own decision, stamped with the repo the import ran
 *    in (the identity `align check` compares); a sibling item without one stores nothing
 * 1b. run outside any repo, the rule is NOT stored: an unstamped rule fires in every repo
 * 2. importing the same item again leaves one rule
 * 3. re-importing the section without the rule (the README dropped it) removes the imported rule,
 *    and a rule added by hand survives
 * 4. a rule that does not parse is skipped, and its decision is still imported; one that
 *    replaces a stored rule removes it (the section no longer states a usable rule)
 * 5. a re-import keeps the rule's id, so `align rule remove <id>` names a stable row
 * 6. outside a repo, a rule stored earlier from inside it is left alone
 * 7. only docs items carry rules: a git item with the field stores nothing
 * 8. a graph that cannot take the rule (in memory) warns and the import still finishes
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { addCoChangeRule, listCoChangeRules } from '../lib/co-change-store.js';
import { currentRepoIdentity } from '../lib/repo-identity.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

const RULE = { when_paths: ['openapi/**'], require_paths: ['docs/changelog.md'], scope: 'same_pr' as const };
const CHANGELOG = 'https://github.com/recart/api/blob/main/README.md#updating-the-changelog';
const VERSIONING = 'https://github.com/recart/api/blob/main/README.md#versioning';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-docs-cochange-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => rmDir(dir));

type Item = { source_url: string; platform: string; title: string; raw_text: string; co_change_rule?: unknown };
const item = (url: string, title: string, rule?: unknown): Item => ({
  source_url: url, platform: 'docs', title,
  raw_text: `${title}: add an entry to docs/changelog.md in the same PR when the API changes.`,
  ...(rule === undefined ? {} : { co_change_rule: rule }),
});
const ingest = async (items: Item[], cwd?: string) => {
  const c = createLocalGatewayClient(dbPath, cwd === undefined ? {} : { cwd });
  try { return await c.ingestBatch(items as never, { classify: false, keyed: true }); } finally { c.close(); }
};
function decisionFor(url: string): { id: string; repo: string | null } {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('SELECT id, repo FROM decisions WHERE source_url = ?').get(url) as never; } finally { db.close(); }
}

describe('docs import stores the co-change rules it found', () => {
  it('stores the rule on its own decision, stamped with the repo it ran in, and nothing for a section without one', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE), item(VERSIONING, 'Versioning')]);
    const rules = listCoChangeRules(dbPath);
    expect(rules).toHaveLength(1);
    const here = await currentRepoIdentity();
    expect(here).not.toBeNull(); // positive control: the suite runs inside a checkout, so the stamp is a real value
    expect(rules[0]).toMatchObject({ decisionId: decisionFor(CHANGELOG).id, repo: here, title: 'Updating the changelog', rule: RULE });
  });

  it('run outside any repo, stores the decision and not the rule', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)], dir);
    expect(decisionFor(CHANGELOG)).toBeDefined();
    expect(listCoChangeRules(dbPath)).toHaveLength(0);
  });

  it('importing the same section again keeps one rule', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
  });

  it('a section that no longer states the rule loses it, and a hand-added rule stays', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    addCoChangeRule(dbPath, { title: 'Schema changes need a migration', rule: { when_paths: ['src/schema/**'], require_paths: ['migrations/**'], scope: 'same_pr' } });
    expect(listCoChangeRules(dbPath)).toHaveLength(2);
    await ingest([item(CHANGELOG, 'Updating the changelog')]);
    expect(listCoChangeRules(dbPath).map((r) => r.title)).toEqual(['Schema changes need a migration']);
  });

  it('skips a rule that does not parse and still imports its decision', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', { when_paths: [], require_paths: ['docs/changelog.md'], scope: 'same_pr' })]);
    expect(decisionFor(CHANGELOG)).toBeDefined();
    expect(listCoChangeRules(dbPath)).toHaveLength(0);
  });

  it('an unparseable rule replacing a stored one removes it', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
    await ingest([item(CHANGELOG, 'Updating the changelog', { when_paths: [], require_paths: ['x'], scope: 'same_pr' })]);
    expect(listCoChangeRules(dbPath)).toHaveLength(0);
  });

  it('a re-import keeps the rule id', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    const before = listCoChangeRules(dbPath)[0].ruleId;
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    expect(listCoChangeRules(dbPath).map((r) => r.ruleId)).toEqual([before]);
  });

  it('outside a repo, a rule stored from inside it stays', async () => {
    await ingest([item(CHANGELOG, 'Updating the changelog', RULE)]);
    await ingest([item(CHANGELOG, 'Updating the changelog')], dir);
    expect(listCoChangeRules(dbPath)).toHaveLength(1);
  });

  it('a non-docs item carrying the field stores no rule', async () => {
    await ingest([{ ...item(CHANGELOG, 'Updating the changelog', RULE), platform: 'git' }]);
    expect(decisionFor(CHANGELOG)).toBeDefined();
    expect(listCoChangeRules(dbPath)).toHaveLength(0);
  });

  it('an in-memory graph warns about the rule and still imports every item', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = createLocalGatewayClient(':memory:');
    try {
      const res = await c.ingestBatch([item(CHANGELOG, 'Updating the changelog', RULE), item(VERSIONING, 'Versioning')] as never, { classify: false, keyed: true });
      expect(res.snapshots).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Updating the changelog'));
    } finally { c.close(); warn.mockRestore(); }
  });
});
