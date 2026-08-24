/**
 * ALI-602: the local-embedded client needs listDecisions, or `align context
 * sync --env local` - the no-account cold path, the launch story - dies with
 * "listDecisions is not a function" while the graph sits on disk.
 *
 * Test List:
 * 1. returns rows from the local DB with title and source_url
 * 2. respects the limit param
 * 3. rows carry the derived cite, matching what searchDecisions already does
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali602-local-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  db.insertDecision({
    title: 'Use Postgres 16 for new services',
    summary: 'summary a',
    sourceUrl: 'https://github.com/acme/api/pull/1441',
    platform: 'github',
  });
  db.insertDecision({
    title: 'Synchronous gRPC for service calls',
    summary: 'summary b',
    sourceUrl: null,
    platform: 'cli',
  });
  db.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local client listDecisions', () => {
  it('returns rows from the local DB with title and source_url', async () => {
    const client = createLocalGatewayClient(dbPath);
    const rows = await client.listDecisions();
    expect(rows).toHaveLength(2);
    const titles = rows.map((r: { title: string }) => r.title);
    expect(titles).toContain('Use Postgres 16 for new services');
    const pg = rows.find((r: { title: string }) => r.title.startsWith('Use Postgres'));
    expect(pg?.source_url).toBe('https://github.com/acme/api/pull/1441');
  });

  it('respects the limit param', async () => {
    const client = createLocalGatewayClient(dbPath);
    const rows = await client.listDecisions({ limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it('rows carry the derived cite, matching searchDecisions', async () => {
    const client = createLocalGatewayClient(dbPath);
    const rows = await client.listDecisions();
    const pg = rows.find((r: { title: string }) => r.title.startsWith('Use Postgres'));
    expect(pg?.cite).toBe('api#1441');
    // And a row with no source_url must not fabricate one (absent beats wrong).
    const grpc = rows.find((r: { title: string }) => r.title.startsWith('Synchronous'));
    expect(grpc?.cite).toBeUndefined();
  });
});
