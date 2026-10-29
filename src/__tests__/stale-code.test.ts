import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findStaleCode, StaleError, type StaleLink } from '../lib/stale-code.js';
import { loadLocalLinks, loadTeamLinks, LOCAL_EMPTY_NOTE } from '../lib/stale-links.js';
import { createLocalDb } from '../lib/local-db.js';
import { runStale } from '../lib/stale-run.js';
import { dispatchTool, TOOL_SCHEMAS } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const mk = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'align-stale-')); roots.push(d); return d; };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (cwd: string, file: string, text: string): void => { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), text); };
const commit = (cwd: string, msg: string): string => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
const lines = (prefix: string, n: number): string => `${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n')  }\n`;

function repo(): string {
  const d = mk();
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  return d;
}

const link = (over: Partial<StaleLink> = {}): StaleLink => ({
  oldId: 'old', oldTitle: 'Use polling', oldSourceUrl: null,
  newId: 'new', newTitle: 'Use webhooks', newSourceUrl: 'https://example.com/new',
  confidence: 0.9, humanConfirmed: true, ...over,
});

describe('findStaleCode', () => {
  it('lists the lines a replaced decision wrote that nobody has rewritten, with counts and ranges', async () => {
    const d = repo();
    write(d, 'src/poll.ts', lines('a', 6));
    const sha = commit(d, 'Use polling');
    write(d, 'src/poll.ts', 'a1\nCHANGED\na3\na4\nCHANGED2\na6\n');
    commit(d, 'Tweak');
    const r = await findStaleCode([link({ oldSourceUrl: `https://github.com/acme/demo/commit/${sha}` })], { cwd: d });
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.commit).toBe(sha);
    expect(f.totalLines).toBe(4);
    expect(f.files).toEqual([{ file: 'src/poll.ts', lines: 4, ranges: [[1, 1], [3, 4], [6, 6]] }]);
    expect(f.confirmation).toBe('confirmed');
    expect(f.replacedBy.title).toBe('Use webhooks');
  });

  it('finds nothing when the old code has been fully rewritten', async () => {
    const d = repo();
    write(d, 'src/poll.ts', lines('a', 3));
    const sha = commit(d, 'Use polling');
    write(d, 'src/poll.ts', lines('b', 3));
    commit(d, 'Rewrite');
    const r = await findStaleCode([link({ oldSourceUrl: `https://github.com/acme/demo/commit/${sha}` })], { cwd: d });
    expect(r.findings).toEqual([]);
    expect(r.linksConsidered).toBe(1);
  });

  it('maps a squash-merged PR url to the commit whose subject carries (#N)', async () => {
    const d = repo();
    write(d, 'src/x.ts', lines('x', 2));
    commit(d, 'Unrelated (#12)');
    write(d, 'src/y.ts', lines('y', 3));
    const sha = commit(d, 'Add y (#7)');
    const r = await findStaleCode([link({ oldSourceUrl: 'https://github.com/acme/demo/pull/7' })], { cwd: d });
    expect(r.findings[0]?.commit).toBe(sha);
    expect(r.findings[0]?.totalLines).toBe(3);
  });

  it('skips prose and lockfiles the commit touched', async () => {
    const d = repo();
    write(d, 'README.md', lines('doc', 4));
    write(d, 'package-lock.json', '{}\n');
    write(d, 'src/a.ts', lines('a', 2));
    const sha = commit(d, 'Add a');
    const r = await findStaleCode([link({ oldSourceUrl: `https://github.com/acme/demo/commit/${sha}` })], { cwd: d });
    expect(r.findings[0]?.files.map((f) => f.file)).toEqual(['src/a.ts']);
  });

  it('fails loudly on a shallow clone instead of printing an empty result', async () => {
    const d = repo();
    write(d, 'a.ts', 'one\n'); commit(d, 'one');
    write(d, 'a.ts', 'two\n'); commit(d, 'two');
    const shallow = path.join(mk(), 'clone');
    git(d, 'clone', '-q', '--depth', '1', `file://${d}`, shallow);
    await expect(findStaleCode([link()], { cwd: shallow })).rejects.toThrow(/git fetch --unshallow/);
    await expect(findStaleCode([link()], { cwd: shallow })).rejects.toBeInstanceOf(StaleError);
  });

  it('uses only human-confirmed links by default and labels AI links with --include-ai', async () => {
    const d = repo();
    write(d, 'a.ts', lines('a', 2));
    const sha = commit(d, 'Add a');
    const url = `https://github.com/acme/demo/commit/${sha}`;
    const ai = link({ oldId: 'ai', oldSourceUrl: url, humanConfirmed: false, confidence: 0.72 });
    const def = await findStaleCode([ai], { cwd: d });
    expect(def.findings).toEqual([]);
    expect(def.aiExcluded).toBe(1);
    const inc = await findStaleCode([ai], { cwd: d, includeAi: true });
    expect(inc.findings[0]).toMatchObject({ confirmation: 'ai-suggested', confidence: 0.72 });
    expect(inc.aiExcluded).toBe(0);
  });

  it('reports what it skipped: other repository, missing commit, no commit source', async () => {
    const d = repo();
    write(d, 'a.ts', 'a\n'); commit(d, 'a');
    const r = await findStaleCode([
      link({ oldId: '1', oldSourceUrl: `https://github.com/other/thing/commit/${  'a'.repeat(40)}` }),
      link({ oldId: '2', oldSourceUrl: `https://github.com/acme/demo/commit/${  'b'.repeat(40)}` }),
      link({ oldId: '3', oldSourceUrl: 'https://slack.example.com/x' }),
    ], { cwd: d });
    expect(r.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('other/thing'), 'its commit is not in this clone', expect.stringContaining('not a GitHub commit'),
    ]);
  });

  it('caps files per decision and says so', async () => {
    const d = repo();
    for (const n of ['a', 'b', 'c']) write(d, `${n}.ts`, `${n}\n`);
    const sha = commit(d, 'three files');
    const r = await findStaleCode([link({ oldSourceUrl: `https://github.com/acme/demo/commit/${sha}` })], { cwd: d, maxFilesPerDecision: 2 });
    expect(r.findings[0]?.files).toHaveLength(2);
    expect(r.filesCapped).toBe(1);
  });

  it('stops at the time budget and reports the rest as skipped', async () => {
    const d = repo();
    write(d, 'a.ts', 'a\n');
    const sha = commit(d, 'a');
    const r = await findStaleCode([link({ oldSourceUrl: `https://github.com/acme/demo/commit/${sha}` })], { cwd: d, budgetMs: -1 });
    expect(r.budgetExceeded).toBe(true);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('link sources', () => {
  it('says why a local graph with only relates links is empty', () => {
    const dir = mk();
    const dbPath = path.join(dir, 'g.db');
    const db = createLocalDb(dbPath);
    const a = db.insertDecision({ title: 'A', summary: 's', sourceUrl: null, platform: 'git' });
    const b = db.insertDecision({ title: 'B', summary: 's', sourceUrl: null, platform: 'git' });
    db.insertLink({ sourceId: a, targetId: b, relation: 'relates', confidence: 0.8 });
    db.close();
    const loaded = loadLocalLinks(dbPath);
    expect(loaded.links).toEqual([]);
    expect(loaded.notes).toEqual([LOCAL_EMPTY_NOTE]);
  });

  it('reads local supersedes links: new is the source, a mark: id is a person\'s', () => {
    const dir = mk();
    const dbPath = path.join(dir, 'g.db');
    const db = createLocalDb(dbPath);
    const url = `https://github.com/acme/demo/commit/${  'c'.repeat(40)}`;
    const oldId = db.insertDecision({ title: 'Old', summary: 's', sourceUrl: url, platform: 'github' });
    const newId = db.insertDecision({ title: 'New', summary: 's', sourceUrl: null, platform: 'github' });
    const other = db.insertDecision({ title: 'Other', summary: 's', sourceUrl: null, platform: 'github' });
    db.insertLink({ id: 'mark:1', sourceId: newId, targetId: oldId, relation: 'supersedes', confidence: 1 });
    db.insertLink({ sourceId: other, targetId: oldId, relation: 'supersedes', confidence: 0.7 });
    db.close();
    const { links } = loadLocalLinks(dbPath);
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.newId === newId)).toMatchObject({ oldId, oldTitle: 'Old', oldSourceUrl: url, humanConfirmed: true });
    expect(links.find((l) => l.newId === other)?.humanConfirmed).toBe(false);
  });

  it('reads team links through the gateway client and treats only a non-ai detection_method as confirmed', async () => {
    const client = {
      listDecisionLinks: async () => ({
        total_count: 3,
        links: [
          { id: '1', relation: 'supersedes', from_decision: { id: 'n1', title: 'N1' }, to_decision: { id: 'o1', title: 'O1' }, confidence: 0.9, detection_method: 'manual' },
          { id: '2', relation: 'supersedes', from_decision: { id: 'n2', title: 'N2' }, to_decision: { id: 'o2', title: 'O2' }, confidence: 0.6, detection_method: 'ai' },
          { id: '3', relation: 'supersedes', from_decision: { id: 'n3', title: 'N3' }, to_decision: { id: 'o3', title: 'O3' }, confidence: 0.6 },
        ],
      }),
      getDecision: async (id: string) => ({ source_url: `https://github.com/acme/demo/pull/${id.length}` }),
    };
    const { links, notes } = await loadTeamLinks(client);
    expect(links.map((l) => l.humanConfirmed)).toEqual([true, false, false]);
    expect(links[0]).toMatchObject({ oldId: 'o1', newId: 'n1', oldSourceUrl: 'https://github.com/acme/demo/pull/2' });
    expect(notes).toEqual([]);
  });
});

