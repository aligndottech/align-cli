import { rmDir } from './helpers/rm-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBackfillChild } from '../lib/backfill-state.js';
import { CHILD_ENV_KEYS } from '../lib/launch/mcp-child-env.js';
import { inCi } from '../lib/telemetry-ci.js';
import { startSyncChild, SYNC_CHILD_ALIGN_NAMES, syncChildEnv } from '../lib/sync/spawn-background.js';
import { telemetryDisabledByEnv } from '../lib/telemetry-env.js';

/**
 * L6 Test List (the detached child the launcher starts):
 * - It gets an allow-listed environment: where things live and how to reach the network are kept;
 *   an agent's provider keys, cloud credentials and align's own token are not (two examples each side).
 * - startSyncChild hands that reduced env to the starter.
 * - A real child: no controlling terminal and its own session (it survives the terminal closing),
 *   stdin is not the launcher's, it is reaped when it exits (no zombie), and it sees none of the secrets.
 */
const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-planted', OPENAI_API_KEY: 'sk-planted', GEMINI_API_KEY: 'g-planted', GITHUB_TOKEN: 'ghp_planted',
  AWS_SECRET_ACCESS_KEY: 'aws-planted', ALIGN_TOKEN: 'al-planted', ALIGN_LLM_API_KEY: 'llm-planted', DATABASE_URL: 'postgres://u:p@h/db',
  SSH_AUTH_SOCK: '/tmp/agent.sock', ALIGN_FUTURE_API_KEY: 'future-planted',
};
const KEPT = {
  PATH: '/usr/bin', HOME: '/home/u', XDG_STATE_HOME: '/state', XDG_CONFIG_HOME: '/cfg', HTTPS_PROXY: 'http://proxy:3128',
  NODE_EXTRA_CA_CERTS: '/ca.pem', ALIGN_MODEL_CACHE: '/models', ALIGN_ENV: 'local', DO_NOT_TRACK: '1', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', SystemRoot: 'C:\\Windows',
};

