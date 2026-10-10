/**
 * An env opt-out reaches the detached sync child even though the agent trimmed the MCP server's
 * environment. Real processes, no mocks: a foreground align run sees DO_NOT_TRACK=1 (which stores
 * the opt-out), then `align mcp` is started through the SDK's real StdioClientTransport with an
 * entry env block that does NOT name DO_NOT_TRACK, and `align_sync run` starts the real
 * `align sync --background` child. Every process loads a preload that refuses any non-loopback
 * connection, and the gateway is a loopback capture server. The gitlab source points at a closed
 * loopback port, so the sync finishes with an `error` outcome, which is a reportable one.
 * Positive control: the same flow without DO_NOT_TRACK sends source_synced.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l7-e2e-'));
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
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    NODE_OPTIONS: `--require ${guard} --import ${tsx}`,
    ALIGN_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ALIGN_NO_LAUNCH: '1',
    PATH: process.env['PATH'] ?? '',
  };
  for (const d of [env['XDG_CONFIG_HOME']!, env['XDG_DATA_HOME']!, env['XDG_STATE_HOME']!, env['XDG_CACHE_HOME']!]) fs.mkdirSync(d, { recursive: true });
  // Seed: local mode, the notice already shown (so default-on sends), a gitlab token for a closed port.
  fs.writeFileSync(path.join(dir, 'seed.mjs'), `
    const { createConfigStore } = await import(${JSON.stringify(path.join(root, 'src/lib/config.ts'))});
    const { getLocalDbPath } = await import(${JSON.stringify(path.join(root, 'src/lib/local-mode.ts'))});
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

/** foreground run (optionally under DO_NOT_TRACK=1), then the SDK-started mcp server runs a sync with an env block that never names DO_NOT_TRACK. */
async function flow(dnt: boolean): Promise<void> {
  await run(process.execPath, [entry, 'telemetry', 'status'], { env: { ...env, ...(dnt ? { DO_NOT_TRACK: '1' } : {}) }, cwd: root });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env, cwd: root, stderr: 'ignore' });
  const client = new Client({ name: 'probe', version: '0' });
  await client.connect(transport);
  try {
    await client.callTool({ name: 'align_sync', arguments: { action: 'run', source: 'gitlab' } });
    // The child writes sync-summary.json after its pings have been sent (or refused).
    const until = Date.now() + 90_000;
    while (!find(env['XDG_STATE_HOME']!, 'sync-summary.json') && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    expect(find(env['XDG_STATE_HOME']!, 'sync-summary.json'), 'the background child never finished').toBe(true);
  } finally {
    await client.close();
  }
}

describe('an env opt-out and the detached sync child', () => {
  it('positive control: without DO_NOT_TRACK the child sends source_synced for gitlab (nothing but the five fields)', async () => {
    await flow(false);
    const synced = bodies.filter((b) => b['stage'] === 'source_synced');
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ command: 'sync', source: 'gitlab', outcome: 'error', trigger: 'background', count: 0 });
  });

  it('after a foreground run saw DO_NOT_TRACK=1, an mcp server with a trimmed env and its sync child send ZERO pings', async () => {
    await flow(true);
    expect(bodies).toEqual([]);
    const status = await run(process.execPath, [entry, 'telemetry', 'status'], { env, cwd: root });
    expect(status.stdout).toMatch(/off \(DO_NOT_TRACK was set on \d{4}-\d{2}-\d{2}\); turn it back on with: align telemetry on/);
  });
});
