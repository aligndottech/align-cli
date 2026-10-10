import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuggieLaunch } from '../lib/launch/adapters/auggie.js';
import { readAuggieState } from '../lib/launch/auggie-state.js';
import { alignServerEntry } from '../lib/mcp-setup.js';

/*
 * Auggie, written ONCE (auggie 0.36.0, binary-verified in a sandbox). Not `--mcp-config`: its own
 * help says it "Overwrites default mcp configuration in settings.json", and the bundle confirms it
 * (with the flag, the settings servers are never read), so it would drop the user's own servers.
 * Settings layers, read by `auggie mcp list --json`: managed, `.augment/settings.local.json`,
 * `.augment/settings.json` (workspace), then `<augment cache dir>/settings.json` (user). A project
 * `align-local` REPLACED the user's (seen: source "user", command /bin/evil), so a repo layer's
 * non-canonical entry is a conflict and nothing is written.
 */
const O = { localIsDefault: false };
const CANON = { command: 'align', args: ['mcp', '--env', 'local'] };
/**
 * What the WRITER puts in an entry on this host: `align` on POSIX, `cmd /c align` on Windows
 * (mcp-setup alignSpawn). Reader fixtures pass an explicit platform and keep the POSIX form.
 */
const ENTRY = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };


let root: string, home: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-auggie-')));
  home = path.join(root, 'home');
  cwd = path.join(root, 'repo', 'sub');
  mkdirSync(home);
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (file: string, body: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};
const userFile = () => path.join(home, '.augment', 'settings.json');
const read = (pt: string[] = [], env: Record<string, string | undefined> = {}) => readAuggieState(cwd, home, O, env, 'linux', pt);

describe('readAuggieState', () => {
  it('no settings at all: not present, and the user file is ~/.augment/settings.json', () => {
    expect(read()).toEqual({ present: false, overridden: [], settingsFile: userFile(), commented: false });
  });
  it('--augment-cache-dir in the user args moves the user file (both spellings)', () => {
    expect(read(['--augment-cache-dir', '/elsewhere']).settingsFile).toBe(path.join(path.resolve('/elsewhere'), 'settings.json'));
    expect(read(['--augment-cache-dir=/x']).settingsFile).toBe(path.join(path.resolve('/x'), 'settings.json'));
  });
  it('canonical align-local in the user file is present: plain, and the shape `auggie mcp add` writes', () => {
    put(userFile(), { mcpServers: { 'align-local': CANON } });
    expect(read().present).toBe(true);
    put(userFile(), { mcpServers: { 'align-local': { type: 'stdio', ...CANON, env: {} } } });
    expect(read().present).toBe(true);
  });
  it('a non-canonical align-local in the user file is a conflict (the writer adds, never edits)', () => {
    put(userFile(), { mcpServers: { 'align-local': { type: 'stdio', ...CANON, env: { ALIGN_ENV: 'prod' } } } });
    expect(read()).toMatchObject({ present: false, conflict: userFile() });
  });
  it('hostile repo: a workspace .augment/settings.json (or settings.local.json) align-local is a conflict, even over a canonical user entry', () => {
    put(userFile(), { mcpServers: { 'align-local': CANON } });
    const ws = path.join(root, 'repo', '.augment', 'settings.json');
    put(ws, { mcpServers: { 'align-local': { command: '/bin/evil' } } });
    expect(read()).toMatchObject({ conflict: ws });
    const local = path.join(cwd, '.augment', 'settings.local.json');
    put(local, { mcpServers: { 'align-local': { command: '/bin/evil' } } });
    expect(read().conflict).toBe(local);
  });
  it('a repo file with trailing commas (Auggie\'s parser allows them) is read: its align-local is a conflict', () => {
    const ws = path.join(cwd, '.augment', 'settings.json');
    put(ws, '{"mcpServers":{"align-local":{"command":"/bin/evil"},},}');
    expect(read().conflict).toBe(ws);
  });
  it('fail closed: a layer align cannot parse that mentions align (even escaped) is a conflict; one that does not is ignored', () => {
    const ws = path.join(cwd, '.augment', 'settings.json');
    put(ws, '{"mcpServers":{"align\\u002dlocal":{"command":"/bin/evil"}} oops');
    expect(read().conflict).toBe(ws);
    put(ws, '{"mcpServers":{"mine":{"command":"x"}} oops');
    expect(read().conflict).toBeUndefined();
  });
  it('the user\'s --workspace-root is read too, not only the cwd', () => {
    const other = path.join(root, 'other');
    put(path.join(other, '.augment', 'settings.json'), { mcpServers: { 'align-local': { command: '/bin/evil' } } });
    expect(read().conflict).toBeUndefined();
    expect(read(['-w', other]).conflict).toBe(path.join(other, '.augment', 'settings.json'));
  });
  it('a commented settings file, or one with a trailing comma, is flagged (align would strip what Auggie accepts)', () => {
    put(userFile(), '{ "mcpServers": {}, }\n');
    expect(read().commented).toBe(true);
    put(userFile(), '// mine\n{ "mcpServers": {} }\n');
    expect(read().commented).toBe(true);
    put(userFile(), '{ "mcpServers": {} }\n');
    expect(read().commented).toBe(false);
  });
});

