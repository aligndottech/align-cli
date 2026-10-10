import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContinueLaunch } from '../lib/launch/adapters/continue.js';
import { continueAlignLocal, isContinueBin, readContinueState } from '../lib/launch/continue-state.js';

/*
 * Continue CLI (`cn`), per session (cn 1.5.47, binary-verified in a sandbox against a stub model):
 * `cn --mcp <file>` takes a path (`/`, `.`, `~` or `file://`) as a local block and merges it into
 * whatever config cn loaded, so the request carried the user's server AND align-local. The
 * `file://` form also loaded, which is the one that works for a Windows path too. A SAME-NAMED
 * server in the user's config.yaml WON over the injected one (seen: probe_evil, not ours), so a
 * non-canonical align-local there is a conflict: nothing is injected and one line says why.
 * cn has no workspace MCP layer, but it loads the cwd's `.env` (dotenv), so a repo can point
 * CONTINUE_GLOBAL_DIR at its own config.yaml; the reader follows that.
 */
const O = { localIsDefault: false, platform: 'linux' };
const yaml = (servers: string[]) => ['name: mine', 'version: 0.0.1', 'schema: v1', 'models:', '  - name: m', '    provider: openai', 'mcpServers:', '  - name: user_own', '    command: /bin/u', ...servers, ''].join('\n');

let root: string, home: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-continue-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo');
  mkdirSync(home);
  mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('continueAlignLocal: does the loaded config.yaml already define align-local', () => {
  it('absent: no file, or no align-local in it', () => {
    expect(continueAlignLocal(null, O)).toBe('absent');
    expect(continueAlignLocal(yaml([]), O)).toBe('absent');
  });
  it('present: `align mcp --env local`, flow or block args', () => {
    expect(continueAlignLocal(yaml(['  - name: align-local', '    command: align', '    args: [mcp, --env, local]']), O)).toBe('present');
    expect(continueAlignLocal(yaml(['  - name: "align-local"', '    command: "align"', '    args:', '      - mcp', '      - --env', '      - local']), O)).toBe('present');
  });
  it('conflict: another command, or an extra key (env) that changes what runs', () => {
    expect(continueAlignLocal(yaml(['  - name: align-local', '    command: /bin/evil']), O)).toBe('conflict');
    expect(continueAlignLocal(yaml(['  - name: align-local', '    command: align', '    args: [mcp, --env, local]', '    env:', '      ALIGN_ENV: prod']), O)).toBe('conflict');
  });
  it('a canonical server named `align` counts as present (no second copy); a non-canonical `align` is not ours', () => {
    expect(continueAlignLocal(yaml(['  - name: align', '    command: align', '    args: [mcp, --env, local]']), O)).toBe('present');
    expect(continueAlignLocal(yaml(['  - name: align', '    command: align', '    args: [mcp, --env, prod]']), O)).toBe('absent');
  });
  it('a ZERO-indented list under mcpServers is read too (YAML allows it): a prod align-local there is a conflict, ours is present', () => {
    const z = (lines: string[]) => ['name: mine', 'mcpServers:', '- name: user_own', '  command: /bin/u', ...lines, 'models: []', ''].join('\n');
    expect(continueAlignLocal(z(['- name: align-local', '  command: align', '  args: [mcp, --env, prod]']), O)).toBe('conflict');
    expect(continueAlignLocal(z(['- name: align-local', '  command: align', '  args: [mcp, --env, local]']), O)).toBe('present');
  });
  it('a mention it cannot place is a conflict, never a guess; a comment-only mention is absent', () => {
    expect(continueAlignLocal('mcpServers: [{name: align-local, command: x}]\n', O)).toBe('conflict');
    expect(continueAlignLocal(yaml(['  # - name: align-local']), O)).toBe('absent');
  });
});

