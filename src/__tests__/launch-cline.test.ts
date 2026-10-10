import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClineLaunch } from '../lib/launch/adapters/cline.js';
import { mcpChildEnv } from '../lib/launch/mcp-child-env.js';
import { clineMcpFile, clinePins, readClineState } from '../lib/launch/cline-state.js';

/*
 * Cline CLI, written ONCE (cline 3.0.70, binary-verified in a sandbox). No per-session MCP input
 * that keeps the user's file: CLINE_MCP_SETTINGS_PATH would point Cline at a copy, and any
 * `cline mcp add` during the session would land in that copy. `cline mcp add --yes` wrote
 * `<data dir>/settings/cline_mcp_settings.json`; `cline config --json` listed a flat
 * `{command, args}` align-local beside the user's server. A repo's `.cline/cline_mcp_settings.json`
 * and `.cline/data/settings/cline_mcp_settings.json` were NOT loaded (Cline's own source: "opening
 * a repository cannot activate repository-controlled MCP servers"). `--config` is never passed:
 * that directory also holds the user's auth.
 */
const O = { localIsDefault: false };
const CANON = { command: 'align', args: ['mcp', '--env', 'local'] };

let root: string, home: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-cline-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const def = () => path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
const put = (file: string, body: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
};

describe('clineMcpFile: the path resolution in cline 3.0.70', () => {
  it('CLINE_MCP_SETTINGS_PATH, else CLINE_DATA_DIR/settings, else CLINE_DIR/data/settings, else ~/.cline/data/settings', () => {
    expect(clineMcpFile(home, { CLINE_MCP_SETTINGS_PATH: '/m.json', CLINE_DATA_DIR: '/d' }, [])).toBe(path.resolve('/m.json'));
    expect(clineMcpFile(home, { CLINE_DATA_DIR: '/d', CLINE_DIR: '/c' }, [])).toBe(path.join(path.resolve('/d'), 'settings', 'cline_mcp_settings.json'));
    expect(clineMcpFile(home, { CLINE_DIR: '/c' }, [])).toBe(path.join(path.resolve('/c'), 'data', 'settings', 'cline_mcp_settings.json'));
    expect(clineMcpFile(home, {}, [])).toBe(def());
  });
  it('the user\'s own --config dir beats CLINE_DIR; --data-dir moves the MCP file in a real session (it sets CLINE_DATA_DIR)', () => {
    expect(clineMcpFile(home, { CLINE_DIR: '/c' }, ['--config', '/u'])).toBe(path.join(path.resolve('/u'), 'data', 'settings', 'cline_mcp_settings.json'));
    expect(clineMcpFile(home, {}, ['--data-dir=/dd'])).toBe(path.join(path.resolve('/dd'), 'settings', 'cline_mcp_settings.json'));
    expect(clineMcpFile(home, { CLINE_DATA_DIR: '/d' }, ['--data-dir', '/dd'])).toBe(path.join(path.resolve('/dd'), 'settings', 'cline_mcp_settings.json'));
  });
  const SANDBOX_OFF = { CLINE_SANDBOX: '', CLINE_SANDBOX_DATA_DIR: '', CLINE_PROVIDER_SETTINGS_PATH: '' };
  it('clinePins: the location variables as cline resolves them, and the sandbox switches off (empty is a no-op in cline\'s source)', () => {
    expect(clinePins(home, {}, [])).toEqual({ CLINE_DIR: path.join(home, '.cline'), CLINE_DATA_DIR: path.join(home, '.cline', 'data'), CLINE_MCP_SETTINGS_PATH: def(), ...SANDBOX_OFF });
    expect(clinePins(home, {}, ['--config', '/u'])).toEqual({ CLINE_DIR: path.join(home, '.cline'), CLINE_DATA_DIR: path.join(path.resolve('/u'), 'data'), CLINE_MCP_SETTINGS_PATH: path.join(path.resolve('/u'), 'data', 'settings', 'cline_mcp_settings.json'), ...SANDBOX_OFF });
  });
  it('clinePins with --data-dir: the data dir and MCP file follow it, and the sandbox pins are left to cline (the flag turns sandbox on)', () => {
    expect(clinePins(home, {}, ['--data-dir', '/dd'])).toEqual({ CLINE_DIR: path.join(home, '.cline'), CLINE_DATA_DIR: path.resolve('/dd'), CLINE_MCP_SETTINGS_PATH: path.join(path.resolve('/dd'), 'settings', 'cline_mcp_settings.json') });
  });
});

