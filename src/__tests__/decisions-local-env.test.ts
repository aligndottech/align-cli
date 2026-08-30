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

/**
 * The list header printed `opts.env` - the FLAG - so a bare `align decisions list` rendered
 * "Decisions (undefined)". It was invisible while the bare command 401'd before reaching the
 * header; removing that 401 (ALI-772) is what surfaced it.
 */
describe('decisions list header', () => {
  it('names the env it resolved to, not the flag that was not passed', () => {
    const src = fs.readFileSync(new URL('../commands/decisions/index.ts', import.meta.url), 'utf8');
    // A positive control first: the header line is still there to be checked.
    expect(src).toMatch(/Decisions \(\$\{/);
    expect(src).not.toMatch(/Decisions \(\$\{opts\.env\}\)/);
    expect(src).toMatch(/Decisions \(\$\{envName\}\)/);
  });
});

/**
 * A local graph has no web UI. `decisions show` printed
 * "View: http://localhost:5173/decisions/<id>" to a local-only user - a dev server that is
 * not running on their machine and never will be.
 */
describe('decisions show: the View link', () => {
  it('is suppressed for the local graph and kept for a cloud one', () => {
    const src = fs.readFileSync(new URL('../commands/decisions/index.ts', import.meta.url), 'utf8');
    // Positive control: the line still exists to be conditioned.
    expect(src).toMatch(/View: \$\{resolveAppUrl/);
    expect(src).toMatch(/if \(envName !== 'local'\) \{/);
  });
});
