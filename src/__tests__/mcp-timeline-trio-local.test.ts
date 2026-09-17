/**
 * ALI-1070: which of the timeline trio local mode can actually serve.
 *
 * Local mode is selected by a persisted `mode` field, not by a missing token, and the
 * cloud/local split is enforced by a Proxy in gateway-client.ts whose `get` trap throws a
 * message naming the limit. That Proxy passes a method straight through when the local client
 * HAS it (`prop in target`), so which tools work locally is decided by the local client's
 * method list, not by anything in mcp.ts.
 *
 * The brief for this slice assumed all three would hit the stub. Two do. `getDecision` is
 * already implemented locally, so routing the rationale tool through it - rather than adding
 * a second client method for the same `GET /snapshots/:id` - makes that tool work locally for
 * free. This file is the measurement rather than the assumption, in both directions: a test
 * that only asserted the stub fires would pass against a client where NOTHING worked, and one
 * that only asserted rationale works would pass against one where the split had collapsed.
 *
 * Test List:
 * 1. the rationale tool reaches the local graph - NOT the cloud-only stub
 * 2. it answers honestly for an id the local graph does not hold
 * 3. the topic-timeline tool hits the stub, which names the limit
 * 4. the decision-timeline tool hits the stub, which names the limit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLocalDb } from '../lib/local-db.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';

let dir: string;
let dbPath: string;
let decisionId: string;
let client: ReturnType<typeof createGatewayClient> | undefined;

/** The message the local-mode Proxy throws for a cloud-only method. */
const CLOUD_ONLY = /is not available in local mode/;

function localEnv(): EnvironmentConfig {
  return {
    gatewayUrl: 'http://localhost:8080',
    authToken: null,
    tenantId: null,
    mode: 'local-embedded',
    localDbPath: dbPath,
  };
}

beforeEach(() => {
  client = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali1070-local-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  db.insertDecision({
    title: 'Verify webhook signatures with HMAC',
    summary: 'Reject unsigned webhooks.',
    sourceUrl: 'https://github.com/acme/api/pull/1441',
    platform: 'github',
  });
  const rows = db.listDecisions({ limit: 5 });
  decisionId = rows[0]!.id;
  db.close();
});

afterEach(() => {
  // Windows refuses to unlink an open SQLite file (EBUSY), so a leaked handle fails only on
  // that OS - the shape the cross-platform job exists to catch.
  client?.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ALI-1070 in local mode', () => {
  it('serves the rationale tool from the local graph, not the cloud-only stub', async () => {
    client = createGatewayClient(localEnv());
    const row = (await dispatchTool(
      'align_get_decision_rationale',
      { decision_id: decisionId },
      client,
      localEnv(),
    )) as Record<string, unknown>;
    // The id asserts it answered about the decision asked for, not merely that it returned
    // an object: a stub that returned {} would satisfy a bare "did not throw".
    //
    // `decision_id`, not `id`: the ALI-1070 follow-up projects the row through
    // shapeDecisionRationale, because the serializer strips `decision_json` and every field
    // this tool promises lives inside it. The projection runs on the local path too, which
    // the rationale assertion below is what actually proves.
    expect(row['decision_id']).toBe(decisionId);
    expect(row['title']).toBe('Verify webhook signatures with HMAC');
    // A local row carries no decision_json, so the rationale falls back to the summary rather
    // than to an empty string. Thinner than cloud, not broken - and a raw pass-through would
    // have no `rationale` key at all.
    expect(row['rationale']).toBe('Reject unsigned webhooks.');
    expect(row['goals']).toEqual([]);
  });

  it('says what it does not hold, rather than reporting an empty answer', async () => {
    client = createGatewayClient(localEnv());
    await expect(
      dispatchTool('align_get_decision_rationale', { decision_id: 'nope' }, client, localEnv()),
    ).rejects.toThrow(/No decision nope in your local graph/);
    // The key distinction: this is the LOCAL client's honest miss, not the Proxy's stub. If
    // the tool were routed at a cloud-only method the message would be CLOUD_ONLY instead,
    // and both are throws - so the assertion has to name which one.
    await expect(
      dispatchTool('align_get_decision_rationale', { decision_id: 'nope' }, client, localEnv()),
    ).rejects.not.toThrow(CLOUD_ONLY);
  });

  it.each([
    ['align_get_topic_timeline', { topic: 'webhooks' }],
    ['align_get_decision_timeline', { decision_id: 'd1' }],
  ])('degrades %s to the stub, which names the limit', async (name, args) => {
    client = createGatewayClient(localEnv());
    await expect(
      dispatchTool(name, args as Record<string, unknown>, client, localEnv()),
    ).rejects.toThrow(CLOUD_ONLY);
  });
});