describe('runStale result shape and the MCP tool', () => {
  it('returns the JSON shape agents read, and says how many AI links were left out', async () => {
    const d = repo();
    write(d, 'a.ts', lines('a', 2));
    const sha = commit(d, 'Add a');
    const client = {
      listDecisionLinks: async () => ({
        total_count: 2,
        links: [
          { id: '1', relation: 'supersedes', from_decision: { id: 'n1', title: 'New one' }, to_decision: { id: 'o1', title: 'Old one' }, confidence: 0.9, detection_method: 'manual' },
          { id: '2', relation: 'supersedes', from_decision: { id: 'n2', title: 'N2' }, to_decision: { id: 'o2', title: 'O2' }, confidence: 0.5, detection_method: 'ai' },
        ],
      }),
      getDecision: async (id: string) => ({ source_url: id === 'o1' ? `https://github.com/acme/demo/commit/${sha}` : null }),
    };
    const env = { mode: 'auth', gatewayUrl: 'x', authToken: 't', tenantId: null } as EnvironmentConfig;
    const { result } = await runStale(env, client, { cwd: d });
    expect(Object.keys(result).sort()).toEqual(['counts', 'findings', 'notes', 'ref', 'skipped']);
    expect(result.findings).toHaveLength(1);
    expect(result.counts).toMatchObject({ linksConsidered: 1, aiExcluded: 1 });
    expect(result.notes.join(' ')).toContain('--include-ai');
  });

  it('registers align_stale_code read-only and after the check', () => {
    expect(TOOL_SCHEMAS[0]?.name).toBe('align_check_alignment');
    const t = TOOL_SCHEMAS.find((s) => s.name === 'align_stale_code');
    expect(t?.annotations.readOnlyHint).toBe(true);
  });

  it('dispatches align_stale_code against the team client', async () => {
    const d = repo();
    write(d, 'a.ts', 'a\n'); commit(d, 'a');
    const prev = process.cwd();
    process.chdir(d);
    try {
      const client = { listDecisionLinks: async () => ({ links: [], total_count: 0 }), getDecision: async () => ({}) };
      const env = { mode: 'auth', gatewayUrl: 'x', authToken: 't', tenantId: null } as EnvironmentConfig;
      const out = await dispatchTool('align_stale_code', {}, client as never, env) as { notes: string[] };
      expect(out.notes.join(' ')).toMatch(/no supersedes links/);
    } finally { process.chdir(prev); }
  });
});
