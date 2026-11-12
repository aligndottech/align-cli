/**
 * The install beacon is the funnel's denominator, so it is guarded end to end: the BUILT CLI (node dist/bin.js), a first
 * command in an empty HOME, a loopback gateway that records every telemetry body. No mocks and no direct call to the beacon
 * function: the path is the one a user takes (preAction -> beginInvocationTelemetry).
 *
 * The first run of a real install is often NOT a terminal: an agent's Bash tool, or `align mcp` started by Claude Code, Codex
 * or pi. Those runs never show the notice, and the beacon used to wait for it, so an install that only ever ran through an
 * agent was never counted. Every install that has not opted out is counted once, on its first run, terminal or not.
 * Opt-outs (DO_NOT_TRACK, ALIGN_TELEMETRY=0, CI, `align telemetry off`) still send nothing.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'dist', 'bin.js');

let dir: string;
let server: http.Server;
let bodies: Array<Record<string, unknown>>;
let base: Record<string, string>;

/** Run the built CLI with piped stdio (no terminal) and resolve when it exits. */
function align(args: string[], extra: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [bin, ...args], { env: { ...base, ...extra }, cwd: dir, timeout: 30_000 }, () => resolve());
    child.stdin?.end();
  });
}
const installs = (): Array<Record<string, unknown>> => bodies.filter((b) => b['stage'] === 'install');

beforeAll(() => {
  // Always build: a stale dist/ would make this guard test yesterday's code. CI runs the tests before its own build step.
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-install-beacon-e2e-'));
  bodies = [];
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/telemetry/')) { try { bodies.push(JSON.parse(b)); } catch { /* not ours */ } }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  // A hand-built env: nothing inherited, so DO_NOT_TRACK, CI and the like are absent unless a test sets them.
  base = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    ALIGN_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ALIGN_NO_LAUNCH: '1', ALIGN_NO_SYNC: '1', ALIGN_NO_TRUSTED_BIN: '1', ALIGN_TOKEN_STORE: 'file',
    PATH: process.env['PATH'] ?? '',
  };
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmDir(dir);
});

describe('install beacon, built CLI, first run without a terminal', () => {
  it('counts an install whose first command is a plain command run by an agent (no terminal)', async () => {
    await align(['search', 'beacon-probe']);
    expect(installs()).toHaveLength(1);
    expect(installs()[0]).toMatchObject({ stage: 'install', command: 'align', os: process.platform });
  });

  it('counts an install whose first command is `align mcp`, the way an agent starts it', async () => {
    await align(['mcp']);
    expect(installs()).toHaveLength(1);
  });

  it('counts an install once: the second run sends no second beacon', async () => {
    await align(['search', 'one']);
    await align(['mcp']);
    await align(['search', 'two']);
    expect(installs()).toHaveLength(1);
  });

  it.each([
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
    ['ALIGN_TELEMETRY=0', { ALIGN_TELEMETRY: '0' }],
    ['CI', { CI: 'true' }],
  ])('%s: nothing is sent, on a plain command or on `align mcp`', async (_name, env) => {
    await align(['search', 'x'], env);
    await align(['mcp'], env);
    expect(bodies).toEqual([]);
  });

  it('a stored `align telemetry off` sends nothing afterwards', async () => {
    await align(['telemetry', 'off']);
    await align(['search', 'x']);
    await align(['mcp']);
    expect(bodies).toEqual([]);
  });

  it('DO_NOT_TRACK on the first run is remembered: unsetting it later never sends the install', async () => {
    await align(['search', 'x'], { DO_NOT_TRACK: '1' });
    await align(['search', 'y']);
    expect(installs()).toHaveLength(0);
  });
});