describe('syncChildEnv: an allow-list, not a copy', () => {
  it('keeps where things live and how to reach the network', () => {
    expect(syncChildEnv({ ...KEPT, ...SECRETS })).toMatchObject(KEPT);
  });
  it('drops every credential an agent or the launcher holds, including a future ALIGN_*_KEY', () => {
    const out = syncChildEnv({ ...KEPT, ...SECRETS });
    for (const name of Object.keys(SECRETS)) expect(out, name).not.toHaveProperty(name);
  });
  it('drops a name nobody listed, and launcher-only switches', () => {
    const out = syncChildEnv({ ...KEPT, MY_APP_SETTING: '1', ALIGN_WRAPPED: '1', ALIGN_NO_LAUNCH: '1', ALIGN_LAUNCH_TRACE: '1', ALIGN_LAUNCH_DRY_RUN: '1' });
    expect(out).toEqual(KEPT);
  });
  it('skips undefined values', () => {
    expect(syncChildEnv({ PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' });
  });
});

describe('startSyncChild passes the reduced environment to the starter', () => {
  it('the starter receives no secret and the sources and delay in argv', async () => {
    const start = vi.fn(async () => ({ ok: true, pid: 9 }));
    await startSyncChild(['github'], { delaySeconds: 20, start, env: { ...KEPT, ...SECRETS } });
    const call = start.mock.calls[0] as unknown as [string, string[], unknown, unknown, string, Record<string, string>];
    expect(call[1]).toEqual(['sync', '--background', '--delay', '20', 'github']);
    expect(call[5]).toEqual(KEPT);
  });
});

describe('syncChildEnv keeps CI detection (the provider variables are dropped, so CI is said outright)', () => {
  it('a parent that is in CI gives the child CI=true; a parent that is not gives no CI (two examples each)', () => {
    expect(inCi(syncChildEnv({ JENKINS_URL: 'x', BUILD_NUMBER: '1' }))).toBe(true);
    expect(inCi(syncChildEnv({ GITHUB_ACTIONS: 'true' }))).toBe(true);
    expect(syncChildEnv({ PATH: '/bin' })).not.toHaveProperty('CI');
    expect(inCi(syncChildEnv({ PATH: '/bin', HOME: '/h' }))).toBe(false);
  });
  it('an explicit CI=false stays false', () => {
    expect(syncChildEnv({ CI: 'false', JENKINS_URL: 'x' })['CI']).toBe('false');
  });
});

describe('syncChildEnv: the value rules are mcp-child-env.ts\'s', () => {
  it('a credentialed proxy URL, a relative certificate path and a relative XDG path are dropped; plain ones are kept (two examples each)', () => {
    const bad = syncChildEnv({ HTTPS_PROXY: 'http://bob:pw@proxy:8080', ALIGN_GATEWAY_URL: 'https://gw/?key=1', NODE_EXTRA_CA_CERTS: './ca.pem', SSL_CERT_FILE: 'ca.pem', XDG_CONFIG_HOME: './c', XDG_DATA_HOME: 'd' });
    expect(bad).toEqual({});
    const good = syncChildEnv({ HTTPS_PROXY: 'http://proxy:3128', ALIGN_GATEWAY_URL: 'https://gw.example', NODE_EXTRA_CA_CERTS: path.resolve('/etc/ca.pem'), XDG_STATE_HOME: path.resolve('/s') });
    expect(Object.keys(good).sort()).toEqual(['ALIGN_GATEWAY_URL', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'XDG_STATE_HOME']);
  });
  it('code-loading switches are blank: NODE_OPTIONS, NODE_PATH, LD_PRELOAD never reach the child', () => {
    expect(syncChildEnv({ NODE_OPTIONS: '--require /x.js', NODE_PATH: '/p', LD_PRELOAD: '/x.so', DYLD_INSERT_LIBRARIES: '/d', NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toEqual({});
  });
  it('ALIGN_* is an exact list: credential-shaped names that no prefix rule would catch are dropped, and the names the child reads are kept', () => {
    const planted = { ALIGN_AUTH_HEADER: 'a', ALIGN_COOKIE: 'c', ALIGN_PAT: 'p', ALIGN_PASS: 'p', ALIGN_PWD: 'p', ALIGN_DB_DSN: 'd', ALIGN_BEARER: 'b', ALIGN_SESSION: 's', ALIGN_LLM_PROVIDER: 'x', ALIGN_FOO: 'y' };
    expect(syncChildEnv(planted)).toEqual({});
    const kept = Object.fromEntries(SYNC_CHILD_ALIGN_NAMES.map((n) => [n, n === 'ALIGN_GATEWAY_URL' ? 'https://gw.example' : '1']));
    expect(syncChildEnv(kept)).toEqual(kept);
  });
  it('every name on the ALIGN list is one align reads at all (the MCP block lists every read)', () => {
    for (const n of SYNC_CHILD_ALIGN_NAMES) expect(CHILD_ENV_KEYS, n).toContain(n);
  });
  it('the user\'s own opt-outs reach the child: DO_NOT_TRACK, CI and ALIGN_TELEMETRY', () => {
    expect(syncChildEnv({ DO_NOT_TRACK: '1', CI: 'true', ALIGN_TELEMETRY: '0' })).toEqual({ DO_NOT_TRACK: '1', CI: 'true', ALIGN_TELEMETRY: '0' });
    expect(syncChildEnv({ DO_NOT_TRACK: '1', CI: 'true' })).toEqual({ DO_NOT_TRACK: '1', CI: 'true' });
  });
});

describe.skipIf(process.platform === 'win32')('a real detached child', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-child-')); });
  afterEach(() => { vi.unstubAllEnvs(); rmDir(dir); });

  const ps = (pid: number, col: string): string => {
    try { return execFileSync('ps', ['-o', `${col}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
  };
  const wait = async (file: string): Promise<void> => {
    for (let i = 0; i < 1200 && !fs.existsSync(file); i++) await new Promise((res) => setTimeout(res, 50));
    if (!fs.existsSync(file)) throw new Error('the child never wrote its dump (it failed to start or to introspect itself)');
  };
  const dump = (out: string): string => `
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    // \`ps\` keywords differ: macOS has no \`sid\`. A column it cannot print is '' and is not asserted; the child never dies for want of one.
    const ps = (c) => { try { return execFileSync('ps', ['-o', c + '=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
      pid: process.pid, sid: ps('sid'), pgid: ps('pgid'), tty: ps('tty'), cwd: process.cwd(),
      stdinTty: require('node:tty').isatty(0), stdoutTty: require('node:tty').isatty(1),
      env: process.env,
    }));`;
  type Seen = { pid: number; sid: string; pgid: string; tty: string; cwd: string; stdinTty: boolean; stdoutTty: boolean; env: Record<string, string> };
  const spawnReal = async (env: Record<string, string | undefined>, o: { caller?: 'mcp' | 'launcher'; cwd?: string } = {}): Promise<Seen> => {
    const out = path.join(dir, 'seen.json');
    const r = await startBackfillChild('sync', ['x'], undefined, { command: process.execPath, args: ['-e', dump(out)] }, o.caller ?? 'mcp', env, o.cwd);
    expect(r.ok).toBe(true);
    await wait(out);
    return JSON.parse(fs.readFileSync(out, 'utf8')) as Seen;
  };

  it('has its own session and no terminal, a stdin that is not ours, and is reaped on exit', async () => {
    const seen = await spawnReal(syncChildEnv(process.env));
    // The session id is checked where ps can print it (Linux); the group id and the tty are checked everywhere.
    if (seen.sid !== '') expect(seen.sid).toBe(String(seen.pid));
    expect(seen.pgid).toBe(String(seen.pid));
    expect(seen.pgid).not.toBe(ps(process.pid, 'pgid'));
    // Linux prints `?`, macOS prints `??`.
    expect(seen.tty).toMatch(/^\?+$|^-$/);
    expect(seen.stdinTty).toBe(false);
    expect(seen.stdoutTty).toBe(false);
    await new Promise((res) => setTimeout(res, 400));
    expect(ps(seen.pid, 'stat')).toBe('');
  }, 60_000);

  it('secrets in THIS process\'s environment never reach it: the starter honours the env it was given, not process.env', async () => {
    for (const [k, v] of Object.entries({ ...SECRETS, PGPASSWORD: 'pg-planted' })) vi.stubEnv(k, v);
    const seen = await spawnReal(syncChildEnv(process.env));
    for (const name of [...Object.keys(SECRETS), 'PGPASSWORD']) expect(Object.keys(seen.env), name).not.toContain(name);
    expect(seen.env['PATH']).toBe(process.env['PATH']);
  }, 60_000);

  it('runs where it is told, not in the folder it was started from (two folders)', async () => {
    const home = fs.realpathSync(dir);
    expect((await spawnReal({ PATH: process.env['PATH'] }, { cwd: home })).cwd).toBe(home);
    fs.rmSync(path.join(dir, 'seen.json'));
    expect((await spawnReal({ PATH: process.env['PATH'] }, { cwd: fs.realpathSync(os.tmpdir()) })).cwd).toBe(fs.realpathSync(os.tmpdir()));
  }, 60_000);

  it('caller: the default (an MCP tool call) stamps ALIGN_STARTED_BY=mcp; the launcher stamps nothing, and cannot inherit one', async () => {
    expect((await spawnReal({ PATH: process.env['PATH'] })).env['ALIGN_STARTED_BY']).toBe('mcp');
    fs.rmSync(path.join(dir, 'seen.json'));
    expect((await spawnReal({ PATH: process.env['PATH'], ALIGN_STARTED_BY: 'mcp' }, { caller: 'launcher' })).env).not.toHaveProperty('ALIGN_STARTED_BY');
  }, 60_000);

  it('startSyncChild runs the child from the home directory and as the launcher when asked (recorded by a fake starter)', async () => {
    const start = vi.fn(async () => ({ ok: true, pid: 1 }));
    await startSyncChild(['github'], { start, caller: 'launcher' });
    await startSyncChild(['github'], { start });
    const calls = start.mock.calls as unknown as Array<[string, string[], unknown, unknown, string, unknown, string]>;
    expect([calls[0]![4], calls[0]![6]]).toEqual(['launcher', os.homedir()]);
    expect([calls[1]![4], calls[1]![6]]).toEqual(['mcp', os.homedir()]);
  }, 60_000);

  it('DO_NOT_TRACK=1 in the launcher shell is still set in the child, and that env turns telemetry off there', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    const seen = await spawnReal(syncChildEnv(process.env));
    expect(seen.env['DO_NOT_TRACK']).toBe('1');
    // the child's own telemetry predicate, evaluated over the env the child received
    for (const k of ['DO_NOT_TRACK', 'ALIGN_TELEMETRY']) vi.stubEnv(k, undefined);
    vi.stubEnv('DO_NOT_TRACK', seen.env['DO_NOT_TRACK']!);
    expect(telemetryDisabledByEnv()).toBeDefined();
    vi.stubEnv('DO_NOT_TRACK', undefined);
    expect(telemetryDisabledByEnv()).toBeUndefined();
  }, 60_000);
});
