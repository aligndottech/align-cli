import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

/**
 * ALI-772. `align decisions list` 401'd for a no-account local user: `decisions` was left off
 * the preferLocalEmbedded redirect that ask, search and import have, so the obvious command
 * for "show me my graph" resolved to an unauthenticated cloud default.
 *
 * It could not simply be added, because the same command file calls getDecision, which the
 * local client did not implement - redirecting would have turned a 401 into a TypeError. So
 * the client gets the method, and then the redirect is safe.
 */
describe('local client: getDecision', () => {
  let dir: string;
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-getdec-'));
    dbPath = path.join(dir, 'local.db');
  });
  afterEach(() => {
    // Closed before the directory goes, or Windows refuses to unlink a file that is still
    // open: "EBUSY: resource busy or locked". Linux unlinks an open file happily, so this
    // only ever fails on the windows leg - which is exactly what it did.
    client?.close();
    client = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the decision the graph holds', async () => {
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'Use Postgres', summary: 'concurrent writers', sourceUrl: 'git://commit/a', platform: 'git' });
    db.close();

    client = createLocalGatewayClient(dbPath);
    const d = await client.getDecision(id);
    expect(d.id).toBe(id);
    expect(d.title).toBe('Use Postgres');
    expect(d.summary).toBe('concurrent writers');
    expect(d.platform).toBe('git');
  });

  /**
   * A missing id must be an error a person can act on. Returning null would surface as
   * "Cannot read properties of null (reading 'id')" from the renderer, which is the raw
   * stack trace this CLI's fatal handler exists to avoid.
   */
  it('throws a message naming the id when the graph does not hold it', async () => {
    const db = createLocalDb(dbPath);
    db.close();
    client = createLocalGatewayClient(dbPath);
    await expect(client.getDecision('nope-1234')).rejects.toThrow(/nope-1234/);
  });
});
