import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAiderLaunch } from '../lib/launch/adapters/aider.js';

/*
 * Aider has no MCP (aider 0.86.2, `aider --help` in a sandbox venv), so it gets no graph tools.
 * `--read FILE` "specify a read-only file (can be used multiple times)" loads Align's
 * instructions for one session. Nothing is written to the user's config.
 */
const cachePath = (n: string) => `/cache/${n}`;

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-aider-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildAiderLaunch', () => {
  it('no Align block handed in: `--read <launch file>` first, then the user args, ALIGN_WRAPPED', () => {
    const s = buildAiderLaunch({ passthrough: ['src/a.py'], cachePath });
    expect(s.bin).toBe('aider');
    expect(s.args).toEqual(['--read', '/cache/aider-align-instructions.md', 'src/a.py']);
    expect(s.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(s.files.map((f) => f.name)).toEqual(['aider-align-instructions.md']);
    expect(s.writes).toBeUndefined();
  });
  it('the user passes their own --read: both are kept', () => {
    expect(buildAiderLaunch({ passthrough: ['--read', 'CONVENTIONS.md'], cachePath }).args).toEqual(['--read', '/cache/aider-align-instructions.md', '--read', 'CONVENTIONS.md']);
  });
  it('a --read file of theirs that carries Align\'s general block (AGENTS.md) does NOT replace the Aider file: that block tells the model to call MCP tools Aider does not have', () => {
    const s = buildAiderLaunch({ passthrough: ['--read', 'AGENTS.md'], cachePath });
    expect(s.args).toEqual(['--read', '/cache/aider-align-instructions.md', '--read', 'AGENTS.md']);
    expect(s.files.map((f) => f.name)).toEqual(['aider-align-instructions.md']);
  });
  it('the instructions say the graph is not connected and point the user at `align ask` / `align check` in another terminal', () => {
    const text = buildAiderLaunch({ passthrough: [], cachePath }).files[0]!.content;
    expect(text).toContain('align ask');
    expect(text).toContain('align check');
    expect(text).toContain('another terminal');
    expect(text).toMatch(/no (MCP|graph) tools/i);
  });
  it('carries no MCP server and no lint or approval flag (Open Question 8 stays open)', () => {
    const s = buildAiderLaunch({ passthrough: [], cachePath });
    expect(JSON.stringify(s)).not.toContain('align-local');
    expect(s.args.join(' ')).not.toMatch(/--lint-cmd|--yes-always|--auto-lint/);
  });
});
