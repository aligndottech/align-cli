import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { removeUserHooks, type UserHookTarget, writeUserHooks } from '../lib/user-hooks.js';

/**
 * ALI-952: the deterministic guardrail reached Claude Code, pi, Gemini CLI and OpenCode only.
 * Codex, Cursor and Copilot CLI each document a pre-tool hook that runs from a USER-level
 * file with no trust prompt (~/.codex/hooks.json, ~/.cursor/hooks.json, ~/.copilot/hooks/).
 * These writers put `align check --advisory --format <host>` there, next to the MCP entry
 * setup already writes for the same host.
 *
 * A user-level hooks file is shared with everything else the user runs, so the contract
 * is the one mcp-setup.ts already keeps for MCP configs: MERGE, never overwrite; a second
 * run adds nothing; --remove takes out exactly what we wrote and nothing else. Every field
 * name below is from the host's published hook schema (docs/agent-hooks.md cites them).
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'align-user-hooks-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const readJson = (rel: string): any => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const target = (host: UserHookTarget['host'], rel: string): UserHookTarget => ({ host, path: join(dir, rel) });

describe('writeUserHooks - Codex (~/.codex/hooks.json, PreToolUse)', () => {
  it('writes a PreToolUse group on the file-editing tools, calling the advisory check in codex format', () => {
    writeUserHooks(target('codex', '.codex/hooks.json'));
    const groups = readJson('.codex/hooks.json').hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    // Codex matches on tool_name; file edits go through apply_patch, for which the docs
    // also accept the Edit|Write aliases.
    expect(groups[0].matcher).toContain('apply_patch');
    expect(groups[0].hooks[0]).toMatchObject({ type: 'command', command: 'align check --advisory --format codex' });
    expect(groups[0].hooks[0].timeout).toBeLessThanOrEqual(10);
  });

  it('encodes a non-prod env into the command, and omits the default', () => {
    writeUserHooks(target('codex', 'a.json'), 'local');
    expect(readJson('a.json').hooks.PreToolUse[0].hooks[0].command).toBe('align check --advisory --format codex --env local');
    writeUserHooks(target('codex', 'b.json'), 'prod');
    expect(readJson('b.json').hooks.PreToolUse[0].hooks[0].command).not.toContain('--env');
  });
});

describe('writeUserHooks - Cursor (~/.cursor/hooks.json, preToolUse + postToolUse)', () => {
  it('writes version 1 with a Write-matching entry on both events', () => {
    writeUserHooks(target('cursor', '.cursor/hooks.json'));
    const cfg = readJson('.cursor/hooks.json');
    expect(cfg.version).toBe(1);
    // preToolUse can only allow/deny, so the non-blocking finding rides postToolUse's
    // additional_context - the same split as Gemini CLI. Both events are needed.
    for (const event of ['preToolUse', 'postToolUse']) {
      expect(cfg.hooks[event]).toHaveLength(1);
      expect(cfg.hooks[event][0].matcher).toBe('Write');
      expect(cfg.hooks[event][0].command).toBe('align check --advisory --format cursor');
      expect(cfg.hooks[event][0].timeout).toBeLessThanOrEqual(10);
    }
  });
});

describe('writeUserHooks - Copilot CLI (~/.copilot/hooks/align.json, preToolUse + postToolUse)', () => {
  it('writes version 1 with a bash command on the file-editing tools, on both events', () => {
    writeUserHooks(target('copilot', '.copilot/hooks/align.json'));
    const cfg = readJson('.copilot/hooks/align.json');
    expect(cfg.version).toBe(1);
    for (const event of ['preToolUse', 'postToolUse']) {
      expect(cfg.hooks[event]).toHaveLength(1);
      const entry = cfg.hooks[event][0];
      expect(entry.type).toBe('command');
      expect(entry.bash).toContain('align check --advisory --format copilot');
      // Copilot's own names for its file-editing tools (hooks reference): edit,
      // str_replace_editor, apply_patch map to Edit; create maps to Write.
      for (const tool of ['edit', 'create', 'str_replace_editor', 'apply_patch']) expect(entry.matcher).toContain(tool);
      expect(entry.timeoutSec).toBeLessThanOrEqual(10);
    }
  });
});

// ALI-1749: Copilot CLI is the one host whose docs say a non-zero preToolUse exit DENIES the
// tool call, and this hook lives in the USER's home, so it fires in every project. With align
// uninstalled or off the hook shell's PATH the bare command exits 127, which would block every
// edit. The command must exit 0 when align is absent, and must not alter what a present align
// returns. Run the written string through bash, the shell Copilot's `bash` field names.
describe.skipIf(process.platform === 'win32')('Copilot hook command - align absent vs present', () => {
  const payload = '{"toolName":"edit","toolArgs":{"path":"a.txt"}}';
  function run(pathDirs: string[]): { status: number | null; stdout: string; stderr: string } {
    writeUserHooks(target('copilot', '.copilot/hooks/align.json'), 'local');
    const cfg = readJson('.copilot/hooks/align.json');
    const r = spawnSync('bash', ['-c', cfg.hooks.preToolUse[0].bash], {
      input: payload, encoding: 'utf8', env: { PATH: pathDirs.join(':') },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  function fakeAlign(body: string): string {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'align'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'align'), 0o755);
    return bin;
  }

  it('exits 0 and prints nothing when align is not on PATH', () => {
    const r = run(['/usr/bin', '/bin']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('hands the payload and arguments to a present align and returns its deny output untouched', () => {
    const bin = fakeAlign('cat >"$0.stdin"; echo "$@" >"$0.args"; echo \'{"permissionDecision":"deny"}\'');
    const r = run([bin, '/usr/bin', '/bin']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"permissionDecision":"deny"}');
    expect(readFileSync(join(bin, 'align.stdin'), 'utf8')).toBe(payload);
    expect(readFileSync(join(bin, 'align.args'), 'utf8').trim()).toBe('check --advisory --format copilot --env local');
  });

  it('migrates a hook file written with the old bare command, without calling it a user edit', () => {
    mkdirSync(join(dir, '.copilot/hooks'), { recursive: true });
    const old = { type: 'command', matcher: 'edit|str_replace_editor|apply_patch|create', bash: 'align check --advisory --format copilot', timeoutSec: 10 };
    writeFileSync(join(dir, '.copilot/hooks/align.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [old], postToolUse: [old] } }));
    const edited: string[] = [];
    writeUserHooks(target('copilot', '.copilot/hooks/align.json'), undefined, undefined, (f) => edited.push(f));
    expect(edited).toEqual([]);
    expect(readJson('.copilot/hooks/align.json').hooks.preToolUse[0].bash).toMatch(/^command -v align .*; align check --advisory --format copilot$/);
  });

  it('keeps a present align\'s non-zero exit (the guard only covers the absent case)', () => {
    const bin = fakeAlign('exit 3');
    expect(run([bin, '/usr/bin', '/bin']).status).toBe(3);
  });
});

// The merge contract, asserted on every host: the file is the user's, we own one entry in it.
describe.each([
  ['codex', 'PreToolUse', (e: any) => e.hooks?.[0]?.command] as const,
  ['cursor', 'preToolUse', (e: any) => e.command] as const,
  ['copilot', 'preToolUse', (e: any) => e.bash] as const,
])('writeUserHooks / removeUserHooks - %s merges and never overwrites', (host, event, commandOf) => {
  const theirs = host === 'copilot'
    ? { type: 'command', bash: './scripts/lint.sh', matcher: 'edit' }
    : host === 'cursor'
      ? { command: './hooks/format.sh', matcher: 'Write' }
      : { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/audit.py' }] };

  function seed(rel: string): void {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), JSON.stringify({ version: 1, hooks: { [event]: [theirs], sessionStart: [{ command: 'x' }] }, keep: true }));
  }

  it('keeps someone else\'s hook on the same event, and every other key in the file', () => {
    seed('h.json');
    writeUserHooks(target(host, 'h.json'), 'local');
    const cfg = readJson('h.json');
    expect(cfg.keep).toBe(true);
    expect(cfg.hooks.sessionStart).toEqual([{ command: 'x' }]);
    expect(cfg.hooks[event]).toHaveLength(2);
    expect(cfg.hooks[event][0]).toEqual(theirs);
    expect(commandOf(cfg.hooks[event][1])).toContain('align check --advisory');
  });

  it('is idempotent: a second run leaves exactly one align entry, and picks up an env change', () => {
    seed('h.json');
    writeUserHooks(target(host, 'h.json'), 'local');
    writeUserHooks(target(host, 'h.json'), 'preview');
    const list = readJson('h.json').hooks[event];
    expect(list).toHaveLength(2);
    expect(list.filter((e: unknown) => String(commandOf(e) ?? '').includes('align check'))).toHaveLength(1);
    expect(commandOf(list[1])).toContain('--env preview');
  });

  it('removes exactly what setup wrote and reports it', () => {
    seed('h.json');
    writeUserHooks(target(host, 'h.json'));
    expect(removeUserHooks(target(host, 'h.json'))).toBe(true);
    const cfg = readJson('h.json');
    expect(cfg.hooks[event]).toEqual([theirs]);
    expect(cfg.hooks.sessionStart).toEqual([{ command: 'x' }]);
    expect(cfg.keep).toBe(true);
  });

  it('deletes the file on remove when it held nothing but what setup wrote', () => {
    writeUserHooks(target(host, 'only-ours.json'));
    expect(existsSync(join(dir, 'only-ours.json'))).toBe(true);
    expect(removeUserHooks(target(host, 'only-ours.json'))).toBe(true);
    expect(existsSync(join(dir, 'only-ours.json'))).toBe(false);
  });

  it('reports false when there is nothing of ours to remove, and when the file is absent', () => {
    seed('h.json');
    expect(removeUserHooks(target(host, 'h.json'))).toBe(false);
    expect(readJson('h.json').hooks[event]).toEqual([theirs]);
    expect(removeUserHooks(target(host, 'nope.json'))).toBe(false);
  });

  it('throws rather than clobbering a file containing invalid JSON, on write and on remove', () => {
    writeFileSync(join(dir, 'bad.json'), 'not json{{{');
    expect(() => writeUserHooks(target(host, 'bad.json'))).toThrow('invalid JSON');
    expect(() => removeUserHooks(target(host, 'bad.json'))).toThrow('invalid JSON');
    expect(readFileSync(join(dir, 'bad.json'), 'utf8')).toBe('not json{{{');
  });

  // Parseable but the wrong shape (Copilot, #282). `"hooks": []` is valid JSON; setting an
  // event key on an array adds a non-index property that JSON.stringify drops, so the write
  // would "succeed" and produce a file with no hook in it - a no-op that reads as done.
  it.each([['[]'], ['"x"'], ['3']])('throws on a parseable "hooks": %s rather than writing a no-op file', (bad) => {
    const before = `{ "version": 1, "hooks": ${bad} }`;
    writeFileSync(join(dir, 'shape.json'), before);
    expect(() => writeUserHooks(target(host, 'shape.json'))).toThrow(/"hooks" is not an object/);
    expect(() => removeUserHooks(target(host, 'shape.json'))).toThrow(/"hooks" is not an object/);
    expect(readFileSync(join(dir, 'shape.json'), 'utf8')).toBe(before);
  });
});

// ALI-1476: an element carrying our command is ours to refresh only while it is exactly what
// we wrote. A user who added a nested command, or changed the timeout, inside it has edited it.
describe('writeUserHooks - a user edit inside our own element survives the next write', () => {
  it('Codex: keeps a group the user added a command to, once, and says so', () => {
    const file = '.codex/hooks.json';
    writeUserHooks(target('codex', file));
    const cfg = readJson(file);
    cfg.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'my-own-linter', timeout: 5 });
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(cfg));

    const edited: string[] = [];
    writeUserHooks(target('codex', file), undefined, undefined, (f) => edited.push(f));

    const groups = readJson(file).hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks.map((h: any) => h.command)).toEqual(['align check --advisory --format codex', 'my-own-linter']);
    expect(edited).toEqual([join(dir, file)]);
  });

  it('Cursor: keeps an entry whose timeout the user changed, on both events, and warns once', () => {
    const file = '.cursor/hooks.json';
    writeUserHooks(target('cursor', file));
    const cfg = readJson(file);
    for (const event of ['preToolUse', 'postToolUse']) cfg.hooks[event][0].timeout = 3;
    writeFileSync(join(dir, file), JSON.stringify(cfg));

    const edited: string[] = [];
    writeUserHooks(target('cursor', file), undefined, undefined, (f) => edited.push(f));

    for (const event of ['preToolUse', 'postToolUse']) {
      expect(readJson(file).hooks[event]).toHaveLength(1);
      expect(readJson(file).hooks[event][0].timeout).toBe(3);
    }
    expect(edited).toHaveLength(1);
  });

  it('Copilot: keeps an entry whose matcher the user narrowed, and warns once', () => {
    const file = '.copilot/hooks/align.json';
    writeUserHooks(target('copilot', file));
    const cfg = readJson(file);
    for (const event of ['preToolUse', 'postToolUse']) cfg.hooks[event][0].matcher = 'edit';
    writeFileSync(join(dir, file), JSON.stringify(cfg));

    const edited: string[] = [];
    writeUserHooks(target('copilot', file), undefined, undefined, (f) => edited.push(f));

    expect(readJson(file).hooks.preToolUse).toHaveLength(1);
    expect(readJson(file).hooks.preToolUse[0].matcher).toBe('edit');
    expect(edited).toHaveLength(1);
  });

  it('Cursor: an edit in ONE event keeps both, so the pair never checks two different envs', () => {
    const file = '.cursor/hooks.json';
    writeUserHooks(target('cursor', file));
    const cfg = readJson(file);
    cfg.hooks.preToolUse[0].timeout = 3;
    writeFileSync(join(dir, file), JSON.stringify(cfg));
    writeUserHooks(target('cursor', file), 'local');
    expect(readJson(file).hooks.postToolUse[0].command).toBe('align check --advisory --format cursor');
    expect(readJson(file).hooks.preToolUse[0].command).toBe('align check --advisory --format cursor');
  });

  it.each(['align check --advisory --format codex --verbose', 'FOO=1 align check --advisory --format codex'])(
    'Codex: a command the user edited (%s) is kept',
    (command) => {
      const file = 'c.json';
      writeUserHooks(target('codex', file));
      const cfg = readJson(file);
      cfg.hooks.PreToolUse[0].hooks[0].command = command;
      writeFileSync(join(dir, file), JSON.stringify(cfg));
      const edited: string[] = [];
      writeUserHooks(target('codex', file), undefined, undefined, (f) => edited.push(f));
      expect(readJson(file).hooks.PreToolUse).toHaveLength(1);
      expect(readJson(file).hooks.PreToolUse[0].hooks[0].command).toBe(command);
      expect(edited).toHaveLength(1);
    },
  );

  it('still refreshes an untouched element when the env changes, and does not warn', () => {
    const file = 'a.json';
    writeUserHooks(target('codex', file));
    const edited: string[] = [];
    writeUserHooks(target('codex', file), 'local', undefined, (f) => edited.push(f));
    const groups = readJson(file).hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe('align check --advisory --format codex --env local');
    expect(edited).toEqual([]);
  });
});
