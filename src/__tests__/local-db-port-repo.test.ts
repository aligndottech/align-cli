/**
 * Additive migration for local graphs imported before #700 from a port-bearing remote
 * (e.g. ssh://git@ssh.github.com:443/owner/repo.git).
 *
 * Pre-0.92.0 stored those rows under repo='github.com/443/owner/repo', source_url='https://github.com/443/...'
 * and source_key='git|https://github.com/443/...'. Once #700 dropped the port for new imports, repo-scoped
 * queries missed every historical row and re-imports created duplicate clean rows beside them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { stripPortFromRepo, stripPortFromUrl } from '../lib/local-db-port-repo.js';

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'align-port-repo-'));
  dirs.push(dir);
  return join(dir, 'local.db');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stripPortFromUrl / stripPortFromRepo', () => {
  it.each([
    ['https://github.com/443/acme/widgets/commit/abc1234', 'https://github.com/acme/widgets/commit/abc1234'],
    ['https://github.com/22/acme/widgets/blob/main/docs/adr/0001.md', 'https://github.com/acme/widgets/blob/main/docs/adr/0001.md'],
    ['https://gitlab.com/443/group/sub/repo/-/commit/abc1234', 'https://gitlab.com/group/sub/repo/-/commit/abc1234'],
    ['https://gitlab.com/22/group/repo/-/blob/main/README.md', 'https://gitlab.com/group/repo/-/blob/main/README.md'],
  ])('rewrites port-prefixed URL %s -> %s', (input, expected) => {
    expect(stripPortFromUrl(input)).toBe(expected);
  });

  it.each([
    'https://github.com/1234/widgets/commit/abc1234',
    'https://github.com/443/widgets/blob/main/README.md',
    'https://github.com/acme/widgets/commit/abc1234',
    'https://github.com/0/acme/widgets/commit/abc1234',
    'https://github.com/99999/acme/widgets/commit/abc1234',
    'https://gitlab.com/2025/group/repo/-/commit/abc1234',
    'https://gitlab.com/group/repo/-/commit/abc1234',
    'git://commit/abc1234',
  ])('leaves non-port URL %s untouched', (input) => {
    expect(stripPortFromUrl(input)).toBeNull();
  });

  it.each([
    ['github.com/443/acme/widgets', 'github.com/acme/widgets'],
    ['github.com/22/acme/widgets', 'github.com/acme/widgets'],
    ['gitlab.com/443/group/sub/repo', 'gitlab.com/group/sub/repo'],
    ['gitlab.com/22/group/repo', 'gitlab.com/group/repo'],
  ])('rewrites port-prefixed repo %s -> %s', (input, expected) => {
    expect(stripPortFromRepo(input)).toBe(expected);
  });

  it.each([
    'github.com/1234/widgets',
    'github.com/443/widgets',
    'github.com/acme/widgets',
    'gitlab.com/2025/group/repo',
    '/home/user/repo',
  ])('leaves non-port repo %s untouched', (input) => {
    expect(stripPortFromRepo(input)).toBeNull();
  });
});

describe('port-prefixed repo migration on createLocalDb', () => {
  it('repairs git rows, docs rows and co_change_rules in place without bumping SCHEMA_VERSION', () => {
    const dbPath = tempDb();
    // Initialise a clean v11 schema first, then plant pre-#700 rows directly.
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const oldCommitUrl = 'https://github.com/443/acme/widgets/commit/deadbeef01';
    const oldDocUrl = 'https://github.com/443/acme/widgets/blob/main/docs/adr/0001.md';
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key, ratified_by, ratified_at)
       VALUES (?, ?, ?, ?, 'git', ?, ?, 'alice', '2026-11-20T00:00:00Z')`,
    ).run('git-1', 'Use SQLite WAL', `Use SQLite WAL\n\nURL: ${oldCommitUrl}`, oldCommitUrl, 'github.com/443/acme/widgets', `git|${oldCommitUrl}`);
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES (?, ?, ?, ?, 'docs', ?, NULL)`,
    ).run('doc-1', 'ADR 0001', 'Keep storage local', oldDocUrl, 'github.com/443/acme/widgets');
    // Legitimate all-digit GitHub owner must stay untouched.
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES (?, ?, ?, ?, 'git', ?, ?)`,
    ).run('num-1', 'Numeric org commit', 'Owned by org 1234', 'https://github.com/1234/widgets/commit/cafe01', 'github.com/1234/widgets', 'git|https://github.com/1234/widgets/commit/cafe01');
    raw.prepare(
      `INSERT INTO co_change_rules (id, decision_id, repo, when_paths, require_paths)
       VALUES ('cc-1', 'doc-1', 'github.com/443/acme/widgets', '["src/*.ts"]', '["docs/*.md"]')`,
    ).run();
    raw.close();

    const migrated = createLocalDb(dbPath);
    const gitRow = migrated.getDecisionById('git-1');
    const docRow = migrated.getDecisionById('doc-1');
    const numRow = migrated.getDecisionById('num-1');
    expect(gitRow?.repo).toBe('github.com/acme/widgets');
    expect(gitRow?.sourceUrl).toBe('https://github.com/acme/widgets/commit/deadbeef01');
    expect(gitRow?.summary).toBe('Use SQLite WAL\n\nURL: https://github.com/acme/widgets/commit/deadbeef01');
    expect(gitRow?.ratifiedBy).toBe('alice');
    expect(docRow?.repo).toBe('github.com/acme/widgets');
    expect(docRow?.sourceUrl).toBe('https://github.com/acme/widgets/blob/main/docs/adr/0001.md');
    expect(numRow?.repo).toBe('github.com/1234/widgets');
    expect(numRow?.sourceUrl).toBe('https://github.com/1234/widgets/commit/cafe01');
    migrated.close();

    const check = new DatabaseSync(dbPath);
    const key = (check.prepare('SELECT source_key FROM decisions WHERE id = ?').get('git-1') as { source_key: string }).source_key;
    expect(key).toBe('git|https://github.com/acme/widgets/commit/deadbeef01');
    const ccRepo = (check.prepare('SELECT repo FROM co_change_rules WHERE decision_id = ?').get('doc-1') as { repo: string }).repo;
    expect(ccRepo).toBe('github.com/acme/widgets');
    const ver = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(11);
    check.close();
  });

  it('folds collisions safely when 0.93.1 re-import already inserted clean git and docs rows', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const oldGitUrl = 'https://github.com/443/acme/widgets/commit/aaa111';
    const cleanGitUrl = 'https://github.com/acme/widgets/commit/aaa111';
    const oldDocUrl = 'https://github.com/443/acme/widgets/blob/main/docs/adr/0002.md';
    const cleanDocUrl = 'https://github.com/acme/widgets/blob/main/docs/adr/0002.md';

    // Old /443/ git row was ratified; clean row was re-imported unratified.
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key, ratified_by, ratified_at)
       VALUES ('git-old', 'Keep hooks fail-open', ?, ?, 'git', 'github.com/443/acme/widgets', ?, 'bob', '2026-11-20T00:00:00Z')`,
    ).run(`Keep hooks fail-open\n\nURL: ${oldGitUrl}`, oldGitUrl, `git|${oldGitUrl}`);
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('git-new', 'Keep hooks fail-open', ?, ?, 'git', 'github.com/acme/widgets', ?)`,
    ).run(`Keep hooks fail-open\n\nURL: ${cleanGitUrl}`, cleanGitUrl, `git|${cleanGitUrl}`);

    // Unkeyed docs collision (source_key IS NULL, unique on (source_url, title)).
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('doc-old', 'ADR 0002', 'Old summary', ?, 'docs', 'github.com/443/acme/widgets', NULL)`,
    ).run(oldDocUrl);
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('doc-new', 'ADR 0002', 'New summary', ?, 'docs', 'github.com/acme/widgets', NULL)`,
    ).run(cleanDocUrl);
    // Link pointing at old doc row must be repointed to survivor.
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo)
       VALUES ('other', 'Other decision', 'Context', 'https://github.com/acme/widgets/commit/bbb222', 'git', 'github.com/acme/widgets')`,
    ).run();
    raw.prepare(
      `INSERT INTO decision_links (id, source_id, target_id, relation, confidence)
       VALUES ('link-1', 'doc-old', 'other', 'relates', 0.8)`,
    ).run();
    raw.close();

    const db = createLocalDb(dbPath);
    const all = db.listDecisions({ repo: 'github.com/acme/widgets' });
    expect(all.map((d) => d.id).sort()).toEqual(['doc-new', 'git-old', 'other']);
    // Ratified old git row survived AND was rewritten to the clean URL/repo/key.
    const survivedGit = db.getDecisionById('git-old');
    expect(survivedGit?.ratifiedBy).toBe('bob');
    expect(survivedGit?.repo).toBe('github.com/acme/widgets');
    expect(survivedGit?.sourceUrl).toBe(cleanGitUrl);
    // Link from doc-old was repointed to doc-new.
    const links = db.listLinks({ decisionId: 'doc-new' });
    expect(links.some((l) => l.targetId === 'other')).toBe(true);
    db.close();

    // Opening a second time is idempotent and leaves zero /443/ rows.
    createLocalDb(dbPath).close();
    const verify = new DatabaseSync(dbPath);
    const remainingBad = (verify.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE repo LIKE '%/443/%' OR source_url LIKE '%/443/%'`).get() as { n: number }).n;
    expect(remainingBad).toBe(0);
    const backedUp = (verify.prepare(`SELECT COUNT(*) AS n FROM decisions_merged_backup`).get() as { n: number }).n;
    expect(backedUp).toBe(2);
    verify.close();
  });
});