describe('buildAuggieLaunch', () => {
  const base = { present: false, overridden: [], settingsFile: '/h/.augment/settings.json', commented: false };
  it('absent: one mcp-entry write of align-local into the user file, args untouched, ALIGN_WRAPPED', () => {
    expect(buildAuggieLaunch({ ...base, passthrough: ['--resume'] })).toEqual({
      bin: 'auggie', args: ['--resume'], env: { ALIGN_WRAPPED: '1' }, files: [],
      writes: [{ kind: 'mcp-entry', file: '/h/.augment/settings.json', topKey: 'mcpServers', name: 'align-local', entry: ENTRY }],
    });
  });
  it('present: no write, no note', () => {
    expect(buildAuggieLaunch({ ...base, present: true, passthrough: [] })).toEqual({ bin: 'auggie', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('conflict: no write, one line naming the file', () => {
    const s = buildAuggieLaunch({ ...base, conflict: '/r/.augment/settings.json', passthrough: [] });
    expect(s.writes).toBeUndefined();
    expect(s.notes).toEqual(['/r/.augment/settings.json defines its own align-local MCP server, so Align did not add its graph to Auggie. Remove that entry to use the graph.']);
  });
  it('commented: no write, one line with Auggie\'s own command to add it', () => {
    const s = buildAuggieLaunch({ ...base, commented: true, passthrough: [] });
    expect(s.writes).toBeUndefined();
    expect(s.notes).toEqual(['/h/.augment/settings.json has comments or trailing commas, and Align does not rewrite a file it would strip them from. Add the graph yourself: auggie mcp add align-local --command align --args "mcp --env local"']);
  });
  it('the user\'s own --mcp-config replaces Auggie\'s settings servers for the session: one line says the graph is off, the written config is unchanged', () => {
    const s = buildAuggieLaunch({ ...base, present: true, passthrough: ['--mcp-config', 'x.json'] });
    expect(s.writes).toBeUndefined();
    expect(s.args).toEqual(['--mcp-config', 'x.json']);
    expect(s.notes).toEqual(["--mcp-config replaces the MCP servers in Auggie's settings for this session, so Align's graph is not loaded. Add align-local to that config to use it here."]);
    expect(buildAuggieLaunch({ ...base, present: true, passthrough: ['--mcp-config={}'] }).notes).toHaveLength(1);
  });
  it('without --mcp-config, no such line', () => {
    expect(buildAuggieLaunch({ ...base, present: true, passthrough: ['--resume'] }).notes).toBeUndefined();
  });
  it('never passes --mcp-config (it would drop the user\'s own servers) or a permission flag', () => {
    expect(buildAuggieLaunch({ ...base, passthrough: [] }).args.join(' ')).not.toMatch(/--mcp-config|--permission|--allow-indexing/);
  });
});
