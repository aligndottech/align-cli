import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { leadBody, LEAD_CONSENT_VERSION } from '../lib/lead-prompt.js';

/**
 * The lead route's contract is owned by align-stack. This repo keeps a vendored copy and builds its request from it.
 */
const FILE = path.join(__dirname, 'fixtures', 'lead-contract.json');
const PIN = 'c66503d794e46e13afd271c936b95d5d2835c8571e2725f69200f8de728f43c6';

describe('the vendored lead contract', () => {
  it('has not been edited by hand', () => {
    const got = crypto.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex');
    expect(got, 'fixtures/lead-contract.json changed. The contract belongs to align-stack: re-vendor it from align-stack (the file the gateway writes as lead-contract/contract.json), then update PIN here in the same commit. Do not edit the fixture by hand.').toBe(PIN);
  });
  it('lists the fields the CLI sends, and the CLI sends nothing the contract does not list', () => {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { endpoint: string; request: Record<string, unknown> };
    expect(c.endpoint).toBe('POST /leads/team-interest');
    const body = leadBody('a@b.co');
    for (const k of Object.keys(body)) expect(Object.keys(c.request), `the CLI sends "${k}", which the contract does not list`).toContain(k);
    for (const k of ['email', 'source', 'consent_version']) expect(Object.keys(body)).toContain(k);
    expect(c.request['source']).toBe('cli-share');
    expect(body.source).toBe('cli-share');
  });
  it('keeps the consent version inside the contract limit', () => {
    expect(LEAD_CONSENT_VERSION.length).toBeLessThanOrEqual(64);
    expect(leadBody('a@b.co').cli_version!.length).toBeLessThanOrEqual(32);
  });
});
