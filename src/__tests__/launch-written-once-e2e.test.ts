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
import { BACKUP_SUFFIX, mergeWrittenConfig, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';

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
  // pi-mcp-adapter is installed unless a test says otherwise: without it no MCP entry is written.
  writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter'] }));
  lines = []; manifest = {};
  setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
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
    writeFileSync(path.join(agentDir, 'trust.json'), JSON.stringify({ [cwd]: true }));
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(recorded().argv).not.toContain('-e');
    expect(existsSync(path.join(cache, 'pi-align.ts'))).toBe(false);
  });

  it('still passes -e when the project is not trusted: pi would not load that extension', async () => {
    mkdirSync(path.join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(path.join(cwd, '.pi', 'extensions', 'align.ts'), piExtensionBody('local'));
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(recorded().argv).toContain('-e');
  });

  it('without pi-mcp-adapter it writes no MCP entry (pi would not read it), but still injects the extension', async () => {
    writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: ['pi-skills'] }));
    await run('pi', undefined, { PI_CODING_AGENT_DIR: agentDir });
    expect(existsSync(path.join(agentDir, 'mcp.json'))).toBe(false);
    expect(recorded().argv).toContain('-e');
  });

  it('an UNSET PI_CODING_AGENT_DIR stays unset for the child (the default dir is under HOME)', async () => {
    const defaultDir = path.join(home, '.pi', 'agent');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(path.join(defaultDir, 'settings.json'), JSON.stringify({ packages: ['pi-mcp-adapter'] }));
    await run('pi');
    expect(recorded().agentDir).toBeNull();
    expect(Object.keys(JSON.parse(readFileSync(path.join(defaultDir, 'mcp.json'), 'utf8')).mcpServers)).toEqual(['align-local']);
  });

  it('a linked default agent dir (~/.pi/agent -> another tool\'s dir) is not written through, the notice is printed once per launch, and pi still opens', async () => {
    const other = path.join(root, 'clank-agent');
    mkdirSync(other);
    writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ packages: ['pi-mcp-adapter'] }));
    writeFileSync(path.join(other, 'mcp.json'), '{"mcpServers":{"clank":{}}}');
    mkdirSync(path.join(home, '.pi'));
    symlinkSync(other, path.join(home, '.pi', 'agent'));
    expect(await run('pi')).toEqual({ handled: true, code: 5 });
    expect(readFileSync(path.join(other, 'mcp.json'), 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
    expect(lines.filter((l) => l.includes('is a symlink to'))).toHaveLength(1);
    expect(recorded().argv).toContain('-e');
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
  it('runs it with only the user\'s args (no --approve-mcps), writes the MCP entry once, writes NO hooks, and says how to approve it', async () => {
    expect(await run('cursor', ['node', 'align', '--', 'fix it'])).toEqual({ handled: true, code: 5 });
    expect(recorded().argv).toEqual(['fix it']);
    const mcp = JSON.parse(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['align-local']);
    expect(existsSync(path.join(home, '.cursor', 'hooks.json'))).toBe(false);
    expect(lines.some((l) => l.includes('agent mcp enable align-local'))).toBe(true);
    const before = readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8');
    lines.length = 0;
    await run('cursor');
    expect(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(before);
    expect(lines.filter((l) => l.includes('Added') || l.includes('agent mcp enable'))).toEqual([]);
  });

  it('--undo restores the pre-Align file byte for byte', async () => {
    mkdirSync(path.join(home, '.cursor'));
    const original = '{"mcpServers":{"mine":{"command":"x"}}}\n';
    writeFileSync(path.join(home, '.cursor', 'mcp.json'), original);
    await run('cursor');
    const report = undoWrittenConfigs(manifest);
    expect(report.restored).toEqual([path.join(home, '.cursor', 'mcp.json')]);
    expect(readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
  });

  it('--undo after the user added a server keeps theirs and takes only align-local out', async () => {
    mkdirSync(path.join(home, '.cursor'));
    writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"mine":{"command":"x"}}}');
    await run('cursor');
    const f = path.join(home, '.cursor', 'mcp.json');
    const cur = JSON.parse(readFileSync(f, 'utf8'));
    cur.mcpServers.github = { token: 'later' };
    writeFileSync(f, JSON.stringify(cur));
    expect(undoWrittenConfigs(manifest).cleaned).toEqual([f]);
    expect(Object.keys(JSON.parse(readFileSync(f, 'utf8')).mcpServers).sort()).toEqual(['github', 'mine']);
  });
});
