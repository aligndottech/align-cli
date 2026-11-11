/**
 * does using Align ONLY through an agent's MCP tools count toward D7?
 *
 * A recorded run with real processes and no mocks. A fresh HOME stands in for a clean machine. A
 * preload offsets the clock of every spawned process by a whole number of days, so "day 7" is a
 * real second run of the real code that believes it is a week later. Every process loads a guard
 * that refuses any non-loopback connection, and ALIGN_GATEWAY_URL points at a loopback capture
 * server standing in for `POST /telemetry/anonymous`.
 *
 * Scenarios: A) a new MCP server each day, B) one server left running all week, C) the install never
 * saw the telemetry notice, D) DO_NOT_TRACK=1, E) the payload's key set. In each, a person types at
 * most one command on day 0 and every later day is the agent alone.
 *
 * What the capture server receives is mapped to the row the gateway writes into
 * `anonymous_usage_events` (the same mapping as telemetryAnonymousRoutes.ts: `cli.funnel.<stage>`
 * when a stage is present, `cli.command` otherwise). Set ALIGN_D7_RECORD_OUT to a file path to
 * append the tables the run produced; docs/agent-only-d7.md quotes them.
 *
 * The setup wizard itself is interactive, so day 0 uses `align status`: setup's own pings
 * (setup_completed, mcp_wired) are one-offs on day 0 and cannot carry day 7 either way. The
 * telemetry notice needs a TTY, so the seed marks it shown, exactly as a terminal run would have.
 */
import { rmDir } from './helpers/rm-dir.js';
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

vi.setConfig({ testTimeout: 180_000 });
const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'src', 'index.ts');
const tsx = pathToFileURL(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
const DAY_MS = 86_400_000;

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

// Shifts "now" for the whole process by ALIGN_FAKE_OFFSET_MS: Date.now() and new Date().
const CLOCK = `
const R = Date;
const fs = require('fs');
const off0 = Number(process.env.ALIGN_FAKE_OFFSET_MS || 0);
const file = process.env.ALIGN_FAKE_OFFSET_FILE;
// A file, when given, is re-read on every call, so one long-lived server can live through the days.
const offset = () => { if (!file) return off0; try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return off0; } };
class FakeDate extends R {
  constructor(...a) { if (a.length === 0) super(R.now() + offset()); else super(...a); }
  static now() { return R.now() + offset(); }
}
globalThis.Date = FakeDate;
`;

type Body = Record<string, unknown>;
interface Captured { day: number; via: string; body: Body }

let dir: string;
let server: http.Server;
let captured: Captured[];
let currentDay = 0;
let currentVia = '';
let baseEnv: Record<string, string>;

/** Seeds a fresh install. `notice: false` is an install whose person never saw the telemetry notice (it needs a terminal). */
async function seed(notice: boolean): Promise<void> {
  await run(process.execPath, [path.join(dir, 'seed.mjs')], { env: { ...baseEnv, NODE_OPTIONS: `--import ${tsx}`, SEED_NOTICE: notice ? '1' : '0' }, cwd: root });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-d7-e2e-'));
  captured = [];
  currentDay = 0;
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { captured.push({ day: currentDay, via: currentVia, body: JSON.parse(b) as Body }); } catch { /* not ours */ }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const guard = path.join(dir, 'guard.cjs');
  const clock = path.join(dir, 'clock.cjs');
  fs.writeFileSync(guard, GUARD);
  fs.writeFileSync(clock, CLOCK);
  fs.writeFileSync(path.join(dir, 'entry.mjs'), `
    import { createRequire } from 'node:module';
    const req = createRequire(import.meta.url);
    req(${JSON.stringify(guard)});
    req(${JSON.stringify(clock)});
    await import(${JSON.stringify(tsx)});
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `);
  const home = path.join(dir, 'home');
  baseEnv = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    ALIGN_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ALIGN_NO_LAUNCH: '1',
    // A hand-built env does not inherit the test pin, and a real child would probe the machine's keychain (it blocked a macOS runner's hook).
    ALIGN_TOKEN_STORE: 'file',
    PATH: process.env['PATH'] ?? '',
  };
  // Windows ignores HOME and XDG_*: it reads the profile from USERPROFILE and config from %APPDATA%. Left
  // alone, every scenario shared the runner's real profile instead of its own clean one.
  // SystemRoot and friends are passed through: a Windows process started without them cannot use sockets.
  if (process.platform === 'win32') {
    Object.assign(baseEnv, {
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    });
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
      const v = process.env[k];
      if (v !== undefined) baseEnv[k] = v;
    }
    fs.mkdirSync(baseEnv['APPDATA']!, { recursive: true });
    fs.mkdirSync(baseEnv['LOCALAPPDATA']!, { recursive: true });
  }
  for (const d of [baseEnv['XDG_CONFIG_HOME']!, baseEnv['XDG_DATA_HOME']!, baseEnv['XDG_STATE_HOME']!, baseEnv['XDG_CACHE_HOME']!]) fs.mkdirSync(d, { recursive: true });
  // The seed: local mode, the notice already shown (a terminal run would have shown it).
  fs.writeFileSync(path.join(dir, 'seed.mjs'), `
    const { createConfigStore } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/config.ts')).href)});
    const { getLocalDbPath } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/lib/local-mode.ts')).href)});
    const c = createConfigStore();
    c.setLocalMode(getLocalDbPath());
    c.setDefaultEnv('local');
    if (process.env.SEED_NOTICE !== '0') c.markTelemetryNoticeShown();
  `);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmDir(dir);
});

