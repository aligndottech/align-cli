/**
 * `align doctor` end to end. Real processes, no mocks: the real command, the real
 * `align mcp` it starts (through an `align` shim on PATH, the way an agent finds it), and a
 * loopback gateway standing in for the cloud. A second, fake `align` that speaks just enough MCP
 * covers the cases the real server cannot produce on demand (an empty answer, a server that
 * lists tools and then fails the call).
 *
 * What each test pins, by name:
 *  - every failure mode has its own test and must exit non-zero
 *  - "tools/list works, tools/call does not" is pinned against a server that records the methods
 *    it saw: a doctor that stopped at tools/list would exit 0 and fail the test
 *  - the telemetry condition: with a preload that records every connection the process tree
 *    makes, doctor talks to the configured gateway only, never to a /telemetry route, and the
 *    positive controls show the same setup DOES send telemetry from an ordinary command
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmDir } from './helpers/rm-dir.js';
import { askViaMcp } from '../lib/doctor-mcp.js';
import { FAKE_ALIGN, startFakeGateway } from './helpers/doctor-fixtures.js';

vi.setConfig({ testTimeout: 120_000 });
const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'src', 'index.ts');
const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

const GOOD_TOKEN = 'good-token-value';

// Records every outbound connection to CONN_LOG and refuses anything that is not loopback.
const GUARD = `
const fs = require('fs'), net = require('net'), tls = require('tls'), dns = require('dns');
const log = process.env.CONN_LOG;
const ok = (h) => !h || h === 'localhost' || h === '::1' || /^127\\./.test(h) || h === '::ffff:127.0.0.1';
const hostOf = (a) => { a = a[0]; if (Array.isArray(a)) return hostOf(a); if (a && typeof a === 'object') return a.path ? { h: 'unix', p: 0 } : { h: a.host ?? a.hostname ?? 'localhost', p: a.port }; return typeof a === 'number' ? { h: 'localhost', p: a } : { h: 'unix', p: 0 }; };
const note = (t) => { if (log) fs.appendFileSync(log, t + '\\n'); };
const deny = (h) => { note('BLOCKED ' + h); const e = new Error('GUARD: blocked ' + h); e.code = 'ECONNREFUSED'; throw e; };
const oc = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const { h, p } = hostOf(a); if (h !== 'unix') { if (!ok(h)) deny(h); note('CONNECT ' + h + ':' + p); } return oc.apply(this, a); };
const ot = tls.connect; tls.connect = function (...a) { const { h } = hostOf(a); if (h !== 'unix' && !ok(h)) deny(h); return ot.apply(this, a); };
const ol = dns.lookup; dns.lookup = function (h, ...r) { if (!ok(h)) { note('BLOCKED ' + h); const cb = r[r.length - 1]; return process.nextTick(() => cb(Object.assign(new Error('GUARD'), { code: 'ENOTFOUND' }))); } return ol.call(this, h, ...r); };
`;

let dir: string;
let server: http.Server;
let requests: Array<{ method: string; url: string; auth: string | undefined }>;
let gatewayMode: { searchStatus: number };
let env: Record<string, string>;
let realBinDir: string;
let fakeBinDir: string;
let connLog: string;
let fakeLog: string;
let port: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-e2e-'));
  requests = [];
  gatewayMode = { searchStatus: 200 };
  const gw = await startFakeGateway(GOOD_TOKEN);
  server = gw.server;
  requests = gw.requests;
  gatewayMode = gw.mode;
  port = gw.port;

  const guard = path.join(dir, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  connLog = path.join(dir, 'conn.log');
  fakeLog = path.join(dir, 'fake-mcp.log');

  realBinDir = path.join(dir, 'real-bin');
  fakeBinDir = path.join(dir, 'fake-bin');
  fs.mkdirSync(realBinDir);
  fs.mkdirSync(fakeBinDir);
  fs.writeFileSync(path.join(realBinDir, 'align'), `#!/bin/sh\nexec "${process.execPath}" --import ${tsx} "${entry}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBinDir, 'align'), FAKE_ALIGN.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });

  const home = path.join(dir, 'home');
  env = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    NODE_OPTIONS: `--require ${guard}`,
    CONN_LOG: connLog,
    FAKE_MCP_LOG: fakeLog,
    ALIGN_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ALIGN_TOKEN: GOOD_TOKEN,
    ALIGN_TENANT_ID: 't-1',
    ALIGN_NO_LAUNCH: '1',
    PATH: `${realBinDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
  for (const d of [env['XDG_CONFIG_HOME']!, env['XDG_DATA_HOME']!, env['XDG_STATE_HOME']!, env['XDG_CACHE_HOME']!]) fs.mkdirSync(d, { recursive: true });
  // Telemetry-eligible state: the one-time notice is on record, so an ordinary command WOULD send.
  fs.writeFileSync(path.join(dir, 'seed.mjs'), `
    const { createConfigStore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/config.ts')).href)});
    createConfigStore().markTelemetryNoticeShown();
  `);
  await run(process.execPath, ['--import', tsx, path.join(dir, 'seed.mjs')], { env, cwd: root });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmDir(dir);
});

interface Ran { code: number; out: string }
async function align(args: string[], over: Record<string, string | undefined> = {}): Promise<Ran> {
  const e: Record<string, string | undefined> = { ...env, ...over };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  try {
    const r = await run(path.join(realBinDir, 'align'), args, { env: e as Record<string, string>, cwd: root });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const x = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 99, out: (x.stdout ?? '') + (x.stderr ?? '') };
  }
}
const deadPort = (): Promise<number> => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});
const doctor = (over: Record<string, string | undefined> = {}) => align(['doctor', '--env', 'prod'], over);
const paths = () => requests.map((r) => r.url);
const fakeMethods = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean) : []);

describe.skipIf(process.platform === 'win32')('align doctor, end to end', () => {
  it('everything works: exit 0, all five checks pass, and the call really reached the gateway', async () => {
    const r = await doctor();
    expect(r.out).toMatch(/PASS\s+Node version/);
    expect(r.out).toMatch(/PASS\s+align on PATH/);
    expect(r.out).toMatch(/PASS\s+Gateway reachable/);
    expect(r.out).toMatch(/PASS\s+Token accepted\s+buyer@example\.test/);
    expect(r.out).toMatch(/PASS\s+Tool call/);
    expect(r.out).toMatch(/All checks passed/);
    expect(r.code).toBe(0);
    // The tools/call travelled align mcp -> gateway: it is the only thing that hits smart-search.
    expect(paths()).toContain('/decisions/smart-search');
  });

  it('a bad token fails and names align login', async () => {
    const r = await doctor({ ALIGN_TOKEN: 'wrong-type-credential' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL\s+Token accepted/);
    expect(r.out).toMatch(/FAIL\s+Tool call/);
    expect(r.out).toContain('align login --env prod');
  });

  it('no token at all fails and names align login', async () => {
    const r = await doctor({ ALIGN_TOKEN: undefined, ALIGN_TENANT_ID: undefined });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL\s+Token accepted/);
    expect(r.out).toContain('align login --env prod');
  });

  it('an unreachable gateway fails, names the URL, and skips the checks that need it', async () => {
    const dead = await deadPort();
    const r = await doctor({ ALIGN_GATEWAY_URL: `http://127.0.0.1:${dead}` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL\s+Gateway reachable/);
    expect(r.out).toContain(`127.0.0.1:${dead}`);
    expect(r.out).toMatch(/SKIP\s+Token accepted/);
  });

  it('whoami accepted but the real tool call 401s: fails on the tool call alone', async () => {
    gatewayMode.searchStatus = 401;
    const r = await doctor();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/PASS\s+Token accepted/);
    expect(r.out).toMatch(/FAIL\s+Tool call/);
    expect(r.out).toContain('401');
  });

  it('align missing from PATH fails, names the install command, and does not run the call', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const r = await doctor({ PATH: empty });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/FAIL\s+align on PATH/);
    expect(r.out).toContain('npm install -g @aligndottech/cli');
    expect(r.out).toMatch(/SKIP\s+Tool call/);
    expect(paths()).not.toContain('/decisions/smart-search');
  });

  it('a gateway that never answers whoami: doctor still ends, soon after it prints the verdict', async () => {
    gatewayMode.hang.push('/auth/me');
    const t0 = Date.now();
    const r = await doctor();
    expect(r.out).toMatch(/FAIL\s+Token accepted/);
    expect(r.code).not.toBe(0); // a hung process would be killed by execFile's timeout instead
    expect(Date.now() - t0).toBeLessThan(45_000);
  }, 70_000);

  describe('against a fake `align mcp` (what the real server cannot produce on demand)', () => {
    const onFake = { PATH: '' };
    beforeEach(() => { onFake.PATH = `${fakeBinDir}${path.delimiter}${process.env['PATH'] ?? ''}`; });

    it('an EMPTY answer is a failure, not a pass', async () => {
      const r = await doctor({ ...onFake, FAKE_MCP_MODE: 'empty' });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/FAIL\s+Tool call/);
      expect(r.out).toMatch(/empty answer/);
    });

    it('a server that dies at startup: the cause it printed reaches the screen', async () => {
      const r = await doctor({ ...onFake, FAKE_MCP_MODE: 'die' });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('Unknown environment bogus');
    });

    it('JSON with no results list fails', async () => {
      const r = await doctor({ ...onFake, FAKE_MCP_MODE: 'no-results' });
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/no results list/);
    });

    it('a text answer passes (control for the two cases around it)', async () => {
      const r = await doctor({ ...onFake, FAKE_MCP_MODE: 'ok' });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/PASS\s+Tool call/);
    });

    it('THE TRAP: tools/list answers fine and tools/call fails - doctor must fail, and must have called tools/call', async () => {
      const r = await doctor({ ...onFake, FAKE_MCP_MODE: 'call-401' });
      // A doctor that only called tools/list would see a healthy server and exit 0.
      expect(fakeMethods()).toContain('tools/call');
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/FAIL\s+Tool call/);
      expect(r.out).toContain('align login --env prod');
    });
  });

  describe('telemetry: doctor sends none', () => {
    const connects = () => (fs.existsSync(connLog) ? fs.readFileSync(connLog, 'utf8').split('\n').filter(Boolean) : []);

    it('with a token: only the configured gateway is contacted, and never a telemetry route', async () => {
      const r = await doctor();
      expect(r.code).toBe(0);
      // Positive control inside the test: the real work was observed, so the recorder works.
      expect(paths()).toEqual(expect.arrayContaining(['/health', '/auth/me', '/decisions/smart-search']));
      expect(paths().filter((p) => p.includes('telemetry'))).toEqual([]);
      expect(paths().every((p) => ['/health', '/auth/me', '/decisions/smart-search'].includes(p))).toBe(true);
      // Every connection made by the whole process tree (doctor and the align mcp it started).
      const c = connects();
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((l) => l === `CONNECT 127.0.0.1:${port}`)).toBe(true);
    });

    it('with no token and the notice on record (the install-beacon state): nothing is sent', async () => {
      const r = await doctor({ ALIGN_TOKEN: undefined, ALIGN_TENANT_ID: undefined });
      expect(r.code).not.toBe(0);
      expect(paths().filter((p) => p.includes('telemetry'))).toEqual([]);
      expect(connects().filter((l) => l.startsWith('BLOCKED'))).toEqual([]);
    });

    it('with an unreachable gateway the process tree still makes no other connection', async () => {
      // Not port 1: fetch refuses restricted ports without connecting, which would leave nothing to observe.
      const dead = await deadPort();
      await doctor({ ALIGN_GATEWAY_URL: `http://127.0.0.1:${dead}` });
      const c = connects();
      expect(c.length).toBeGreaterThan(0);
      expect(c.every((l) => l === `CONNECT 127.0.0.1:${dead}`)).toBe(true); // exactly the configured (dead) gateway, nothing else
    });

    it('CONTROL: an ordinary signed-in command in this exact setup DOES send a cloud usage ping', async () => {
      await align(['whoami', '--env', 'prod']);
      expect(paths()).toContain('/telemetry/ingest');
    });

    it('CONTROL: an ordinary signed-out command in this exact setup DOES send the anonymous install beacon', async () => {
      await align(['whoami', '--env', 'prod'], { ALIGN_TOKEN: undefined, ALIGN_TENANT_ID: undefined });
      expect(paths()).toContain('/telemetry/anonymous');
    });

    it('askViaMcp marks the align mcp it starts on its own, so the server pings nobody (cli.command, first_useful_decision)', async () => {
      // Called directly, so the marker doctor's own process carries cannot be what is inherited.
      const keys = ['ALIGN_GATEWAY_URL', 'ALIGN_TOKEN', 'ALIGN_TENANT_ID', 'ALIGN_DOCTOR', 'CI', 'DO_NOT_TRACK', 'ALIGN_TELEMETRY'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      Object.assign(process.env, { ALIGN_GATEWAY_URL: env['ALIGN_GATEWAY_URL'], ALIGN_TOKEN: GOOD_TOKEN, ALIGN_TENANT_ID: 't-1', CI: 'false' });
      for (const k of ['ALIGN_DOCTOR', 'DO_NOT_TRACK', 'ALIGN_TELEMETRY']) delete process.env[k]; // a runner's own opt-out would make this pass vacuously
      try {
        const r = await askViaMcp(path.join(realBinDir, 'align'), 'prod');
        expect(r.text).toContain('Use Postgres');
        await new Promise((res) => setTimeout(res, 800)); // both pings are fire-and-forget
      } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      }
      expect(paths()).toContain('/decisions/smart-search');
      expect(paths().filter((p) => p.includes('telemetry'))).toEqual([]);
    });
  });
});
