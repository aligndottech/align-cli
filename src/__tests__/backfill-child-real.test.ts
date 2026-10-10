import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillArgv } from '../lib/mcp-backfill.js';

/**
 * L3 review 1, for real: spawn this CLI's entry as the child `align_backfill` would, in a scratch
 * HOME whose default env is the HOSTED one with a (fake) auth token - the user for whom the bug
 * showed. No vendor is called: the source is deliberately unknown, so the run ends at the local
 * connect's own "Unknown source" refusal, before any token is read or any request is made.
 *
 *  - Control: the SAME child without `--env local` hits the hosted refusal (exit 2, "--from"), so
 *    the scratch config really does make the default env hosted.
 *  - With `--env local` it reaches the local connect instead.
 *  - And it records how it ended in the status file it was given.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let home: string;
let env: Record<string, string | undefined>;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-real-'));
  const cfg = path.join(home, 'config', 'align-cli');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({
    defaultEnv: 'prod',
    environments: { prod: { authToken: 'fake-auth-token-not-a-secret', tenantId: 'tenant-x' } },
    connectorTokens: {},
  }));
  env = {
    PATH: process.env['PATH'], HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
    DO_NOT_TRACK: '1', CI: '1', NO_COLOR: '1',
  };
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function child(argv: string[], extra: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'index.ts'), ...argv], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000, cwd: home,
  });
}

describe('the backfill child against a hosted-default config', () => {
  it('control: without --env local the child is refused by the hosted path (so the config is hosted)', () => {
    const r = child(['connect', '--source', 'nope', '--since', '1y', '--yes', '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--from/);
  }, 120_000);

  it('with the argv the tool builds, it reaches the LOCAL connect instead (no hosted refusal)', () => {
    const r = child(backfillArgv('nope', '1y'));
    expect(r.stderr).not.toMatch(/--from/);
    expect(r.stderr).not.toMatch(/hosted scan/);
    expect(r.stderr).toMatch(/Unknown source nope/);
  }, 120_000);

  it('records how it ended: failed, exit code 2, and the last thing it said', () => {
    const dir = path.join(home, 'state', 'align-cli', 'backfill');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'nope.json');
    child(backfillArgv('nope', '1y'), { ALIGN_BACKFILL_STATUS: file });
    const status = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(status).toMatchObject({ source: 'nope', state: 'failed', exit_code: 2 });
    expect(String(status['last_line'])).toMatch(/Unknown source nope/);
    expect(typeof status['finished_at']).toBe('string');
  }, 120_000);

  it('a bad --since ends "failed" with the reason, even though it fails before any connect code', () => {
    const dir = path.join(home, 'state', 'align-cli', 'backfill');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'github.json');
    child(['connect', '--env', 'local', '--source', 'github', '--since', '6x', '--yes', '--json'], { ALIGN_BACKFILL_STATUS: file });
    const status = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(status).toMatchObject({ source: 'github', state: 'failed', exit_code: 2 });
    expect(String(status['last_line'])).toContain('30d, 2w, 6m, 1y or all');
  }, 120_000);

  it('a command-line parse error also ends "failed" (commander exits before any command runs)', () => {
    const dir = path.join(home, 'state', 'align-cli', 'backfill');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'jira.json');
    child(['connect', '--env', 'local', '--source', 'jira', '--no-such-flag'], { ALIGN_BACKFILL_STATUS: file });
    const status = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(status['state']).toBe('failed');
    expect(status['exit_code']).not.toBe(0);
  }, 120_000);
});