const offsetFile = (): string => path.join(dir, 'offset');
const setDay = (day: number): void => { fs.writeFileSync(offsetFile(), String(day * DAY_MS)); };

const dayEnv = (day: number, extra: Record<string, string> = {}): Record<string, string> => {
  setDay(day);
  return {
    ...baseEnv,
    NODE_OPTIONS: `--require ${path.join(dir, 'guard.cjs')} --require ${path.join(dir, 'clock.cjs')} --import ${tsx}`,
    ALIGN_FAKE_OFFSET_FILE: offsetFile(),
    ...extra,
  };
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 600));

/** Day N: the person types one command in a terminal. */
async function terminalCommand(day: number, args: string[]): Promise<void> {
  currentDay = day;
  currentVia = `terminal: align ${args.join(' ')}`;
  await run(process.execPath, [entry, ...args], { env: dayEnv(day), cwd: root });
  await settle();
}

// Tools that need neither an on-device embedding model nor a full git history, so the run works offline and in a shallow CI clone.
const CALLS = [
  { name: 'align_get_conflicts', arguments: {} },
  { name: 'align_get_conflicts', arguments: {} },
];

async function connect(day: number, extra: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'entry.mjs'), 'mcp'], env: dayEnv(day, extra), cwd: root, stderr: 'ignore' });
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(transport);
  return client;
}

/** Day N: the person types nothing. Their agent starts a fresh `align mcp` and calls tools. */
async function agentSession(day: number, extra: Record<string, string> = {}): Promise<void> {
  currentDay = day;
  currentVia = `agent MCP, new server: ${[...new Set(CALLS.map((c) => c.name))].join(', ')}`;
  const client = await connect(day, extra);
  try {
    for (const c of CALLS) await client.callTool(c);
    await settle();
  } finally {
    await client.close();
  }
}

/** One server started on day 1 and never restarted (an editor window left open); the agent calls tools on each later day. */
async function longLivedAgent(days: number[]): Promise<void> {
  currentDay = days[0]!;
  currentVia = 'agent MCP, one long-lived server';
  const client = await connect(days[0]!);
  try {
    for (const day of days) {
      currentDay = day;
      setDay(day);
      for (const c of CALLS) await client.callTool(c);
      await settle();
    }
  } finally {
    await client.close();
  }
}

/** What the gateway writes for one body: the anonymous_usage_events columns, in the gateway's own mapping. */
function row(c: Captured): { day: number; event_name: string; command: string; via: string } {
  const stage = c.body['stage'];
  return {
    day: c.day,
    event_name: typeof stage === 'string' ? `cli.funnel.${stage}` : 'cli.command',
    command: String(c.body['command']),
    via: c.via,
  };
}
type Row = ReturnType<typeof row>;
const days = (rows: Row[], keep: (r: Row) => boolean): number[] => [...new Set(rows.filter(keep).map((r) => r.day))];
const table = (rows: Row[]): string => ['day | event_name | command | sent by', '--- | --- | --- | ---', ...rows.map((r) => `${r.day} | ${r.event_name} | ${r.command} | ${r.via}`)].join('\n');

