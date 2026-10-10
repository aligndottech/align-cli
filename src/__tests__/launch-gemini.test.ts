import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGeminiLaunch, GEMINI_TRUST_NOTE, type GeminiLaunchContext } from '../lib/launch/adapters/gemini-cli.js';
import { geminiSystemFileRejection } from '../lib/launch/gemini-system-file.js';
import { readGeminiState } from '../lib/launch/gemini-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Test List (Gemini CLI 0.63.0). The first design, a per-session GEMINI_CLI_SYSTEM_SETTINGS_PATH
 * copy, gave Gemini NO Align graph: Gemini skips a system settings file (and system-defaults)
 * unless the file AND every parent directory is owned by root and not group/other writable
 * ("Security Warning: Skipping system settings file ... not owned by root"), and a launch cache
 * under the user's home can never pass. Reproduced with the real binary; see the PR.
 * The injection is now a written-once align-local entry in the USER settings file, by the safe
 * writer, with `align use --undo`:
 *  1. nothing present -> one mcp-entry write to the user settings file, no env, no flags, no files
 *  2. NEVER the system tier: no GEMINI_CLI_SYSTEM_SETTINGS_PATH / _DEFAULTS_PATH, whatever the state
 *  3. present (canonical align or align-local in a file Gemini loads) -> no write
 *  4. a non-canonical align-local in a loaded file -> no write, one line naming the file
 *  5. repo config is untrusted: a workspace file counts only when Gemini loads it (trusted folder)
 *  6. a system file Gemini rejects is not "present"
 *  7. trust: untrusted/unknown -> exactly one line; trusted/off -> none
 *  8. never --skip-trust, never GEMINI_CLI_TRUST_WORKSPACE; the user's own args pass unchanged
 */
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const USER_FILE = '/home/u/.gemini/settings.json';
const BASE: GeminiLaunchContext = {
  passthrough: [],
  cachePath: (n) => `/cache/${n}`,
  present: false,
  settingsFile: USER_FILE,
  trust: 'trusted',
};
const ctx = (over: Partial<GeminiLaunchContext> = {}): GeminiLaunchContext => ({ ...BASE, ...over });

describe('buildGeminiLaunch: injection', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('adds align-local ONCE to the user settings file when nothing is present', () => {
    const spec = buildGeminiLaunch(ctx());
    expect(spec.bin).toBe('gemini');
    expect(spec.writes).toEqual([{ kind: 'mcp-entry', file: USER_FILE, topKey: 'mcpServers', name: 'align-local', entry: LOCAL, invalidJsonAdvice: expect.stringContaining('comments') }]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
    expect(spec.notes ?? []).toEqual([]);
  });

  it('never points Gemini at a system settings file: it would be skipped unless root-owned (0.63.0)', () => {
    for (const over of [{}, { present: true }, { conflict: '/x.json' }, { trust: 'untrusted' as const }]) {
      const spec = buildGeminiLaunch(ctx(over));
      expect(Object.keys(spec.env).filter((k) => /SYSTEM_(SETTINGS|DEFAULTS)_PATH/.test(k))).toEqual([]);
      expect(spec.files).toEqual([]);
    }
  });

  it('removes the copies earlier align versions left in the launch cache (they held the admin file)', () => {
    expect(buildGeminiLaunch(ctx()).prune).toEqual({ prefix: 'gemini-system-settings-' });
  });

  it('align\'s own local server already present: no write, no note', () => {
    const spec = buildGeminiLaunch(ctx({ present: true }));
    expect(spec.writes ?? []).toEqual([]);
    expect(spec.notes ?? []).toEqual([]);
  });

  it('a non-canonical align-local in a file Gemini loads: nothing written, one line naming it', () => {
    const spec = buildGeminiLaunch(ctx({ conflict: '/repo/.gemini/settings.json' }));
    expect(spec.writes ?? []).toEqual([]);
    expect(spec.notes).toEqual(["/repo/.gemini/settings.json defines its own align-local MCP server, so Align did not add its graph to Gemini. Remove that entry to use the graph."]);
  });

  it('a blocker Gemini applies: nothing written, ONE plain line naming the file and why', () => {
    const spec = buildGeminiLaunch(ctx({ blocked: { file: '/home/u/.gemini/settings.json', why: 'mcp.excluded lists align-local' } }));
    expect(spec.writes ?? []).toEqual([]);
    expect(spec.notes).toEqual(['Gemini will not load Align\'s graph: /home/u/.gemini/settings.json - mcp.excluded lists align-local. Remove that to use the graph.']);
  });

  it('on win32 the server goes through cmd /c', () => {
    setPlatform('win32');
    expect(buildGeminiLaunch(ctx()).writes![0]!.entry).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });
});

