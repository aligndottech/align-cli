/**
 * A connector import (Slack, Jira, ...) is stamped with the repo whose run read it, so a local
 * graph that holds two repos' connector rows does not show one repo's rows inside the other.
 * A foreground import knows its repo from the folder; a background sync child runs from the
 * home directory and is told its repo in SYNC_REPO_ENV. A run with no repo at all stays unattributed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  cosineSimilarity: vi.fn(() => 0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { SYNC_REPO_ENV } from '../lib/repo-identity.js';

let tmp: string;
let dbPath: string;
let dirA: string;
let dirB: string;
const clients: Array<ReturnType<typeof createLocalGatewayClient>> = [];

function open(cwd?: string) {
  const c = createLocalGatewayClient(dbPath, cwd ? { cwd } : {});
  clients.push(c);
  return c;
}

async function repoDir(name: string, remote: string): Promise<string> {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  await execa('git', ['init'], { cwd: d });
  await execa('git', ['remote', 'add', 'origin', remote], { cwd: d });
  return d;
}

const importOpts = { classify: false, keyed: true } as const;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-attribution-'));
  dbPath = path.join(tmp, 'graph.db');
  dirA = await repoDir('a', 'git@github.com:acme/client-a.git');
  dirB = await repoDir('b', 'git@github.com:acme/client-b.git');
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('connector rows are attributed to the repo whose run imported them', () => {
  it('a foreground import in repo A is not listed in repo B, and B keeps its own', async () => {
    await open(dirA).ingestBatch([{ source_url: 'https://a.slack.com/archives/C1/p1', platform: 'slack', raw_text: 'Client A: ship the invoice export', title: 'A invoice export' }], importOpts);
    await open(dirB).ingestBatch([{ source_url: 'https://b.atlassian.net/browse/B-1', platform: 'jira', raw_text: 'Client B: move billing to Stripe', title: 'B billing' }], importOpts);

    expect((await open(dirB).listDecisions({})).map((r) => r.title)).toEqual(['B billing']);
    expect((await open(dirA).listDecisions({})).map((r) => r.title)).toEqual(['A invoice export']);
  });

  it('a background child reads its repo from SYNC_REPO_ENV even though it runs outside any repo', async () => {
    vi.stubEnv(SYNC_REPO_ENV, 'github.com/acme/client-a');
    await open(tmp).ingestBatch([{ source_url: 'https://a.slack.com/archives/C1/p1', platform: 'slack', raw_text: 'Client A: ship the invoice export', title: 'A invoice export' }], importOpts);
    vi.stubEnv(SYNC_REPO_ENV, '');

    expect(await open(dirB).listDecisions({})).toEqual([]);
    expect((await open(dirA).listDecisions({})).map((r) => r.title)).toEqual(['A invoice export']);
  });

  it('a run with no repo leaves the row unattributed, visible from every repo', async () => {
    vi.stubEnv(SYNC_REPO_ENV, '');
    await open(tmp).ingestBatch([{ source_url: 'https://a.slack.com/archives/C1/p1', platform: 'slack', raw_text: 'Company wide: rotate keys quarterly', title: 'Rotate keys' }], importOpts);

    expect((await open(dirA).listDecisions({})).map((r) => r.title)).toEqual(['Rotate keys']);
    expect((await open(dirB).listDecisions({})).map((r) => r.title)).toEqual(['Rotate keys']);
  });

  it('a hand capture of a Slack link is still not attributed to the folder it ran in', async () => {
    await open(dirA).ingestBatch([{ source_url: 'https://a.slack.com/archives/C1/p9', platform: 'slack', raw_text: 'Shared: use SSO', title: 'Use SSO' }]);

    expect((await open(dirB).listDecisions({})).map((r) => r.title)).toEqual(['Use SSO']);
  });
});
