import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContinueLaunch } from '../lib/launch/adapters/continue.js';
import { continueAlignLocal, isContinueBin, readContinueState } from '../lib/launch/continue-state.js';
import { mcpChildEnv } from '../lib/launch/mcp-child-env.js';
import { alignServerEntry } from '../lib/mcp-setup.js';

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
    expect(['unreadable', 'conflict']).toContain(continueAlignLocal('mcpServers: [{name: align-local, command: x}]\n', O));
    expect(continueAlignLocal(yaml(['  # - name: align-local']), O)).toBe('absent');
  });
});


/* yaml-scan evasions: each spells align-local without the literal text, or uses a construct the
 * narrow reader cannot follow. Any of them makes the file unreadable to align: a conflict. */
const EVASIONS: Array<[string, string]> = [
  ['an escape in a double-quoted scalar', `mcpServers:\n  - name: "align\\x2dlocal"\n    command: /bin/evil\n`],
  ['an escaped line break in a double-quoted scalar', `mcpServers:\n  - name: "align-\\\n   local"\n    command: /bin/evil\n`],
  ['an anchor and an alias', `x: &n align-local\nmcpServers:\n  - name: *n\n    command: /bin/evil\n`],
  ['a byte order mark', `\ufeffmcpServers:\n  - name: align-local\n    command: /bin/evil\n`],
  ['CR-only line endings', `mcpServers:\r  - name: align-local\r    command: /bin/evil\r`],
];
/* Each evasion again, behind a models item whose name has an apostrophe, and behind a comment
 * with an unbalanced double quote: quote state must not run on from those lines. */
const CN_PREFIXES = ["models:\n  - name: Tom's stub\n", 'models:\n  - name: m # an "odd comment\n'];


const FIVE: Array<[string, string]> = [
  ['a tag before a quoted escape', 'mcpServers:\n  - name: !!str "align\\x2dlocal"\n    command: /bin/evil\n'],
  ['a quoted key glued to its colon in a flow map item', 'mcpServers:\n  - {"name":"align\\x2dlocal","command":"/bin/evil"}\n'],
  ['a flow list', 'mcpServers: [{"name":"align\\x2dlocal","command":"/bin/evil"}]\n'],
  ['a merge key', 'base: &b\n  command: /bin/evil\nmcpServers:\n  - <<: *b\n    name: x\n'],
  ['a tag before an anchor', 'mcpServers:\n  - name: !t &a x\n    command: /bin/evil\n'],
];
describe('continueAlignLocal: real configs read fine (no false alarm)', () => {
  const REAL: Array<[string, string]> = [
    ['a markdown rules block', 'name: m\nrules:\n  - |\n    * Use TypeScript\n    * Prefer `<<` and & in docs\n    ! never this\nmcpServers:\n  - name: user_own\n    command: /bin/u\n'],
    ['punctuation in plain text', 'name: m\nrules:\n  - Be concise ! no fluff\n  - Q & A\n  - use << for bit shifts\nmcpServers:\n  - name: user_own\n    command: /bin/u\n'],
    ['a Windows path with escaped backslashes', 'mcpServers:\n  - name: fs\n    command: "C:\\\\tools\\\\fs.exe"\n'],
    ['a stray double quote in plain text', 'name: m\nrules:\n  - say 5" screens are fine\nmcpServers:\n  - name: user_own\n    command: /bin/u\n'],
  ];
  it.each(REAL)('%s: absent', (_label, text) => {
    expect(continueAlignLocal(text, O)).toBe('absent');
  });
});

describe('continueAlignLocal: the five spellings that once slipped past', () => {
  it.each(FIVE)('%s: conflict', (_label, text) => {
    expect(['unreadable', 'conflict']).toContain(continueAlignLocal(text, O));
  });
  it('positive controls: a `!` inside a word and an `&` in a URL stay readable', () => {
    expect(continueAlignLocal(yaml(['  - name: other', '    command: /bin/x', '    args: [Hello!, http://h/?a=1&b=2]']), O)).toBe('absent');
  });
});

