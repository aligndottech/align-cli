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
import { refIdentityFor } from '../lib/decision-refs.js';
import { repairPortPrefixedRepos, stripPortFromRepo, stripPortFromUrl } from '../lib/local-db-port-repo.js';

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
  ])('rewrites port-prefixed URL %s -> %s', (input, expected) => {
    expect(stripPortFromUrl(input)).toBe(expected);
  });

  it.each([
    'https://github.com/1234/widgets/commit/abc1234',
    'https://github.com/443/widgets/blob/main/README.md',
    'https://github.com/acme/widgets/commit/abc1234',
    'https://github.com/0/acme/widgets/commit/abc1234',
    'https://github.com/99999/acme/widgets/commit/abc1234',
    'https://gitlab.com/443/group/sub/repo/-/commit/abc1234',
    'https://gitlab.com/22/group/repo/-/blob/main/README.md',
    'https://gitlab.com/2025/group/repo/-/commit/abc1234',
    'https://gitlab.com/group/repo/-/commit/abc1234',
    'git://commit/abc1234',
  ])('leaves non-port or ambiguous-host URL %s untouched', (input) => {
    expect(stripPortFromUrl(input)).toBeNull();
  });

  it.each([
    ['github.com/443/acme/widgets', 'github.com/acme/widgets'],
    ['github.com/22/acme/widgets', 'github.com/acme/widgets'],
  ])('rewrites port-prefixed repo %s -> %s', (input, expected) => {
    expect(stripPortFromRepo(input)).toBe(expected);
  });

  it.each([
    'github.com/1234/widgets',
    'github.com/443/widgets',
    'github.com/acme/widgets',
    'gitlab.com/443/group/sub/repo',
    'gitlab.com/22/group/repo',
    'gitlab.com/2025/group/repo',
    '/home/user/repo',
  ])('leaves non-port or ambiguous-host repo %s untouched', (input) => {
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
    // Ratified old git row survived AND was rewritten to the clean URL/repo/key/summary.
    const survivedGit = db.getDecisionById('git-old');
    expect(survivedGit?.ratifiedBy).toBe('bob');
    expect(survivedGit?.repo).toBe('github.com/acme/widgets');
    expect(survivedGit?.sourceUrl).toBe(cleanGitUrl);
    expect(survivedGit?.summary).toBe(`Keep hooks fail-open\n\nURL: ${cleanGitUrl}`);
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

  it('leaves a row alone when its stored repo is clean, even if the URL reads as port/owner/repo', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    // Numeric owner 1234, repo widgets, branch "blob": the URL parses as host/port/owner/repo, the repo column does not.
    const ambiguousUrl = 'https://github.com/1234/widgets/blob/blob/docs/adr.md';
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('amb-clean', 'ADR numeric owner', 'Context', ?, 'docs', 'github.com/1234/widgets', NULL)`,
    ).run(ambiguousUrl);
    // No stored repo (git rows are not backfilled): nothing proves a port leaked, so the row is left alone too.
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('amb-null', 'Commit no repo', 'Context', ?, 'git', NULL, NULL)`,
    ).run('https://github.com/443/acme/widgets/commit/e0e0e0');
    // Twin: a genuinely leaked row with the same odd branch name is still repaired.
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('amb-leaked', 'ADR leaked', 'Context', ?, 'docs', 'github.com/443/acme/widgets', NULL)`,
    ).run('https://github.com/443/acme/widgets/blob/blob/docs/adr.md');
    raw.close();

    const db = createLocalDb(dbPath);
    expect(db.getDecisionById('amb-clean')?.sourceUrl).toBe(ambiguousUrl);
    expect(db.getDecisionById('amb-clean')?.repo).toBe('github.com/1234/widgets');
    expect(db.getDecisionById('amb-null')?.sourceUrl).toBe('https://github.com/443/acme/widgets/commit/e0e0e0');
    expect(db.getDecisionById('amb-null')?.repo).toBeNull();
    expect(db.getDecisionById('amb-leaked')?.sourceUrl).toBe('https://github.com/acme/widgets/blob/blob/docs/adr.md');
    expect(db.getDecisionById('amb-leaked')?.repo).toBe('github.com/acme/widgets');
    db.close();
  });

  it('on a fold, a legacy row with no source_key keeps its clean twin key, and one with a key keeps its own cleaned key', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const insert = raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key, ratified_by, ratified_at)
       VALUES (?, ?, 'S', ?, 'git', ?, ?, ?, ?)`,
    );
    // Unattested legacy NULL-key row: the keyed clean twin survives.
    insert.run('nk-old', 'Key kept', 'https://github.com/443/acme/widgets/commit/k1', 'github.com/443/acme/widgets', null, null, null);
    insert.run('nk-new', 'Key kept', 'https://github.com/acme/widgets/commit/k1', 'github.com/acme/widgets', 'git|twin-key-1', null, null);
    // Attested legacy NULL-key row: it survives and must take over the twin's key.
    insert.run('nk-old2', 'Key taken over', 'https://github.com/443/acme/widgets/commit/k2', 'github.com/443/acme/widgets', null, 'bob', '2026-11-20T00:00:00Z');
    insert.run('nk-new2', 'Key taken over', 'https://github.com/acme/widgets/commit/k2', 'github.com/acme/widgets', 'git|twin-key-2', null, null);
    // A legacy row WITH a key keeps its own cleaned key, as before, even when the twin holds a different one.
    insert.run('nk-old3', 'Own key wins', 'https://github.com/443/acme/widgets/commit/cafe0003', 'github.com/443/acme/widgets', 'git|https://github.com/443/acme/widgets/commit/cafe0003', null, null);
    insert.run('nk-new3', 'Own key wins', 'https://github.com/acme/widgets/commit/cafe0003', 'github.com/acme/widgets', 'git|twin-key-3', null, null);
    raw.close();

    createLocalDb(dbPath).close();
    const check = new DatabaseSync(dbPath);
    const keys = check.prepare(`SELECT id, source_key FROM decisions WHERE id LIKE 'nk-%' ORDER BY id`).all() as Array<{ id: string; source_key: string | null }>;
    expect(keys).toEqual([
      { id: 'nk-new', source_key: 'git|twin-key-1' },
      { id: 'nk-new3', source_key: 'git|https://github.com/acme/widgets/commit/cafe0003' },
      { id: 'nk-old2', source_key: 'git|twin-key-2' },
    ]);
    check.close();
  });

  it('re-derives decision_identities for a repaired row so a clean-URL citer links to it', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const oldUrl = 'https://github.com/443/acme/widgets/blob/main/docs/issues/12/adr.md';
    const cleanUrl = 'https://github.com/acme/widgets/blob/main/docs/issues/12/adr.md';
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES ('id-doc', 'ADR with issues dir', 'S', ?, 'docs', 'github.com/443/acme/widgets', NULL)`,
    ).run(oldUrl);
    raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo)
       VALUES ('id-citer', 'Cites the ADR', 'See it', 'https://github.com/acme/widgets/commit/c1', 'git', 'github.com/acme/widgets')`,
    ).run();
    // What migrateRefLinks recorded before the repair: the port-bearing identity.
    raw.prepare(`INSERT INTO decision_identities (decision_id, ref, platform) VALUES ('id-doc', ?, 'github')`).run(oldUrl);
    raw.prepare(`INSERT INTO decision_refs (decision_id, ref, platform) VALUES ('id-citer', ?, 'github')`).run(cleanUrl);
    raw.close();

    const db = createLocalDb(dbPath);
    expect(db.listLinks({ decisionId: 'id-doc' }).some((l) => l.sourceId === 'id-citer' && l.targetId === 'id-doc')).toBe(true);
    db.close();
    const check = new DatabaseSync(dbPath);
    const ids = check.prepare(`SELECT ref FROM decision_identities WHERE decision_id = 'id-doc'`).all() as Array<{ ref: string }>;
    expect(ids).toEqual([{ ref: cleanUrl }]);
    check.close();
  });

  it('after a fold the survivor holds the clean identity only, not the port-bearing one it absorbed', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    const raw = new DatabaseSync(dbPath);
    const oldUrl = 'https://github.com/443/acme/widgets/blob/main/docs/issues/12/adr.md';
    const cleanUrl = 'https://github.com/acme/widgets/blob/main/docs/issues/12/adr.md';
    // The identities come from the function that writes them, so the fixture cannot drift from it.
    const [stale] = refIdentityFor('docs', oldUrl);
    const [clean] = refIdentityFor('docs', cleanUrl);
    expect(stale).toEqual({ ref: oldUrl, platform: 'github' });
    expect(clean).toEqual({ ref: cleanUrl, platform: 'github' });
    const insert = raw.prepare(
      `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key)
       VALUES (?, 'ADR with issues dir', 'S', ?, 'docs', ?, NULL)`,
    );
    insert.run('fi-old', oldUrl, 'github.com/443/acme/widgets');
    insert.run('fi-new', cleanUrl, 'github.com/acme/widgets');
    const identity = raw.prepare('INSERT INTO decision_identities (decision_id, ref, platform) VALUES (?, ?, ?)');
    identity.run('fi-old', stale!.ref, stale!.platform);
    identity.run('fi-new', clean!.ref, clean!.platform);
    const all = `SELECT decision_id, ref FROM decision_identities WHERE decision_id IN ('fi-old', 'fi-new') ORDER BY decision_id`;
    // Before: one identity each, and the legacy row's is the port-bearing one.
    expect(raw.prepare(all).all()).toEqual([{ decision_id: 'fi-new', ref: cleanUrl }, { decision_id: 'fi-old', ref: oldUrl }]);
    raw.close();

    createLocalDb(dbPath).close();
    const check = new DatabaseSync(dbPath);
    expect(check.prepare(`SELECT id FROM decisions WHERE id IN ('fi-old', 'fi-new')`).all()).toEqual([{ id: 'fi-new' }]);
    expect(check.prepare(all).all()).toEqual([{ decision_id: 'fi-new', ref: cleanUrl }]);
    check.close();
  });

  it('takes no write lock on open when the only row that reads as port/owner/repo has a clean repo', () => {
    const dbPath = tempDb();
    createLocalDb(dbPath).close();
    // Raw connections have no busy timeout, so a lock that cannot be taken fails at once.
    const opener = new DatabaseSync(dbPath);
    const writer = new DatabaseSync(dbPath);
    const insert = `INSERT INTO decisions (id, title, summary, source_url, platform, repo, source_key) VALUES (?, ?, 'Context', ?, 'docs', ?, NULL)`;
    opener.prepare(insert).run('fp-clean', 'ADR numeric owner', 'https://github.com/1234/widgets/blob/blob/docs/adr.md', 'github.com/1234/widgets');
    opener.prepare(insert).run('fp-gitlab', 'GitLab numeric group', 'https://gitlab.com/22/team/project/-/blob/main/docs/adr.md', 'gitlab.com/22/team/project');
    opener.prepare(`INSERT INTO co_change_rules (id, decision_id, repo, when_paths, require_paths) VALUES ('cc-gl', 'fp-gitlab', 'gitlab.com/443/team/project', '["a"]', '["b"]')`).run();

    writer.exec('BEGIN IMMEDIATE'); // another process is in the middle of a write
    expect(() => repairPortPrefixedRepos(opener)).not.toThrow();

    // Positive control: the lock really is held. With a leaked row to repair, the same call needs it and cannot get it.
    writer.prepare(insert).run('fp-leaked', 'ADR leaked', 'https://github.com/443/acme/widgets/blob/main/docs/adr.md', 'github.com/443/acme/widgets');
    writer.exec('COMMIT');
    writer.exec('BEGIN IMMEDIATE');
    expect(() => repairPortPrefixedRepos(opener)).toThrow(/locked/i);
    writer.exec('ROLLBACK');
    writer.close();
    opener.close();
  });
});
