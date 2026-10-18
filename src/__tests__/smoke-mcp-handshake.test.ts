/**
 * ALI-1740: scripts/smoke-mcp-handshake.mjs must make a real tools/call, not stop at tools/list.
 *
 * The AlignBench v2 run lost about $163 to a smoke that passed on tools/list with a credential
 * that every real call then failed with 401 (align-stack verification.md, "a positive control on
 * an ADJACENT mechanism proves nothing"). Each case below runs the real script. The fake `align`
 * records the methods it saw, so the tools/list-only trap is pinned by what the script CALLED,
 * not only by how it exited.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmDir } from './helpers/rm-dir.js';
import { FAKE_ALIGN, type FakeGateway, startFakeGateway } from './helpers/doctor-fixtures.js';

vi.setConfig({ testTimeout: 120_000 });
const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts', 'smoke-mcp-handshake.mjs');
const entry = path.join(root, 'src', 'index.ts');
const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;

let dir: string;
let gw: FakeGateway;
let fakeLog: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-smoke-hs-'));
  fakeLog = path.join(dir, 'fake.log');
  gw = await startFakeGateway('good-token-value');
  fs.mkdirSync(path.join(dir, 'fake'));
  fs.mkdirSync(path.join(dir, 'real'));
  fs.writeFileSync(path.join(dir, 'fake', 'align'), FAKE_ALIGN.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'real', 'align'), `#!/bin/sh\nexec "${process.execPath}" --import ${tsx} "${entry}" "$@"\n`, { mode: 0o755 });
});
afterEach(async () => {
  gw.server.closeAllConnections();
  await new Promise((r) => gw.server.close(r));
  rmDir(dir);
});

async function smoke(bin: 'fake' | 'real', over: Record<string, string> = {}, envArg?: string): Promise<{ code: number; out: string }> {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const env = {
    PATH: process.env['PATH'] ?? '', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    FAKE_MCP_LOG: fakeLog, ALIGN_GATEWAY_URL: `http://127.0.0.1:${gw.port}`, ALIGN_TENANT_ID: 't-1', ALIGN_NO_LAUNCH: '1', ALIGN_TELEMETRY: '0',
    ...over,
  };
  const args = [script, path.join(dir, bin, 'align'), ...(envArg ? [envArg] : [])];
  try {
    const r = await run(process.execPath, args, { env, cwd: root });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 99, out: (x.stdout ?? '') + (x.stderr ?? '') };
  }
}
const methods = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean) : []);

describe.skipIf(process.platform === 'win32')('smoke-mcp-handshake.mjs makes a real tools/call', () => {
  it('a server that answers both passes, and the script called tools/call', async () => {
    const r = await smoke('fake', { FAKE_MCP_MODE: 'ok' });
    expect(r.out).toMatch(/OK - tools\/call align_ask returned \d+ characters/);
    expect(r.code).toBe(0);
    expect(methods()).toContain('tools/call');
  });

  it('THE TRAP: tools/list is healthy and tools/call fails - the smoke must fail', async () => {
    const r = await smoke('fake', { FAKE_MCP_MODE: 'call-401' });
    expect(methods()).toContain('tools/list');
    expect(methods()).toContain('tools/call');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tool error/);
  });

  it('JSON with no results list fails, which a plain non-empty check would pass', async () => {
    const r = await smoke('fake', { FAKE_MCP_MODE: 'no-results' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no results list/);
  });

  it('an empty answer fails', async () => {
    const r = await smoke('fake', { FAKE_MCP_MODE: 'empty' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/empty answer/);
  });

  it('the REAL align mcp against a gateway that accepts the token passes (gateway reached)', async () => {
    const r = await smoke('real', { ALIGN_TOKEN: 'good-token-value' }, 'prod');
    expect(r.code).toBe(0);
    expect(gw.requests.map((q) => q.url)).toContain('/decisions/smart-search');
  });

  it('the REAL align mcp with a credential the gateway rejects: tools/list passes locally, the smoke still fails', async () => {
    const r = await smoke('real', { ALIGN_TOKEN: 'wrong-type-credential' }, 'prod');
    expect(r.out).toMatch(/tools listed, align_search present/); // the adjacent check the old smoke stopped at
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/401/);
  });
});
