import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBackfillChild } from '../lib/backfill-state.js';
import { startSyncChild, syncChildEnv } from '../lib/sync/spawn-background.js';

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
    const call = start.mock.calls[0] as unknown as [string, string[], unknown, unknown, Record<string, string>];
    expect(call[1]).toEqual(['sync', '--background', '--delay', '20', 'github']);
    expect(call[4]).toEqual(KEPT);
  });
});

describe.skipIf(process.platform === 'win32')('a real detached child', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-child-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ps = (pid: number, col: string): string => {
    try { return execFileSync('ps', ['-o', `${col}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
  };

  it('has its own session and no terminal, a stdin that is not ours, no secrets, and is reaped on exit', async () => {
    const out = path.join(dir, 'seen.json');
    const script = `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const ps = (c) => execFileSync('ps', ['-o', c + '=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({
        pid: process.pid, sid: ps('sid'), pgid: ps('pgid'), tty: ps('tty'),
        stdinTty: require('node:tty').isatty(0), stdoutTty: require('node:tty').isatty(1),
        envNames: Object.keys(process.env), argv: process.argv.slice(1),
      }));`;
    const r = await startBackfillChild('sync', ['x'], undefined, { command: process.execPath, args: ['-e', script, '--', 'sync', '--background'] }, syncChildEnv({ ...process.env, ...SECRETS }));
    expect(r.ok).toBe(true);
    for (let i = 0; i < 200 && !fs.existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as { pid: number; sid: string; pgid: string; tty: string; stdinTty: boolean; stdoutTty: boolean; envNames: string[] };
    // Its own session: the terminal closing cannot signal it, and it cannot read the launcher's terminal.
    expect(seen.sid).toBe(String(seen.pid));
    expect(seen.pgid).toBe(String(seen.pid));
    expect(seen.pgid).not.toBe(ps(process.pid, 'pgid'));
    expect(seen.tty).toMatch(/^\?+$|^-$/);
    expect(seen.stdinTty).toBe(false);
    expect(seen.stdoutTty).toBe(false);
    for (const name of Object.keys(SECRETS)) expect(seen.envNames, name).not.toContain(name);
    // The launcher is still running; the child must not linger as a zombie once it exited.
    let state = 'x';
    for (let i = 0; i < 100; i++) {
      state = ps(seen.pid, 'stat');
      if (state === '' || !state.startsWith('Z')) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    await new Promise((res) => setTimeout(res, 300));
    expect(ps(seen.pid, 'stat')).toBe('');
  });
});
