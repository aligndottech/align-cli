/**
 * The once-a-UTC-day claim behind the agent_active beacon. A hook is a new process per edit, so the
 * claim has to be atomic across processes: read-then-write on the config file lets N parallel edits
 * all pass the check and all send, and conf's whole-file rewrite can also clobber other keys.
 *
 * Test list: first claim of a day wins and a second loses; the next day wins again; a claim removes
 * markers from earlier days; a release lets the same day be claimed again; claiming never touches
 * the config file's other keys; 8 real processes claiming at the same instant produce exactly one winner.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmDir } from './helpers/rm-dir.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configUrl = pathToFileURL(path.join(root, 'src', 'lib', 'config.ts')).href;
const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

let home: string;
const markers = (): string[] => fs.readdirSync(path.join(home, '.align')).filter((f) => f.startsWith('agent-active-')).sort();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-claim-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmDir(home);
});

async function store() {
  const { createConfigStore } = await import('../lib/config.js');
  return createConfigStore();
}

describe('claimAgentActiveDay', () => {
  it('the first claim of a day wins, a second loses, the next day wins again', async () => {
    const c = await store();
    expect(c.claimAgentActiveDay('2026-11-02')).toBe(true);
    expect(c.claimAgentActiveDay('2026-11-02')).toBe(false);
    expect(c.claimAgentActiveDay('2026-11-03')).toBe(true);
  });

  it('a claim deletes the markers of earlier days and keeps today\'s', async () => {
    const c = await store();
    c.claimAgentActiveDay('2026-11-01');
    c.claimAgentActiveDay('2026-11-02');
    expect(markers()).toEqual(['agent-active-2026-11-02']);
  });

  it('a release lets the same day be claimed again', async () => {
    const c = await store();
    expect(c.claimAgentActiveDay('2026-11-02')).toBe(true);
    c.releaseAgentActiveDay('2026-11-02');
    expect(markers()).toEqual([]);
    expect(c.claimAgentActiveDay('2026-11-02')).toBe(true);
  });

  it('claiming leaves the config file\'s own keys alone', async () => {
    const c = await store();
    c.markTelemetryNoticeShown();
    const before = c.getTelemetryNoticeShownAt();
    expect(before).toBeDefined();
    c.claimAgentActiveDay('2026-11-02');
    expect((await store()).getTelemetryNoticeShownAt()).toBe(before);
  });

  it('8 real processes claiming at the same instant: exactly one wins', async () => {
    fs.mkdirSync(path.join(home, '.align'), { recursive: true });
    const script = path.join(home, 'claim.mjs');
    fs.writeFileSync(script, `
      const { createConfigStore } = await import(${JSON.stringify(configUrl)});
      const c = createConfigStore();
      while (Date.now() < Number(process.env.GO_AT)) { /* spin to the shared start */ }
      process.stdout.write(String(c.claimAgentActiveDay('2026-11-02')));
    `);
    const goAt = String(Date.now() + 4000);
    const outs = await Promise.all(Array.from({ length: 8 }, () =>
      run(process.execPath, ['--import', tsx, script], { env: { ...process.env, HOME: home, USERPROFILE: home, GO_AT: goAt }, cwd: root }).then((r) => r.stdout)));
    expect(outs.filter((o) => o === 'true')).toHaveLength(1);
    expect(outs.filter((o) => o === 'false')).toHaveLength(7);
  });
});
