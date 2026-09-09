/**
 * ALI-954: docs match behaviour, by construction. `docs/telemetry.md` is the public page that
 * lists every event and every field for both tiers (the default-on beacons, and usage with
 * consent). This test sends each event through the real emitters with fetch mocked, then
 * reads the page and compares field sets by EQUALITY in both directions - so a field added
 * to a payload fails until it is documented, and a documented field that is no longer sent
 * fails until the page is corrected. The page is the promise; this is what keeps it true.
 *
 * Section contract (the parse raises on a missing section or an empty field table, so a
 * renamed heading cannot pass vacuously): one `### \`<event>\` ...` heading per event, and
 * under it a table whose first column is the field name in backticks. Nested JSON fields are
 * written with a dot (`properties.command`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const getTelemetryConsent = vi.fn();
const getInstallId = vi.fn();
const wasFunnelStageRecorded = vi.fn();
const markFunnelStageRecorded = vi.fn();
const getEnvironment = vi.fn();
const INSTALL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOSTED_URL = vi.hoisted(() => 'https://api.align.tech');

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent,
    getInstallId,
    wasFunnelStageRecorded,
    markFunnelStageRecorded,
    getEnvironment,
  }),
  ALIGN_HOSTED_GATEWAY_URL: HOSTED_URL,
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

import {
  BEACON_STAGES,
  FUNNEL_STAGES,
  recordCommandUsage,
  recordFunnelStage,
  recordInstallBeacon,
} from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DOC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'telemetry.md'), 'utf8');

const localEnv: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };
const cloudEnv: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 'token-1', tenantId: 'tenant-1', mode: 'auth' };

function documentedFields(heading: string): string[] {
  const sections = DOC.split(/^### /m);
  const section = sections.find((s) => s.startsWith(heading));
  if (!section) throw new Error(`docs/telemetry.md has no "### ${heading}" section`);
  const fields = [...section.matchAll(/^\| `([A-Za-z0-9_.]+)`/gm)].map((m) => m[1] as string);
  if (fields.length === 0) throw new Error(`docs/telemetry.md section "${heading}" lists no fields`);
  return fields.sort();
}

/** Flattens {a, b: {c}} to ['a', 'b.c'], the spelling the page uses for nested fields. */
function sentFields(): string[] {
  const args = mockFetch.mock.calls[0];
  if (!args) throw new Error('fetch was not called');
  const init = args[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error('fetch was called without a body');
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const flat: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const inner of Object.keys(v as Record<string, unknown>)) flat.push(`${k}.${inner}`);
    } else {
      flat.push(k);
    }
  }
  return flat.sort();
}

describe('docs/telemetry.md matches what the CLI sends', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    getTelemetryConsent.mockReset().mockReturnValue(undefined);
    getInstallId.mockReset().mockReturnValue(INSTALL_ID);
    wasFunnelStageRecorded.mockReset().mockReturnValue(false);
    markFunnelStageRecorded.mockReset();
    getEnvironment.mockReset().mockReturnValue({ ...cloudEnv, authToken: null, tenantId: null });
    vi.stubEnv('ALIGN_TELEMETRY', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('the install beacon', async () => {
    await recordInstallBeacon('align');
    expect(sentFields()).toEqual(documentedFields('`cli.funnel.install`'));
  });

  it('the setup_completed beacon (sent without consent)', async () => {
    await recordFunnelStage(localEnv, 'setup_completed', 'setup');
    expect(sentFields()).toEqual(documentedFields('`cli.funnel.setup_completed`'));
  });

  it('a local-mode command ping (consent required)', async () => {
    getTelemetryConsent.mockReturnValue('granted');
    await recordCommandUsage(localEnv, 'ask');
    expect(sentFields()).toEqual(documentedFields('`cli.command` (local mode)'));
  });

  it('a local-mode consented funnel stage', async () => {
    getTelemetryConsent.mockReturnValue('granted');
    await recordFunnelStage(localEnv, 'first_useful_decision', 'ask');
    expect(sentFields()).toEqual(documentedFields('`cli.funnel.<stage>` (local mode)'));
  });

  it('a cloud-mode command event', async () => {
    await recordCommandUsage(cloudEnv, 'ask');
    expect(sentFields()).toEqual(documentedFields('`cli.command` (cloud mode)'));
  });

  it('a cloud-mode funnel stage', async () => {
    await recordFunnelStage(cloudEnv, 'mcp_wired', 'mcp');
    expect(sentFields()).toEqual(documentedFields('`cli.funnel.<stage>` (cloud mode)'));
  });

  // The stage NAMES are part of the promise too: every stage the CLI can send is named on
  // the page, on the tier it belongs to.
  it('names every beacon stage under the beacons heading and every consented stage under consent', () => {
    const [, beaconsHalf = '', consentHalf = ''] = DOC.split(/^## /m).reduce<string[]>(
      (acc, s) => {
        if (s.startsWith('Sent by default')) acc[1] = s;
        if (s.startsWith('Sent only with your consent')) acc[2] = s;
        return acc;
      },
      ['', '', ''],
    );
    expect(beaconsHalf.length).toBeGreaterThan(0);
    expect(consentHalf.length).toBeGreaterThan(0);
    const consented = FUNNEL_STAGES.filter((s) => !(BEACON_STAGES as readonly string[]).includes(s));
    expect(consented.length).toBeGreaterThan(0); // positive control for the filter
    for (const stage of BEACON_STAGES) expect(beaconsHalf).toContain(`\`${stage}\``);
    for (const stage of consented) expect(consentHalf).toContain(`\`${stage}\``);
  });
});
