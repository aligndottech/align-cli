/**
 * A connector row is visible from a repo when that repo's own chosen scope for the connector includes the row's unit
 * (Jira project, Linear team, Confluence space). Repos that chose different units do not see each other's rows, repos
 * that chose the same unit all see it, and a row with no unit (older rows, Slack, Teams, Zoom, Notion) is visible everywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  cosineSimilarity: vi.fn(() => 0.9),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createConfigStore } from '../lib/config.js';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { scopeUnitOf } from '../lib/scope-unit.js';

let tmp: string;
let dbPath: string;
const dirs: Record<string, string> = {};
const clients: Array<ReturnType<typeof createLocalGatewayClient>> = [];
const ident = (n: string) => `github.com/acme/${n}`;

function open(cwd?: string) {
  const c = createLocalGatewayClient(dbPath, cwd ? { cwd } : {});
  clients.push(c);
  return c;
}
async function repoDir(name: string): Promise<string> {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  await execa('git', ['init'], { cwd: d });
  await execa('git', ['remote', 'add', 'origin', `git@github.com:acme/${name}.git`], { cwd: d });
  return d;
}
function choose(repo: string, source: string, labels: string[]) {
  createConfigStore().setConnectorScope('local', source, { kind: 'team', values: labels, labels }, ident(repo));
}
const titlesIn = async (repo: string) => (await open(dirs[repo]).listDecisions({})).map((r) => r.title).sort();
const jira = (key: string, n: number) => ({ source_url: `https://acme.atlassian.net/browse/${key}-${n}`, platform: 'jira', raw_text: `${key} item ${n}`, title: `${key}-${n}` });
const imp = { classify: false, keyed: true } as const;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-visibility-'));
  dbPath = path.join(tmp, 'graph.db');
  for (const n of ['client-a', 'client-b', 'client-c']) {
    dirs[n] = await repoDir(n);
    for (const source of ['jira', 'linear', 'confluence']) createConfigStore().clearConnectorScope('local', source, ident(n)); // the config file outlives a test
  }
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scopeUnitOf', () => {
  it('reads the unit from each connector URL, and gives null where the URL names none', () => {
    expect(scopeUnitOf('jira', 'https://x.atlassian.net/browse/ali-12')).toBe('jira:ALI');
    expect(scopeUnitOf('jira', 'https://api.atlassian.com/ex/jira/abc/browse/OPS_1-3')).toBe('jira:OPS_1');
    expect(scopeUnitOf('linear', 'https://linear.app/acme/issue/ENG-12/some-title')).toBe('linear:ENG');
    expect(scopeUnitOf('confluence', 'https://x.atlassian.net/wiki/spaces/Docs/pages/123/Title')).toBe('confluence:DOCS');
    expect(scopeUnitOf('confluence', 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=1')).toBeNull();
    expect(scopeUnitOf('slack', 'https://x.slack.com/archives/C1/p1')).toBeNull();
    expect(scopeUnitOf('jira', null)).toBeNull();
  });
});

describe('connector rows follow the repo\'s chosen scope', () => {
  it('two repos that chose different Jira projects do not see each other\'s rows', async () => {
    choose('client-a', 'jira', ['ALPHA']);
    choose('client-b', 'jira', ['BETA']);
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    await open(dirs['client-b']).ingestBatch([jira('BETA', 1)], imp);

    expect(await titlesIn('client-a')).toEqual(['ALPHA-1']);
    expect(await titlesIn('client-b')).toEqual(['BETA-1']);
  });

  it('three repos that chose the same Jira project all see its rows', async () => {
    for (const r of ['client-a', 'client-b', 'client-c']) choose(r, 'jira', ['TEAM']);
    await open(dirs['client-a']).ingestBatch([jira('TEAM', 1)], imp);
    await open(dirs['client-b']).ingestBatch([jira('TEAM', 1), jira('TEAM', 2)], imp);

    for (const r of ['client-a', 'client-b', 'client-c']) expect(await titlesIn(r)).toEqual(['TEAM-1', 'TEAM-2']);
  });

  it('search is scoped the same way as listing', async () => {
    choose('client-a', 'jira', ['ALPHA']);
    choose('client-b', 'jira', ['BETA']);
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    await open(dirs['client-a']).ingestBatch([jira('BETA', 1)], imp);
    const res = await open(dirs['client-b']).searchDecisions('item', 10);
    expect(res.results.map((r) => r.title)).toEqual(['BETA-1']);
  });

  it('a repo that skips the connector sees none of its unit rows', async () => {
    createConfigStore().setConnectorScope('local', 'jira', { kind: 'skip' }, ident('client-b'));
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    expect(await titlesIn('client-b')).toEqual([]);
  });

  it('a repo with no choice, or with "yours", sees every Jira row', async () => {
    createConfigStore().setConnectorScope('local', 'jira', { kind: 'yours' }, ident('client-b'));
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1), jira('BETA', 1)], imp);
    expect(await titlesIn('client-b')).toEqual(['ALPHA-1', 'BETA-1']);
    expect(await titlesIn('client-c')).toEqual(['ALPHA-1', 'BETA-1']);
  });

  it('a row with no unit is visible from every repo, whatever they chose', async () => {
    choose('client-b', 'jira', ['BETA']);
    await open(dirs['client-a']).ingestBatch([
      { source_url: 'https://x.slack.com/archives/C1/p1', platform: 'slack', raw_text: 'rotate keys', title: 'Rotate keys' },
    ], imp);
    expect(await titlesIn('client-b')).toEqual(['Rotate keys']);
  });

  it('a legacy row stored before units existed stays visible, and is given its unit when a sync reads it again', async () => {
    choose('client-b', 'jira', ['BETA']);
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    const raw = new DatabaseSync(dbPath);
    raw.exec('UPDATE decisions SET scope_unit = NULL');
    expect(await titlesIn('client-b')).toEqual(['ALPHA-1']);
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    expect((raw.prepare('SELECT scope_unit AS u FROM decisions').get() as { u: string }).u).toBe('jira:ALPHA');
    raw.close();
    expect(await titlesIn('client-b')).toEqual([]);
  });

  it('--all shows every unit', async () => {
    choose('client-b', 'jira', ['BETA']);
    await open(dirs['client-a']).ingestBatch([jira('ALPHA', 1)], imp);
    expect(await open(dirs['client-b']).listDecisions({ all: true })).toHaveLength(1);
  });
});

describe('the scope_unit column', () => {
  it('is added to a graph that predates it, without losing the row, which stays unit-less', () => {
    createLocalDb(dbPath).close();
    const old = new DatabaseSync(dbPath);
    old.exec('ALTER TABLE decisions DROP COLUMN scope_unit');
    old.exec("INSERT INTO decisions (id, title, summary, platform) VALUES ('x', 'old', 's', 'jira')");
    old.close();

    createLocalDb(dbPath).close();
    const after = new DatabaseSync(dbPath);
    const cols = (after.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('scope_unit');
    expect((after.prepare("SELECT scope_unit AS u FROM decisions WHERE id = 'x'").get() as { u: string | null }).u).toBeNull();
    after.close();
  });

  it('opening the migrated graph twice does not fail on the existing column', () => {
    createLocalDb(dbPath).close();
    expect(() => createLocalDb(dbPath).close()).not.toThrow();
  });
});
