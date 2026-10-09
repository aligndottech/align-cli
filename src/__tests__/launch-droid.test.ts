import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALIGN_NUDGE_START } from '../lib/agent-rules.js';
import { buildDroidLaunch, type DroidLaunchContext } from '../lib/launch/adapters/droid.js';
import { readDroidState } from '../lib/launch/droid-state.js';
import { pinPlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave B, Factory Droid (droid 0.237.0, sandbox-installed from npm with --ignore-scripts and run
 * as `droid --settings f mcp list`): `--settings` is a per-process runtime settings file whose
 * `mcp` key takes the mcp.json shape; Droid lists that server as [runtime] beside the user's own,
 * and the runtime one wins a same-named user or project server. So Droid goes per session.
 */
pinPlatform('linux');
const LOCAL = { type: 'stdio', command: 'align', args: ['mcp', '--env', 'local'] };
const BASE: DroidLaunchContext = { passthrough: [], cachePath: (n) => `/cache/${n}`, present: false, overridden: [], projectHasBlock: false };
const ctx = (over: Partial<DroidLaunchContext> = {}): DroidLaunchContext => ({ ...BASE, ...over });
const settingsOf = (spec: ReturnType<typeof buildDroidLaunch>) => JSON.parse(spec.files.find((f) => f.name === 'droid-settings.json')?.content ?? 'null');

describe('buildDroidLaunch', () => {
  it('puts --settings (align-local under mcp.mcpServers) and the instructions file FIRST, the user\'s args after', () => {
    const spec = buildDroidLaunch(ctx({ passthrough: ['exec', 'fix it'] }));
    expect(spec.bin).toBe('droid');
    expect(spec.args).toEqual(['--settings', '/cache/droid-settings.json', '--append-system-prompt-file', '/cache/align-instructions.md', 'exec', 'fix it']);
    expect(settingsOf(spec)).toEqual({ mcp: { mcpServers: { 'align-local': LOCAL } } });
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('our flags never land after a user\'s --', () => {
    const args = buildDroidLaunch(ctx({ passthrough: ['--', '--settings'] })).args;
    expect(args.indexOf('--settings')).toBe(0);
    expect(args.slice(-2)).toEqual(['--', '--settings']);
  });

  it('the user\'s own local align in ~/.factory: no --settings (two servers on one graph); the instructions still go in', () => {
    const spec = buildDroidLaunch(ctx({ present: true }));
    expect(spec.args).toEqual(['--append-system-prompt-file', '/cache/align-instructions.md']);
    expect(settingsOf(spec)).toBeNull();
  });

  it('a non-canonical align-local elsewhere is replaced by the runtime one, naming the file', () => {
    const spec = buildDroidLaunch(ctx({ present: true, overridden: ['/r/.factory/mcp.json'] }));
    expect(spec.args.slice(0, 2)).toEqual(['--settings', '/cache/droid-settings.json']);
    expect(spec.notes).toEqual(["Droid will use Align's own align-local MCP server this session, not the one in /r/.factory/mcp.json."]);
  });

  it('the user\'s own runtime settings are kept: no second --settings, one line naming theirs', () => {
    const spec = buildDroidLaunch(ctx({ ownSettings: '/me/s.json', passthrough: ['--settings', '/me/s.json'] }));
    expect(spec.args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(spec.notes).toEqual(['Droid is using your own runtime settings (/me/s.json), so Align did not add its graph tools to this session.']);
  });

  it('an AGENTS.md already carrying the block: no instructions file; without it, one', () => {
    expect(buildDroidLaunch(ctx({ projectHasBlock: true })).args).not.toContain('--append-system-prompt-file');
    expect(buildDroidLaunch(ctx({ projectHasBlock: false })).args).toContain('--append-system-prompt-file');
  });

  it('never passes an autonomy flag for the user', () => {
    expect(buildDroidLaunch(ctx()).args.join(' ')).not.toMatch(/--auto|skip-permissions/);
  });

  it('on win32 the entry goes through cmd /c', () => {
    setPlatform('win32');
    expect(settingsOf(buildDroidLaunch(ctx())).mcp.mcpServers['align-local']).toEqual({ type: 'stdio', command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });
});

describe('readDroidState (sandbox files)', () => {
  let root: string, home: string, proj: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-droid-state-')));
    home = path.join(root, 'home');
    proj = path.join(root, 'repo', 'sub');
    mkdirSync(path.join(home, '.factory'), { recursive: true });
    mkdirSync(proj, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const state = (o: { env?: Record<string, string>; passthrough?: string[]; localIsDefault?: boolean } = {}) =>
    readDroidState(proj, home, { localIsDefault: o.localIsDefault ?? false }, o.env ?? {}, 'linux', o.passthrough ?? []);
  const user = (v: unknown) => writeFileSync(path.join(home, '.factory', 'mcp.json'), JSON.stringify(v));
  const project = (dir: string, v: unknown) => { mkdirSync(path.join(dir, '.factory'), { recursive: true }); writeFileSync(path.join(dir, '.factory', 'mcp.json'), JSON.stringify(v)); };
  const CANON = { type: 'stdio', command: 'align', args: ['mcp', '--env', 'local'] };

  it('the user\'s canonical align (with or without type: stdio) is present; another graph or disabled is not', () => {
    user({ mcpServers: { align: CANON } });
    expect(state().present).toBe(true);
    user({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'local'] } } });
    expect(state().present).toBe(true);
    user({ mcpServers: { align: { ...CANON, disabled: true } } });
    expect(state().present).toBe(false);
    user({ mcpServers: { align: { ...CANON, args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
  });

  it('a repo\'s canonical align never stands in for us', () => {
    project(path.join(root, 'repo'), { mcpServers: { align: CANON } });
    expect(state().present).toBe(false);
  });

  it('a hostile align-local in a project file up the tree, or in the user file, is listed as overridden', () => {
    project(path.join(root, 'repo'), { mcpServers: { 'align-local': { ...CANON, env: { PATH: '/evil' } } } });
    expect(state().overridden).toEqual([path.join(root, 'repo', '.factory', 'mcp.json')]);
    user({ mcpServers: { 'align-local': { command: 'evil' } } });
    expect(state().overridden).toEqual([path.join(home, '.factory', 'mcp.json'), path.join(root, 'repo', '.factory', 'mcp.json')]);
  });

  it('the user\'s own runtime settings: --settings x, --settings=x, or FACTORY_RUNTIME_SETTINGS_PATH; not after --', () => {
    expect(state({ passthrough: ['--settings', '/a.json'] }).ownSettings).toBe('/a.json');
    expect(state({ passthrough: ['--settings=/b.json', 'exec'] }).ownSettings).toBe('/b.json');
    expect(state({ env: { FACTORY_RUNTIME_SETTINGS_PATH: '/c.json' } }).ownSettings).toBe('/c.json');
    expect(state({ passthrough: ['--', '--settings', '/d.json'] }).ownSettings).toBeUndefined();
    expect(state().ownSettings).toBeUndefined();
  });

  it('the block in an AGENTS.md up the tree, or in ~/.factory/AGENTS.md, counts; a plain AGENTS.md does not', () => {
    writeFileSync(path.join(root, 'repo', 'AGENTS.md'), '# repo\n');
    expect(state().projectHasBlock).toBe(false);
    writeFileSync(path.join(root, 'repo', 'AGENTS.md'), `# repo\n${ALIGN_NUDGE_START}\n`);
    expect(state().projectHasBlock).toBe(true);
    rmSync(path.join(root, 'repo', 'AGENTS.md'));
    writeFileSync(path.join(home, '.factory', 'AGENTS.md'), `${ALIGN_NUDGE_START}\n`);
    expect(state().projectHasBlock).toBe(true);
  });
});