let report = '';
afterEach(() => {
  if (process.env['ALIGN_D7_RECORD_OUT'] && report) fs.appendFileSync(process.env['ALIGN_D7_RECORD_OUT'], report);
  report = '';
});
function record(title: string, rows: Row[], lines: string[]): void {
  report += `### ${title}\n\n${table(rows)}\n\n${lines.join('\n')}\n\n`;
  console.log(report);
}

describe('agent-only use over a week, real processes, a day-shifted clock', () => {
  it('A: a new agent session each day (the editor is restarted daily)', async () => {
    await seed(true);
    await terminalCommand(0, ['status']);
    for (let day = 1; day <= 7; day++) await agentSession(day);
    const rows = captured.map(row);
    record('A: the person types one command on day 0, then only their agent uses Align, a new MCP server each day', rows, [
      `days with a cli.command ping (the D7 definition in the ticket): [${days(rows, (r) => r.event_name === 'cli.command').join(', ')}]`,
      `days with a cli.command ping other than mcp (a person typed it): [${days(rows, (r) => r.event_name === 'cli.command' && r.command !== 'mcp').join(', ')}]`,
      `days with cli.funnel.agent_active (a tool call): [${days(rows, (r) => r.event_name === 'cli.funnel.agent_active').join(', ')}]`,
    ]);
    // Positive control: day 0 landed, so an empty day below means silence, not a broken harness.
    expect(rows.some((r) => r.day === 0 && r.event_name === 'cli.funnel.install')).toBe(true);
    expect(days(rows, (r) => r.event_name === 'cli.command' && r.command === 'mcp')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(days(rows, (r) => r.event_name === 'cli.funnel.agent_active')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('B: one MCP server started on day 1 and left running all week', async () => {
    await seed(true);
    await terminalCommand(0, ['status']);
    await longLivedAgent([1, 2, 3, 4, 5, 6, 7]);
    const rows = captured.map(row);
    record('B: the person types one command on day 0; the agent starts ONE server on day 1 and calls tools on days 1 to 7', rows, [
      `days with a cli.command ping: [${days(rows, (r) => r.event_name === 'cli.command').join(', ')}]`,
      `days with cli.funnel.agent_active (a tool call): [${days(rows, (r) => r.event_name === 'cli.funnel.agent_active').join(', ')}]`,
    ]);
    expect(rows.some((r) => r.day === 0 && r.event_name === 'cli.funnel.install')).toBe(true);
    // One server start is one cli.command mcp, on the day it started (day 1).
    expect(rows.filter((r) => r.event_name === 'cli.command' && r.command === 'mcp')).toHaveLength(1);
    // The tool calls are the use. Each day has one.
    expect(days(rows, (r) => r.event_name === 'cli.funnel.agent_active')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('C: an install whose person never saw the notice sends nothing from the agent, by design', async () => {
    await seed(false);
    for (let day = 0; day <= 7; day++) await agentSession(day);
    const rows = captured.map(row);
    record('C: no terminal run ever showed the telemetry notice (it needs a TTY); only the agent uses Align', rows, [`rows captured: ${rows.length}`]);
    expect(rows).toEqual([]);
  });

  it('D: DO_NOT_TRACK=1 in the agent server stops agent_active along with everything else', async () => {
    await seed(true);
    for (let day = 0; day <= 2; day++) await agentSession(day, { DO_NOT_TRACK: '1' });
    const rows = captured.map(row);
    record('D: the same agent use with DO_NOT_TRACK=1', rows, [`rows captured: ${rows.length}`]);
    expect(rows).toEqual([]);
  });

  it('E: payloads carry nothing beyond install id, command, version and stage', async () => {
    await seed(true);
    await agentSession(1);
    const active = captured.filter((c) => c.body['stage'] === 'agent_active');
    expect(active).toHaveLength(1);
    expect(Object.keys(active[0]!.body).sort()).toEqual(['cliVersion', 'command', 'installId', 'stage']);
  });
});