describe('buildGeminiLaunch: trust and args', () => {
  it.each(['untrusted', 'unknown'] as const)('%s folder: exactly one line, the trust hint', (trust) => {
    expect(buildGeminiLaunch(ctx({ trust })).notes).toEqual([GEMINI_TRUST_NOTE]);
  });
  it.each(['trusted', 'off'] as const)('%s: no trust line', (trust) => {
    expect(buildGeminiLaunch(ctx({ trust })).notes ?? []).toEqual([]);
  });
  it('the trust line is true interactive and headless: it says what Gemini does and that the user decides', () => {
    expect(GEMINI_TRUST_NOTE).toBe("Gemini turns off MCP servers, Align's included, in folders you haven't trusted. Trust this folder in Gemini to use the graph here.");
  });

  it('never trusts on the user\'s behalf, in any context', () => {
    for (const trust of ['trusted', 'untrusted', 'unknown', 'off'] as const) {
      const spec = buildGeminiLaunch(ctx({ trust }));
      expect(spec.args).not.toContain('--skip-trust');
      expect(spec.env['GEMINI_CLI_TRUST_WORKSPACE']).toBeUndefined();
    }
  });

  it('passes the user\'s args through unchanged and alone, their own --skip-trust included', () => {
    expect(buildGeminiLaunch(ctx({ passthrough: ['-p', 'hi'] })).args).toEqual(['-p', 'hi']);
    expect(buildGeminiLaunch(ctx({ passthrough: ['--skip-trust', '--', 'x'] })).args).toEqual(['--skip-trust', '--', 'x']);
  });
});

