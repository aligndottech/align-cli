/**
 * `align --local` shows the files it will create or modify, then asks "Continue?" before writing
 * any of them. The real binary, in a scratch repo with HOME pointed at a scratch directory (so no
 * agent is detected and nothing outside the scratch repo can be touched).
 *
 * Declining must leave the folder empty. --approve and a run with no terminal must print the same
 * list and write without asking. The PTY half runs on POSIX with python3, like share-pty.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canPty, childEnv, ROOT } from './helpers/share-harness.js';

vi.setConfig({ testTimeout: 120_000 });

const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const AGENT_FILES = ['.claude', '.cursor', '.gemini', '.mcp.json', '.opencode', '.pi', 'AGENTS.md', 'CLAUDE.md'];

function rig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'align-confirm-writes-'));
  const work = path.join(dir, 'work');
  mkdirSync(work);
  const env = childEnv(path.join(dir, 'home'));
  mkdirSync(path.join(dir, 'home'), { recursive: true });
  env['TERM'] = 'xterm';
  // The agent picker lists installed agents first, so Enter picks a different row on a laptop that has
  // Claude Code than on a CI runner with none (there the first row is an uninstalled agent, Enter
  // re-opens the picker forever, and the list was never reached). Pin the PATH: one fake `claude`, plus
  // only what node and the pty helper need. Set NO_FAKE_AGENT=1 to drop the fake and see the CI failure.
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  if (!process.env['NO_FAKE_AGENT']) {
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'claude'), 0o755);
  }
  // node itself is linked in rather than its directory put on PATH: an npm-global agent can sit beside it.
  symlinkSync(process.execPath, path.join(bin, 'node'));
  env['PATH'] = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  for (const k of Object.keys(env)) if (/^(CI|GITHUB_.*|ALIGN_TOKEN|ALIGN_ENV|ALIGN_WRAPPED|ALIGN_NO_LAUNCH)$/.test(k)) delete env[k];
  const entries = () => readdirSync(work).sort();
  return { dir, work, env, entries, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function pty(r: ReturnType<typeof rig>, args: string[], steps: Array<[string, string]>): Promise<{ code: number; out: string }> {
  const cmd = [process.execPath, TSX, ENTRY, ...args];
  return new Promise((resolve) => {
    const p = spawn('python3', [path.join(__dirname, 'helpers/pty-run.py'), JSON.stringify(cmd), JSON.stringify(steps)], { cwd: r.work, env: r.env });
    let out = ''; p.stdout.on('data', (b) => (out += b));
    p.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
  });
}

function plain(r: ReturnType<typeof rig>, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TSX, ENTRY, ...args], { cwd: r.work, env: r.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const PICK: [string, string] = ['Which coding agent', '\r'];
const SKIP_CONNECTORS: [string, string] = ['Connect more sources', '\r'];

describe.skipIf(!canPty)('setup confirms the files it will write', () => {
  it('declining at "Continue?" writes none of them', async () => {
    const r = rig();
    try {
      const { out } = await pty(r, ['--local'], [PICK, ['Continue?', 'n'], SKIP_CONNECTORS]);
      expect(out).toContain('Align may create or change these files:');
      expect(out).toContain('create  CLAUDE.md');
      expect(out).toContain('align use --undo');
      expect(out).toContain('Left your agent config alone');
      expect(r.entries()).toEqual([]);
    } finally { r.close(); }
  });

  it('answering yes (the default) writes every file the list named', async () => {
    const r = rig();
    try {
      const { out } = await pty(r, ['--local'], [PICK, ['Continue?', '\r'], SKIP_CONNECTORS]);
      const listed = AGENT_FILES.filter((f) => out.includes(f === '.claude' ? '.claude/settings.json' : f));
      expect(listed.length).toBe(AGENT_FILES.length);
      expect(r.entries()).toEqual([...AGENT_FILES].sort());
    } finally { r.close(); }
  });

  it('--approve on a terminal prints the list, does not ask, and writes', async () => {
    const r = rig();
    try {
      const { out } = await pty(r, ['--local', '--approve'], [SKIP_CONNECTORS]);
      expect(out).toContain('Align may create or change these files:');
      expect(out).not.toContain('Continue?');
      expect(r.entries()).toEqual([...AGENT_FILES].sort());
    } finally { r.close(); }
  });
});

describe('with no terminal', () => {
  it('prints the list, does not ask, and writes', async () => {
    const r = rig();
    try {
      const { code, out } = await plain(r, ['--local']);
      expect(code).toBe(0);
      expect(out).toContain('Align may create or change these files:');
      expect(out).toContain('create  .mcp.json');
      expect(out).not.toContain('Continue?');
      expect(r.entries()).toEqual([...AGENT_FILES].sort());
    } finally { r.close(); }
  });
});
