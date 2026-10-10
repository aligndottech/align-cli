/**
 * L6 + L7: the child the LAUNCH HOOK starts (caller 'launcher', the reduced env syncChildEnv builds, run from the home
 * folder) reports its source_synced pings with trigger `background`, sends no cli.command, and honours the user's opt-out.
 * Real processes, no mocks: the child is started by the real startBackfillChild and runs the real `align sync --background`
 * under a preload that refuses any non-loopback connection; the gateway is a loopback capture server. The gitlab source points
 * at a closed loopback port, so the sync ends in an `error` outcome, which is a reportable one.
 *  - positive control: one source_synced (trigger background), and no body without a stage (no cli.command);
 *  - a stored (sticky) opt-out from an earlier run that saw DO_NOT_TRACK: zero pings although the child env does not name it;
 *  - DO_NOT_TRACK=1 in the launcher shell: it is passed through to the child, zero pings.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { startBackfillChild } from '../lib/backfill-state.js';
import { syncChildEnv } from '../lib/sync/spawn-background.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'src', 'index.ts');
const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

const GUARD = `
const net = require('net'), tls = require('tls'), dns = require('dns');
const ok = (h) => !h || h === 'localhost' || h === '::1' || /^127\\./.test(h) || h === '::ffff:127.0.0.1';
const hostOf = (a) => { a = a[0]; if (Array.isArray(a)) return hostOf(a); if (a && typeof a === 'object') return a.host ?? a.hostname ?? 'localhost'; return typeof a === 'number' ? 'localhost' : 'unix'; };
const deny = (h) => { const e = new Error('GUARD: blocked ' + h); e.code = 'ECONNREFUSED'; throw e; };
const oc = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const h = hostOf(a); if (h !== 'unix' && !ok(h)) deny(h); return oc.apply(this, a); };
const ot = tls.connect; tls.connect = function (...a) { const h = hostOf(a); if (h !== 'unix' && !ok(h)) deny(h); return ot.apply(this, a); };
const ol = dns.lookup; dns.lookup = function (h, ...r) { if (!ok(h)) { const cb = r[r.length - 1]; return process.nextTick(() => cb(Object.assign(new Error('GUARD'), { code: 'ENOTFOUND' }))); } return ol.call(this, h, ...r); };
`;

let dir: string;
let server: http.Server;
let bodies: Array<Record<string, unknown>>;
let env: Record<string, string>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-launcher-e2e-'));
  bodies = [];
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { bodies.push(JSON.parse(b)); } catch { /* not ours */ } res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const guard = path.join(dir, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const home = path.join(dir, 'home');
  env = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    NODE_OPTIONS: `--require ${guard.replaceAll(path.sep, "/")} --import ${tsx}`,
    ALIGN_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ALIGN_NO_LAUNCH: '1',
    PATH: process.env['PATH'] ?? '',
  };
  for (const d of [env['XDG_CONFIG_HOME']!, env['XDG_DATA_HOME']!, env['XDG_STATE_HOME']!, env['XDG_CACHE_HOME']!]) fs.mkdirSync(d, { recursive: true });
  // Seed: local mode, the notice already shown (so default-on sends), a gitlab token for a closed port.
  fs.writeFileSync(path.join(dir, 'seed.mjs'), `
    const { createConfigStore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/config.ts')).href)});
    const { getLocalDbPath } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/local-mode.ts')).href)});
    const c = createConfigStore();
    c.setLocalMode(getLocalDbPath());
    c.setDefaultEnv('local');
    c.markTelemetryNoticeShown();
    c.saveConnectorFields('local', 'gitlab', { token: 'glpat-x', domain: '127.0.0.1:1' });
  `);
  await run(process.execPath, [path.join(dir, 'seed.mjs')], { env, cwd: root });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function find(d: string, name: string): boolean {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    if (e.isDirectory() ? find(path.join(d, e.name), name) : e.name === name) return true;
  }
  return false;
}

function childEnvFrom(launcherEnv: Record<string, string>): Record<string, string> {
  return syncChildEnv(launcherEnv);
}

/** Start the child exactly as the launch hook does, and wait for it to finish (it writes sync-summary.json last). */
async function launcherChild(launcherEnv: Record<string, string>): Promise<void> {
  const guard = path.join(dir, 'guard.cjs');
  const r = await startBackfillChild(
    'sync', [], undefined,
    { command: process.execPath, args: ['--require', guard, '--import', tsx, entry, 'sync', '--background', '--delay', '0', 'gitlab'] },
    'launcher', childEnvFrom(launcherEnv), env['HOME'],
  );
  expect(r.ok).toBe(true);
  const until = Date.now() + 90_000;
  while (!find(env['XDG_STATE_HOME']!, 'sync-summary.json') && Date.now() < until) await new Promise((res) => setTimeout(res, 250));
  expect(find(env['XDG_STATE_HOME']!, 'sync-summary.json'), 'the background child never finished').toBe(true);
}

describe('the child the launch hook starts, and telemetry', () => {
  it('positive control: it sends ONE source_synced for gitlab with trigger background, and no cli.command', async () => {
    await launcherChild(env);
    // The once-per-install beacon (stage `install`) goes with the install's first run, whichever process that is; it is not a command ping.
    const pings = bodies.filter((b) => b['stage'] !== 'install');
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ command: 'sync', source: 'gitlab', outcome: 'error', trigger: 'background', count: 0 });
    // a cli.command ping carries no stage: there must be none
    expect(bodies.filter((b) => b['stage'] === undefined)).toEqual([]);
  });

  it('a stored opt-out (an earlier run saw DO_NOT_TRACK=1) holds for a child whose env does not name it: zero pings', async () => {
    await run(process.execPath, [entry, 'telemetry', 'status'], { env: { ...env, DO_NOT_TRACK: '1' }, cwd: root });
    expect(childEnvFrom(env)).not.toHaveProperty('DO_NOT_TRACK');
    await launcherChild(env);
    expect(bodies).toEqual([]);
    const status = await run(process.execPath, [entry, 'telemetry', 'status'], { env, cwd: root });
    expect(status.stdout).toMatch(/off \(DO_NOT_TRACK was set on \d{4}-\d{2}-\d{2}\)/);
  });

  it('DO_NOT_TRACK=1 in the launcher shell is passed to the child, which sends zero pings', async () => {
    const shell = { ...env, DO_NOT_TRACK: '1' };
    expect(childEnvFrom(shell)['DO_NOT_TRACK']).toBe('1');
    await launcherChild(shell);
    expect(bodies).toEqual([]);
  });
});