describe('readGeminiState', () => {
  let root: string;
  let home: string;
  let proj: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-gemini-state-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    mkdirSync(path.join(home, '.gemini'), { recursive: true });
    mkdirSync(path.join(proj, '.gemini'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sysFile = () => path.join(root, 'sys.json');
  const sysEnv = () => ({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: sysFile() });
  // Gemini rejects a system file outside a root-owned tree, so a test tree (owned by the
  // test user) is rejected unless the rule is told otherwise.
  const state = (o: { env?: Record<string, string | undefined>; platform?: string; localIsDefault?: boolean; systemLoads?: boolean } = {}) =>
    readGeminiState(proj, home, { localIsDefault: o.localIsDefault ?? false }, o.env ?? sysEnv(), o.platform ?? 'linux', () => (o.systemLoads ? null : 'not owned by root'));
  const userFile = () => path.join(home, '.gemini', 'settings.json');
  const userSettings = (v: unknown) => writeFileSync(userFile(), JSON.stringify(v));
  const wsFile = () => path.join(proj, '.gemini', 'settings.json');
  const workspace = (v: unknown) => writeFileSync(wsFile(), JSON.stringify(v));
  const trustProj = () => writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
  const HOSTILE = { command: 'align', args: ['mcp', '--env', 'local'], env: { PATH: '/tmp/evil' } };
  const CANON = { command: 'align', args: ['mcp', '--env', 'local'] };

  it('the file to write is the user settings: ~/.gemini/settings.json, or $GEMINI_CLI_HOME/.gemini/settings.json', () => {
    expect(state().settingsFile).toBe(userFile());
    const gh = path.join(root, 'gh');
    expect(state({ env: { GEMINI_CLI_HOME: gh } }).settingsFile).toBe(path.join(gh, '.gemini', 'settings.json'));
  });

  it('a canonical align in the user settings is present; JSONC user settings are read too', () => {
    expect(state().present).toBe(false);
    userSettings({ mcpServers: { align: CANON } });
    expect(state().present).toBe(true);
    writeFileSync(userFile(), `// mine\n{ "mcpServers": { "align": ${JSON.stringify(CANON)} /* c */ } }`);
    expect(state().present).toBe(true);
  });

  it('a canonical align-local in the user settings is present (our own earlier write): nothing more to add', () => {
    userSettings({ mcpServers: { 'align-local': CANON } });
    expect(state()).toMatchObject({ present: true });
    expect(state().conflict).toBeUndefined();
  });

  it('another graph, a shell that mentions align, or win32 bare align is not present', () => {
    userSettings({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
    userSettings({ mcpServers: { align: { command: 'sh', args: ['-c', 'evil', 'align', 'mcp'] } } });
    expect(state({ localIsDefault: true }).present).toBe(false);
    userSettings({ mcpServers: { align: CANON } });
    expect(state({ platform: 'win32' }).present).toBe(false);
  });

  it('a non-canonical align-local in the user settings is a conflict: the writer never edits an existing entry', () => {
    userSettings({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, conflict: userFile() });
  });

  it('a hostile workspace align-local in a TRUSTED folder is a conflict (workspace outranks user), naming the file', () => {
    trustProj();
    workspace({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, conflict: wsFile() });
  });

  it('a canonical workspace align counts only in a trusted folder', () => {
    workspace({ mcpServers: { align: CANON } });
    expect(state().present).toBe(false);
    trustProj();
    expect(state().present).toBe(true);
  });

  it('a system file Gemini would REJECT (not root-owned) is not read: its canonical entry is not "present", its hostile one no conflict', () => {
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { align: CANON } }));
    expect(state().present).toBe(false);
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { 'align-local': HOSTILE } }));
    expect(state().conflict).toBeUndefined();
  });

  it('a system file Gemini WOULD load (root-owned tree) is read: canonical is present, hostile is a conflict', () => {
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { align: CANON } }));
    expect(state({ systemLoads: true }).present).toBe(true);
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { 'align-local': HOSTILE } }));
    expect(state({ systemLoads: true }).conflict).toBe(sysFile());
  });

  it('LAST layer wins per name: a trusted repo\'s non-canonical `align` replaces the user\'s canonical one, so it is not present and the repo file is named', () => {
    trustProj();
    userSettings({ mcpServers: { align: CANON } });
    workspace({ mcpServers: { align: { command: '/bin/echo', args: ['EVIL'] } } });
    expect(state()).toMatchObject({ present: false, conflict: wsFile() });
  });

  it('positive control: a canonical workspace `align` over a canonical user one stays present, no conflict', () => {
    trustProj();
    userSettings({ mcpServers: { align: CANON } });
    workspace({ mcpServers: { align: CANON } });
    expect(state()).toMatchObject({ present: true });
    expect(state().conflict).toBeUndefined();
  });

  it('a user\'s own non-canonical `align` (the prod graph) with no canonical one before it is no conflict, just not present', () => {
    userSettings({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state()).toMatchObject({ present: false });
    expect(state().conflict).toBeUndefined();
  });

  it('a later non-canonical align-local over an earlier canonical one is the effective entry: conflict', () => {
    trustProj();
    userSettings({ mcpServers: { 'align-local': CANON } });
    workspace({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, conflict: wsFile() });
  });

  it('probe K: an UNTRUSTED-by-Align workspace file is still checked for a conflict (Gemini may trust the folder via an IDE)', () => {
    workspace({ mcpServers: { 'align-local': HOSTILE } });
    expect(state().conflict).toBe(wsFile());
  });

  it('...but an untrusted workspace canonical `align` still does not count as present', () => {
    workspace({ mcpServers: { align: CANON } });
    expect(state().present).toBe(false);
  });

  it('GEMINI_RESTRICTED_MODE=true is untrusted whatever the rules say (Gemini checks it before GEMINI_CLI_TRUST_WORKSPACE)', () => {
    trustProj();
    expect(state({ env: { ...sysEnv(), GEMINI_RESTRICTED_MODE: 'true' } }).trust).toBe('untrusted');
    expect(state({ env: { ...sysEnv(), GEMINI_RESTRICTED_MODE: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true' } }).trust).toBe('untrusted');
  });

  describe('MCP blockers Gemini applies silently', () => {
    const FILE = () => userFile();
    it('mcp.excluded naming align-local (any case) in a loaded layer blocks it', () => {
      userSettings({ mcp: { excluded: ['Align-Local'] } });
      expect(state().blocked).toEqual({ file: FILE(), why: 'mcp.excluded lists align-local' });
    });
    it('excluded is a union: a trusted workspace can add to it', () => {
      trustProj();
      workspace({ mcp: { excluded: ['align-local'] } });
      expect(state().blocked?.file).toBe(wsFile());
    });
    it('mcp.allowed without align-local blocks it; with it, or absent, does not', () => {
      userSettings({ mcp: { allowed: ['other'] } });
      expect(state().blocked).toEqual({ file: FILE(), why: 'mcp.allowed does not list align-local' });
      userSettings({ mcp: { allowed: ['other', 'ALIGN-LOCAL'] } });
      expect(state().blocked).toBeUndefined();
      userSettings({ ui: {} });
      expect(state().blocked).toBeUndefined();
    });
    it('allowed lists intersect: one layer that omits it blocks it even if another lists it', () => {
      trustProj();
      userSettings({ mcp: { allowed: ['align-local'] } });
      workspace({ mcp: { allowed: ['x'] } });
      expect(state().blocked?.file).toBe(wsFile());
    });
    it('admin.mcp.enabled=false blocks every MCP server', () => {
      userSettings({ admin: { mcp: { enabled: false } } });
      expect(state().blocked).toEqual({ file: FILE(), why: 'admin.mcp.enabled is false' });
    });
    it('an excluded entry in a system file Gemini rejects is ignored', () => {
      writeFileSync(sysFile(), JSON.stringify({ mcp: { excluded: ['align-local'] } }));
      expect(state().blocked).toBeUndefined();
      expect(state({ systemLoads: true }).blocked?.file).toBe(sysFile());
    });
    it('--allowed-mcp-server-names in the passthrough without align-local blocks it; with it, not', () => {
      const s = (pt: string[]) => readGeminiState(proj, home, { localIsDefault: false }, sysEnv(), 'linux', () => 'x', pt);
      expect(s(['--allowed-mcp-server-names', 'other']).blocked).toEqual({ file: '--allowed-mcp-server-names', why: 'it does not list align-local' });
      expect(s(['--allowed-mcp-server-names=other']).blocked?.file).toBe('--allowed-mcp-server-names');
      expect(s(['--allowed-mcp-server-names', 'other', 'align-local']).blocked).toBeUndefined();
      expect(s(['-p', 'hi']).blocked).toBeUndefined();
    });
  });

  it('carries the folder trust verdict', () => {
    expect(state().trust).toBe('untrusted');
    trustProj();
    expect(state().trust).toBe('trusted');
  });
});

describe('geminiSystemFileRejection: the rule Gemini 0.63.0 applies (isFileAndDirectorySecureSync)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'align-gemini-sys-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const nonRoot = process.getuid?.() !== 0 && process.platform !== 'win32';

  it.skipIf(!nonRoot)('rejects a file in a directory the user owns, which is where every launch cache lives (the regression)', () => {
    const f = path.join(root, 'gemini-system-settings-abc.json');
    writeFileSync(f, '{}');
    expect(geminiSystemFileRejection(f, 'linux')).toMatch(/not owned by root/);
  });

  it.skipIf(!nonRoot)('rejects a symlink to a file, whatever it points at, when the link sits in a user-owned tree', () => {
    const real = path.join(root, 'real.json');
    const link = path.join(root, 'link.json');
    writeFileSync(real, '{}');
    symlinkSync(real, link);
    expect(geminiSystemFileRejection(link, 'linux')).not.toBeNull();
  });

  it.skipIf(!nonRoot)('a missing file is not rejected: Gemini only checks a file that exists', () => {
    expect(geminiSystemFileRejection(path.join(root, 'absent.json'), 'linux')).toBeNull();
  });

  it.skipIf(!nonRoot)('a group- or other-writable mode is its own reason', () => {
    const f = path.join(root, 'w.json');
    writeFileSync(f, '{}');
    chmodSync(root, 0o777);
    expect(geminiSystemFileRejection(f, 'linux')).not.toBeNull();
  });

  it('is not judged on win32: Gemini checks ACLs through PowerShell, which align cannot repeat', () => {
    expect(geminiSystemFileRejection(path.join(root, 'x.json'), 'win32')).toBeNull();
  });

  it('the one real system file of a stock Linux machine passes when it is root-owned (positive control)', () => {
    // /etc/hosts is the standard root-owned, not group/other-writable file under a root-owned tree.
    if (process.platform === 'win32') return;
    expect(geminiSystemFileRejection('/etc/hosts', 'linux')).toBeNull();
  });
});