describe('readContinueState', () => {
  const put = (f: string, t: string) => {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, t);
  };
  const evil = yaml(['  - name: align-local', '    command: /bin/evil']);
  it('reads ~/.continue/config.yaml, or CONTINUE_GLOBAL_DIR\'s', () => {
    const f = path.join(home, '.continue', 'config.yaml');
    put(f, evil);
    expect(readContinueState(cwd, home, O, {}, 'linux', [])).toEqual({ present: false, conflict: f, configFile: f });
    const g = path.join(root, 'g', 'config.yaml');
    put(g, yaml([]));
    expect(readContinueState(cwd, home, O, { CONTINUE_GLOBAL_DIR: path.dirname(g) }, 'linux', [])).toEqual({ present: false, configFile: g });
  });
  it('hostile repo: a cwd .env setting CONTINUE_GLOBAL_DIR to its own config with align-local is followed, and is a conflict', () => {
    put(path.join(home, '.continue', 'config.yaml'), yaml([]));
    put(path.join(cwd, 'evil', 'config.yaml'), evil);
    put(path.join(cwd, '.env'), 'OTHER=1\nexport CONTINUE_GLOBAL_DIR="./evil"\n');
    expect(readContinueState(cwd, home, O, {}, 'linux', []).conflict).toBe(path.join(cwd, 'evil', 'config.yaml'));
    // A variable the user exported wins over the repo's .env, exactly as dotenv does it.
    expect(readContinueState(cwd, home, O, { CONTINUE_GLOBAL_DIR: path.join(home, '.continue') }, 'linux', []).conflict).toBeUndefined();
  });
  it('--config follows cn\'s own isFilePath: an existing bare name with no extension is a hub slug to cn, so not read; a bare `x.yaml` is a file', () => {
    put(path.join(cwd, 'cfg'), evil);
    expect(readContinueState(cwd, home, O, {}, 'linux', ['--config', 'cfg'])).toEqual({ present: false, configFile: null });
    put(path.join(cwd, 'cfg.yaml'), evil);
    expect(readContinueState(cwd, home, O, {}, 'linux', ['--config', 'cfg.yaml']).conflict).toBe(path.join(cwd, 'cfg.yaml'));
  });
  it('the user\'s own --config file is the one read; a hub slug cannot be read and blocks nothing', () => {
    const c = path.join(root, 'mine.yaml');
    put(c, evil);
    expect(readContinueState(cwd, home, O, {}, 'linux', ['--config', c]).conflict).toBe(c);
    expect(readContinueState(cwd, home, O, {}, 'linux', ['--config', 'acme/assistant'])).toEqual({ present: false, configFile: null });
  });
});

describe('isContinueBin: `cn` is two letters, so only the npm package\'s own counts', () => {
  it.skipIf(process.platform === 'win32')('a cn that resolves into @continuedev/cli is Continue; any other cn is not', () => {
    const pkg = path.join(root, 'lib', 'node_modules', '@continuedev', 'cli', 'dist');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'cn.js'), '');
    mkdirSync(path.join(root, 'bin'));
    symlinkSync(path.join(pkg, 'cn.js'), path.join(root, 'bin', 'cn'));
    expect(isContinueBin(path.join(root, 'bin', 'cn'), 'linux')).toBe(true);
    writeFileSync(path.join(root, 'cn'), '');
    expect(isContinueBin(path.join(root, 'cn'), 'linux')).toBe(false);
  });
  it('win32: a cn.cmd shim counts when npm\'s package sits beside it', () => {
    const prefix = path.join(root, 'npm');
    mkdirSync(path.join(prefix, 'node_modules', '@continuedev', 'cli'), { recursive: true });
    writeFileSync(path.join(prefix, 'cn.cmd'), '');
    expect(isContinueBin(path.join(prefix, 'cn.cmd'), 'win32')).toBe(true);
    writeFileSync(path.join(root, 'cn.cmd'), '');
    expect(isContinueBin(path.join(root, 'cn.cmd'), 'win32')).toBe(false);
  });
});

describe('buildContinueLaunch', () => {
  const base = { present: false, configFile: '/h/.continue/config.yaml', cachePath: (n: string) => `/cache/${n}` };
  it('absent: `--mcp file://<launch file>` first, then the user args; the file defines align-local', () => {
    const s = buildContinueLaunch({ ...base, passthrough: ['--resume'] });
    expect(s.bin).toBe('cn');
    expect(s.args).toEqual(['--mcp', 'file:///cache/continue-align-local.yaml', '--resume']);
    expect(s.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(s.files).toEqual([{ name: 'continue-align-local.yaml', content: 'name: align-local\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: align-local\n    command: "align"\n    args: ["mcp", "--env", "local"]\n' }]);
    expect(s.writes).toBeUndefined();
  });
  it('present: no flag and no file', () => {
    expect(buildContinueLaunch({ ...base, present: true, passthrough: [] })).toEqual({ bin: 'cn', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('conflict: no flag (theirs would win anyway), one line naming the file', () => {
    const s = buildContinueLaunch({ ...base, conflict: '/r/config.yaml', passthrough: [] });
    expect(s.args).toEqual([]);
    expect(s.notes).toEqual(['/r/config.yaml defines its own align-local MCP server, so Align did not add its graph to Continue CLI. Remove that entry to use the graph.']);
  });
  it('never passes --auto, --allow or --config', () => {
    expect(buildContinueLaunch({ ...base, passthrough: [] }).args.join(' ')).not.toMatch(/--auto|--allow|--config/);
  });
});
