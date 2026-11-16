/**
 * `align --local --approve --repo-only`: set Align up for ONE repo and ONE agent, with no
 * machine-wide write. The real binary, in a scratch non-git repo, with HOME, USERPROFILE and
 * APPDATA pointed at a scratch directory that already holds the user-level dirs of Claude Desktop,
 * Cursor and VS Code (so a detection-driven write would have somewhere to land). Claude Code,
 * OpenCode and Gemini CLI are all on PATH; Claude Code is the priority pick.
 *
 * Test list:
 *  a. --repo-only adds nothing under home except Align's own ~/.align
 *  b. --repo-only writes only the chosen agent's project files (no .cursor, .gemini, .opencode)
 *  c. without the flag every agent's project files are still written (default unchanged)
 *  d. `align use --undo` after --repo-only leaves the repo and home as they were
 *  e. the plan filter: setupAgentAlignment({ agent }) writes that agent's files and no others
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LAUNCH_AGENTS } from '../lib/launch/agents.js';
import { planAgentAlignment, setupAgentAlignment } from '../lib/agent-rules.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = join(ROOT, 'src', 'index.ts');

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'align-repo-only-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(repo);
  // The user-level homes of agents a detection-driven setup would write into.
  for (const d of ['.config/Claude', '.cursor', '.config/Code/User', 'AppData/Roaming/Claude', 'AppData/Roaming/Code/User']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.claude.json'), '{}\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'opencode', 'gemini']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  // System tools minus every agent Align can open, so the installed set is exactly the three above.
  const sys = join(root, 'sys');
  mkdirSync(sys);
  const agentBins = new Set<string>(LAUNCH_AGENTS.map((a) => a.bin));
  for (const name of readdirSync('/usr/bin')) if (!agentBins.has(name) && name !== 'node') symlinkSync(join('/usr/bin', name), join(sys, name));
  const env: Record<string, string> = {
    PATH: [bin, sys].join(':'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    ALIGN_NO_LAUNCH: '1',
  };
  const run = (args: string[]) => exec(process.execPath, [TSX, ENTRY, ...args], { cwd: repo, env, timeout: 120_000 });
  return { repo, home, run };
}

const AGENT_DIRS = ['.cursor', '.gemini', '.opencode'];

describe('align --repo-only', () => {
  it('writes nothing under home beyond Align\'s own ~/.align', async () => {
    const r = rig();
    const before = walk(r.home);
    await r.run(['--local', '--approve', '--repo-only']);
    const added = walk(r.home).filter((f) => !before.includes(f));
    expect(added.filter((f) => !f.startsWith('.align/'))).toEqual([]);
    expect(walk(r.home).filter((f) => before.includes(f)).length).toBe(before.length);
    // positive control: the run did write the project files, so an empty diff above is not an idle run
    expect(existsSync(join(r.repo, '.mcp.json'))).toBe(true);
  }, 150_000);

  it('writes only the chosen agent\'s project files', async () => {
    const r = rig();
    await r.run(['--local', '--approve', '--repo-only']);
    const top = readdirSync(r.repo);
    for (const d of AGENT_DIRS) expect(top).not.toContain(d);
    expect(top).toContain('.claude');
    expect(top).toContain('CLAUDE.md');
    expect(top).toContain('.mcp.json');
  }, 150_000);

  it('without the flag every agent\'s project files are still written', async () => {
    const r = rig();
    await r.run(['--local', '--approve']);
    const top = readdirSync(r.repo);
    for (const d of AGENT_DIRS) expect(top).toContain(d);
  }, 150_000);

  it('align use --undo restores the repo and home', async () => {
    const r = rig();
    const homeBefore = walk(r.home);
    await r.run(['--local', '--approve', '--repo-only']);
    expect(walk(r.repo).length).toBeGreaterThan(0);
    await r.run(['use', '--undo']);
    expect(walk(r.repo)).toEqual([]);
    expect(walk(r.home).filter((f) => !f.startsWith('.align/'))).toEqual(homeBefore);
  }, 300_000);
});

describe('setupAgentAlignment agent filter', () => {
  it('writes the named agent\'s files and no other agent\'s', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'align-filter-'));
    const planned = planAgentAlignment(cwd, 'opencode').map((w) => w.file);
    expect(planned).toContain('.opencode/plugins/align.js');
    expect(planned).not.toContain('.gemini/settings.json');
    expect(planned).not.toContain('.claude/settings.json');
    const written = setupAgentAlignment({ cwd, agent: 'opencode' });
    expect(written).toEqual(planned);
    expect(existsSync(join(cwd, '.gemini'))).toBe(false);
  });
});