describe('readClineState', () => {
  const read = () => readClineState(cwd, home, O, {}, 'linux', []);
  it('no file: not present, nothing in conflict', () => {
    expect(read()).toEqual({ present: false, overridden: [], mcpFile: def(), oneSession: false });
  });
  it('the user\'s --config or --data-dir marks the file as one session\'s (both pick a directory for this run)', () => {
    expect(readClineState(cwd, home, O, {}, 'linux', ['--config', '/u']).oneSession).toBe(true);
    expect(readClineState(cwd, home, O, {}, 'linux', ['--data-dir=/d']).oneSession).toBe(true);
    expect(readClineState(cwd, home, O, { CLINE_DIR: '/c' }, 'linux', []).oneSession).toBe(false);
  });
  it('the entry Align writes (with its env block) reads back as present; one with a foreign env key does not', () => {
    put(def(), { mcpServers: { 'align-local': { ...CANON, env: mcpChildEnv({ ALIGN_ENV: 'local' }) } } });
    expect(read().present).toBe(true);
    put(def(), { mcpServers: { 'align-local': { ...CANON, env: { ...mcpChildEnv({}), NODE_OPTIONS: '--require ./x.js' } } } });
    expect(read().conflict).toBe(def());
  });
  it('canonical align-local is present: flat, and the transport shape `cline mcp add` writes', () => {
    put(def(), { mcpServers: { 'align-local': CANON } });
    expect(read().present).toBe(true);
    put(def(), { mcpServers: { 'align-local': { transport: { type: 'stdio', ...CANON } } } });
    expect(read().present).toBe(true);
  });
  it('a non-canonical align-local is a conflict: another command, or a transport that adds env', () => {
    put(def(), { mcpServers: { 'align-local': { command: '/bin/evil' } } });
    expect(read().conflict).toBe(def());
    put(def(), { mcpServers: { 'align-local': { transport: { type: 'stdio', ...CANON, env: { ALIGN_ENV: 'prod' } } } } });
    expect(read().conflict).toBe(def());
  });
  it('fail closed: a settings file align cannot parse that mentions align is a conflict (nothing written into it)', () => {
    mkdirSync(path.dirname(def()), { recursive: true });
    writeFileSync(def(), '{"mcpServers":{"align\\u002dlocal":{"command":"/bin/evil"},}}');
    expect(read().conflict).toBe(def());
  });
  it('a repo .cline file is not a layer Cline loads, so it neither blocks nor stands in (two paths)', () => {
    put(path.join(cwd, '.cline', 'cline_mcp_settings.json'), { mcpServers: { 'align-local': { command: '/bin/evil' } } });
    put(path.join(cwd, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), { mcpServers: { 'align-local': CANON } });
    expect(read()).toEqual({ present: false, overridden: [], mcpFile: def(), oneSession: false });
  });
});

describe('buildClineLaunch', () => {
  const base = { present: false, overridden: [], mcpFile: '/h/.cline/data/settings/cline_mcp_settings.json', oneSession: false };
  it('absent: one write of a flat align-local with its env block (Cline\'s MCP children inherit a repo .env otherwise), args untouched', () => {
    expect(buildClineLaunch({ ...base, passthrough: ['-i'], env: { ALIGN_ENV: 'local' } })).toEqual({
      bin: 'cline', args: ['-i'], env: { ALIGN_WRAPPED: '1' }, files: [],
      writes: [{ kind: 'mcp-entry', file: base.mcpFile, topKey: 'mcpServers', name: 'align-local', entry: { ...CANON, env: mcpChildEnv({ ALIGN_ENV: 'local' }) } }],
    });
  });
  it('present: no write and no duplicate', () => {
    expect(buildClineLaunch({ ...base, present: true, passthrough: [] })).toEqual({ bin: 'cline', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('conflict: no write, one line naming the file', () => {
    expect(buildClineLaunch({ ...base, conflict: base.mcpFile, passthrough: [] }).notes).toEqual([`${base.mcpFile} defines its own align-local MCP server, so Align did not add its graph to Cline. Remove that entry to use the graph.`]);
  });
  it('a one-session --config or --data-dir dir: nothing written there, one line', () => {
    for (const flag of ['--config', '--data-dir']) {
      const s = buildClineLaunch({ ...base, oneSession: true, passthrough: [flag, '/tmp/x'] });
      expect(s.writes, flag).toBeUndefined();
      expect(s.notes, flag).toEqual([`Align does not add its graph to a Cline directory chosen for one session (${flag}). Run cline without it once, or add align-local to /h/.cline/data/settings/cline_mcp_settings.json yourself.`]);
    }
  });
  it('never passes --config, --yolo or an auto-approve value', () => {
    expect(buildClineLaunch({ ...base, passthrough: [] }).args).toEqual([]);
  });
});
