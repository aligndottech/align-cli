import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piExtensionBody } from '../lib/agent-rules.js';
import { applyConfigWrite } from '../lib/launch/config-writes.js';
import { readCursorState } from '../lib/launch/cursor-state.js';
import { findOnPath } from '../lib/launch/detect.js';
import { writeIfChanged } from '../lib/launch/launch-files.js';
import { launchIfChosen } from '../lib/launch/launch.js';
import { readOpenCodeState } from '../lib/launch/opencode-state.js';
import { readPiState } from '../lib/launch/pi-state.js';
import { readProjectState } from '../lib/launch/project-state.js';
import { runAgent } from '../lib/launch/run-agent.js';
import { BACKUP_SUFFIX, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';

/*
 * The real pipeline (state readers, builders, launch-file writer, safe config writer, spawn)
 * against FAKE pi and cursor-agent binaries on PATH. The real pi and cursor-agent are never run
 * (cursor-agent is not installed on the dev machine at all).
 */
let root: string, bin: string, cache: string, cwd: string, home: string, agentDir: string, record: string;
let lines: string[];
let manifest: Record<string, WrittenConfig>;

function fake(name: string) {
  const script = path.join(bin, name);
  writeFileSync(script, `#!/bin/sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR ?? null, wrapped: process.env.ALIGN_WRAPPED ?? null}))' "${record}" "$@"
exit 5
`);
  chmodSync(script, 0o755);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-wo-e2e-')));
  bin = path.join(root, 'bin'); cache = path.join(root, 'cache'); cwd = path.join(root, 'repo'); home = path.join(root, 'home');
  agentDir = path.join(root, 'pi-agent'); record = path.join(root, 'record.json');
  mkdirSync(bin); mkdirSync(path.join(cwd, '.git'), { recursive: true }); mkdirSync(home); mkdirSync(agentDir);
  fake('pi'); fake('cursor-agent');
  lines = []; manifest = {};
  setWriteRecorder((f, e) => { manifest[f] = e; });
  for (const k of ['ALIGN_WRAPPED', 'ALIGN_NO_LAUNCH', 'PI_CODING_AGENT_DIR', 'ALIGN_LAUNCH_DRY_RUN', 'ALIGN_LAUNCH_TRACE']) vi.stubEnv(k, undefined);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH']}`);
});
afterEach(() => { setWriteRecorder(undefined); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const run = (agent: string, argv: string[] = ['node', 'align', '--'], env: Record<string, string | undefined> = {}) =>
  launchIfChosen({
    env: { ...process.env, ...env }, argv, cwd, home, platform: process.platform, isTTY: true,
    config: { getAgent: () => agent, setAgent: () => {} },
    findOnPath,
    readProjectState: (c, h) => readProjectState(c, h, { localIsDefault: true }),
    readOpenCodeState: (c, h) => readOpenCodeState(c, h, { localIsDefault: true }),
    readPiState: (c, h, e) => readPiState(c, h, { localIsDefault: true }, e),
    readCursorState: (c, h) => readCursorState(c, h, { localIsDefault: true }),
    applyConfigWrite,
    cacheDir: () => cache, writeIfChanged, runAgent: (spec) => runAgent(spec),
    record: () => {}, pick: async () => null, err: (l) => lines.push(l), now: () => 0,
  });
const recorded = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; agentDir: string | null; wrapped: string | null };

describe('pi against a fake binary', () => {
  it('runs pi with -e on the cached extension, writes the MCP entry once, and never moves the agent dir', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir); // the child inherits process.env
    expect(await run('pi', ['node', 'align', '--', 'fix it'], { PI_CODING_AGENT_DIR: agentDir })).toEqual({ handled: true, code: 5 });
    const r = recorded();
    expect(r.argv.slice(0, 3)).toEqual(['fix it', '-e', path.join(cache, 'pi-align.ts')]);
    expect(r.agentDir).toBe(agentDir); // the user's own value, passed through untouched
    expect(r.wrapped).toBe('1');
    expect(readFileSync(path.join(cache, 'pi-align.ts'), 'utf8')).toBe(piExtensionBody('local'));
    const mcp = JSON.parse(readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['align-local']);
    expect(lines.filter((l) => l.startsWith('Added the align-local'))).toHaveLength(1);
  });

  it('a second launch writes nothing and says nothing about config (written ONCE)', async () => {
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    const first = readFileSync(path.join(agentDir, 'mcp.json'), 'utf8');
    lines.length = 0;
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).toBe(first);
    expect(lines.filter((l) => l.includes('Added'))).toEqual([]);
  });

  it('skips -e when the project already has the local extension', async () => {
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'align.ts'), piExtensionBody('local'));
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(recorded().argv).not.toContain('-e');
    expect(existsSync(path.join(cache, 'pi-align.ts'))).toBe(false);
  });

  it('with mcp.json a symlink (this machine\'s ~/.pi/agent/mcp.json -> clank) it skips with one line and pi still opens', async () => {
    const other = path.join(root, 'clank-mcp.json');
    writeFileSync(other, '{"mcpServers":{"clank":{}}}');
    symlinkSync(other, path.join(agentDir, 'mcp.json'));
    expect(await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir })).toEqual({ handled: true, code: 5 });
    expect(readFileSync(other, 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
    const mentions = lines.filter((l) => l.includes(other));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain(path.join(agentDir, 'mcp.json'));
    expect(recorded().argv).toContain('-e');
  });

  it('--undo puts an existing mcp.json back byte for byte', async () => {
    const original = '{ "mcpServers": {"mine": {"command": "x"}}  }\n';
    writeFileSync(path.join(agentDir, 'mcp.json'), original);
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).not.toBe(original);
    const report = undoWrittenConfigs(manifest);
    expect(report.restored).toEqual([path.join(agentDir, 'mcp.json')]);
    expect(readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(agentDir, 'mcp.json') + BACKUP_SUFFIX)).toBe(false);
  });
});

describe('cursor-agent against a fake binary', () => {
  it('runs it with --approve-mcps last and writes the MCP entry and hooks into ~/.cursor once', async () => {
    expect(await run('cursor', ['node', 'align', '--', 'fix it'])).toEqual({ handled: true, code: 5 });
    expect(recorded().argv).toEqual(['fix it', '--approve-mcps']);
    const mcp = JSON.parse(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['align-local']);
    const hooks = JSON.parse(readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['postToolUse', 'preToolUse']);
    const before = [readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')];
    lines.length = 0;
    await run('cursor');
    expect([readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')]).toEqual(before);
    expect(lines.filter((l) => l.includes('Added'))).toEqual([]);
  });

  it('--undo restores the pre-Align files and removes the ones align created', async () => {
    mkdirSync(path.join(home, '.cursor'));
    const original = '{"mcpServers":{"mine":{"command":"x"}}}\n';
    writeFileSync(path.join(home, '.cursor', 'mcp.json'), original);
    await run('cursor');
    const report = undoWrittenConfigs(manifest);
    expect(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
    expect(report.removed).toEqual([path.join(home, '.cursor', 'hooks.json')]);
    expect(existsSync(path.join(home, '.cursor', 'hooks.json'))).toBe(false);
  });
});
