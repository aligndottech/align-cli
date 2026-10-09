import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexLaunch, type CodexLaunchContext } from '../lib/launch/adapters/codex.js';
import { readCodexState } from '../lib/launch/codex-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave A Test List (Codex, per session through `-c` overrides; verified on codex-cli 0.153.0:
 * `codex -c mcp_servers.align-local.command='align' ... mcp list` lists align-local AND the
 * user's own servers):
 *  1. nothing present: two -c overrides define align-local, nothing else is injected
 *  2. the injected name is align-local, never align
 *  3. an existing local entry (align-local, or align at --env local) -> no -c at all
 *  4. an align entry aimed at another graph is not ours: inject align-local beside it
 *  5. -c goes FIRST, before the user's args, so it reaches every subcommand and a user `--`
 *  6. values are TOML literal strings (single quotes): no `"`, which Windows' cmd shim refuses
 *  7. win32 goes through cmd /c; ALIGN_WRAPPED always set
 */
const BASE: CodexLaunchContext = { passthrough: [], projectHasMcp: false };
const ctx = (over: Partial<CodexLaunchContext> = {}): CodexLaunchContext => ({ ...BASE, ...over });

describe('buildCodexLaunch', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('injects align-local as two -c overrides when nothing is present', () => {
    const spec = buildCodexLaunch(ctx());
    expect(spec.bin).toBe('codex');
    expect(spec.args).toEqual([
      '-c', "mcp_servers.align-local.command='align'",
      '-c', "mcp_servers.align-local.args=['mcp','--env','local']",
    ]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
    expect(spec.writes).toBeUndefined();
  });

  it('never defines a server named align', () => {
    const args = buildCodexLaunch(ctx()).args.join(' ');
    expect(args).toContain('mcp_servers.align-local.');
    expect(args).not.toMatch(/mcp_servers\.align\./);
  });

  it('injects nothing but the recursion guard when a local entry is already present', () => {
    const spec = buildCodexLaunch(ctx({ projectHasMcp: true, passthrough: ['resume', '--last'] }));
    expect(spec.args).toEqual(['resume', '--last']);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('puts -c before the user\'s args (a root option reaches any subcommand) and keeps theirs in order', () => {
    expect(buildCodexLaunch(ctx({ passthrough: ['exec', 'do x'] })).args.slice(4)).toEqual(['exec', 'do x']);
    expect(buildCodexLaunch(ctx({ passthrough: ['--', '-not-a-flag'] })).args.slice(0, 2)[0]).toBe('-c');
    expect(buildCodexLaunch(ctx({ passthrough: ['--', '-not-a-flag'] })).args.slice(4)).toEqual(['--', '-not-a-flag']);
  });

  it('holds no double quote in any arg (cmd.exe shim refuses one) and no secret-bearing value', () => {
    const spec = buildCodexLaunch(ctx());
    expect(spec.args.length).toBeGreaterThan(0);
    for (const a of spec.args) expect(a).not.toContain('"');
    expect(JSON.stringify(spec)).not.toMatch(/token|secret|api[_-]?key/i);
  });

  it('on win32 the server goes through cmd /c', () => {
    setPlatform('win32');
    expect(buildCodexLaunch(ctx()).args).toEqual([
      '-c', "mcp_servers.align-local.command='cmd'",
      '-c', "mcp_servers.align-local.args=['/c','align','mcp','--env','local']",
    ]);
  });
});

describe('readCodexState', () => {
  let root: string;
  let home: string;
  let proj: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-codex-state-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(path.join(proj, '.git'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const userToml = (text: string) => writeFileSync(path.join(home, '.codex', 'config.toml'), text);
  const state = (env: Record<string, string | undefined> = {}, localIsDefault = false) => readCodexState(proj, home, { localIsDefault }, env);

  it('no config at all: absent', () => {
    rmSync(path.join(home, '.codex'), { recursive: true });
    expect(state().projectHasMcp).toBe(false);
  });

  it('an align-local table (ours, bare or quoted key) is present', () => {
    userToml('[mcp_servers.align-local]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n');
    expect(state().projectHasMcp).toBe(true);
    userToml('[mcp_servers."align-local"]\ncommand = "align"\n');
    expect(state().projectHasMcp).toBe(true);
  });

  it('the setup-managed [mcp_servers.align] block at --env local is present', () => {
    userToml('# >>> align >>>\n[mcp_servers.align]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n# <<< align <<<\n');
    expect(state().projectHasMcp).toBe(true);
  });

  it('an align table aimed at another graph is absent (prod user keeps theirs, gets align-local too)', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp", "--env", "prod"]\n\n[mcp_servers.linear]\ncommand = "npx"\nargs = ["--env", "local"]\n');
    expect(state().projectHasMcp).toBe(false);
  });

  it('reads only the align table\'s own body, not the table after it', () => {
    // `enabled = false` belongs to the NEXT table, so the local align entry above it is live.
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n\n[mcp_servers.other]\ncommand = "npx"\nenabled = false\n');
    expect(state().projectHasMcp).toBe(true);
  });

  it('a bare align table counts only when local is this machine\'s default', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n');
    expect(state({}, false).projectHasMcp).toBe(false);
    expect(state({}, true).projectHasMcp).toBe(true);
  });

  it('a disabled local entry does not do our job', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\nenabled = false\n');
    expect(state().projectHasMcp).toBe(false);
  });

  it('a sibling table whose name merely starts with align is not ours', () => {
    userToml('[mcp_servers.align-localx]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n');
    expect(state().projectHasMcp).toBe(false);
  });

  it('reads CODEX_HOME when the user set it, and not ~/.codex then', () => {
    const ch = path.join(root, 'ch');
    mkdirSync(ch);
    writeFileSync(path.join(ch, 'config.toml'), '[mcp_servers.align-local]\ncommand = "align"\n');
    expect(state({ CODEX_HOME: ch }).projectHasMcp).toBe(true);
    userToml('[mcp_servers.align-local]\ncommand = "align"\n');
    rmSync(path.join(ch, 'config.toml'));
    expect(state({ CODEX_HOME: ch }).projectHasMcp).toBe(false);
  });

  it('reads the project .codex/config.toml up to the git root', () => {
    mkdirSync(path.join(proj, '.codex'));
    writeFileSync(path.join(proj, '.codex', 'config.toml'), '[mcp_servers.align-local]\ncommand = "align"\n');
    expect(state().projectHasMcp).toBe(true);
  });
});