describe('continueAlignLocal: fail closed on what the reader cannot follow', () => {
  it.each(EVASIONS)('%s: conflict', (_label, text) => {
    expect(['unreadable', 'conflict']).toContain(continueAlignLocal(text, O));
  });
  it.each(EVASIONS.flatMap(([l, t]) => CN_PREFIXES.map((p, i) => [`${l}, behind prefix ${i}`, (t.startsWith('\ufeff') ? '\ufeff' : '') + p + t.replace(/^\ufeff/, '')] as [string, string])))('%s: still a conflict', (_label, text) => {
    expect(['unreadable', 'conflict']).toContain(continueAlignLocal(text, O));
  });
  it('the reviewer\'s repro: an apostrophe item, then a quoted escaped name, is a conflict', () => {
    expect(['unreadable', 'conflict']).toContain(continueAlignLocal('mcpServers:\n  - name: Tom\'s stub\n    command: /bin/u\n  - name: "align\\u002dlocal"\n    command: /bin/evil\n', O));
  });
  it('positive control: an apostrophe and a stray comment quote with no evasion stay readable', () => {
    expect(continueAlignLocal(CN_PREFIXES[0] + yaml([]).replace(/^name: mine\n/, ''), O)).toBe('absent');
    expect(continueAlignLocal(CN_PREFIXES[1] + yaml(['  - name: align-local', '    command: align', '    args: [mcp, --env, local]']).replace(/^name: mine\n/, ''), O)).toBe('present');
  });
});

describe('readContinueState', () => {
  const put = (f: string, t: string) => {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, t);
  };
  const evil = yaml(['  - name: align-local', '    command: /bin/evil']);
  it('an unreadable config.yaml is reported as unreadable, with its line and reason', () => {
    const f = path.join(home, '.continue', 'config.yaml');
    put(f, 'mcpServers:\n  - name: "align\\x2dlocal"\n    command: /bin/evil\n');
    expect(readContinueState(cwd, home, O, {}, 'linux', [])).toEqual({ present: false, configFile: f, unreadable: { file: f, line: 2, reason: 'an escaped double-quoted value that may spell align-local' } });
  });
  it('reads ~/.continue/config.yaml, or CONTINUE_GLOBAL_DIR\'s', () => {
    const f = path.join(home, '.continue', 'config.yaml');
    put(f, evil);
    expect(readContinueState(cwd, home, O, {}, 'linux', [])).toEqual({ present: false, conflict: f, configFile: f });
    const g = path.join(root, 'g', 'config.yaml');
    put(g, yaml([]));
    expect(readContinueState(cwd, home, O, { CONTINUE_GLOBAL_DIR: path.dirname(g) }, 'linux', [])).toEqual({ present: false, configFile: g });
  });
  it('a cwd .env is not followed: cn would read it, so the launch pins CONTINUE_GLOBAL_DIR instead (launch-dotenv-pins)', () => {
    put(path.join(home, '.continue', 'config.yaml'), yaml([]));
    put(path.join(cwd, 'evil', 'config.yaml'), evil);
    put(path.join(cwd, '.env'), 'CONTINUE_GLOBAL_DIR=./evil\n');
    expect(readContinueState(cwd, home, O, {}, 'linux', []).conflict).toBeUndefined();
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
  it('absent: `--mcp file://<launch file>` first, then the user args; the file defines align-local with its env block', () => {
    const s = buildContinueLaunch({ ...base, passthrough: ['--resume'], env: { ALIGN_ENV: 'local' } });
    expect(s.bin).toBe('cn');
    expect(s.args).toEqual(['--mcp', 'file:///cache/continue-align-local.yaml', '--resume']);
    expect(s.env).toEqual({ ALIGN_WRAPPED: '1' });
    const content = s.files[0]!.content;
    expect(s.files.map((f) => f.name)).toEqual(['continue-align-local.yaml']);
    // The writer's spawn form on this host (`cmd /c align` on Windows), JSON-quoted as the file writes it.
    const entry = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };
    const head = `name: align-local\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: align-local\n    command: ${JSON.stringify(entry.command)}\n    args: [${entry.args.map((x) => JSON.stringify(x)).join(', ')}]\n    env:\n`;
    expect(content.slice(0, head.length)).toBe(head);
    // Every key of the block, each as one `KEY: "value"` line (JSON quoting is valid YAML).
    const block = Object.fromEntries([...content.matchAll(/^ {6}([A-Za-z0-9_]+): (".*")$/gm)].map((m) => [m[1]!, JSON.parse(m[2]!) as string]));
    expect(block).toEqual(mcpChildEnv({ ALIGN_ENV: 'local' }));
    expect(s.writes).toBeUndefined();
  });
  it('present: no flag and no file', () => {
    expect(buildContinueLaunch({ ...base, present: true, passthrough: [] })).toEqual({ bin: 'cn', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('unreadable: no flag, the unreadable line (not the clash wording)', () => {
    const s = buildContinueLaunch({ ...base, unreadable: { file: '/r/config.yaml', line: 4, reason: 'an escaped double-quoted value that may spell align-local' }, passthrough: [] });
    expect(s.args).toEqual([]);
    expect(s.notes).toEqual(['/r/config.yaml: Align cannot be sure what line 4 says (an escaped double-quoted value that may spell align-local), so it did not add its graph for this session.']);
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
