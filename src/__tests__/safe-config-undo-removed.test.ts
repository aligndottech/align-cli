import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SUFFIX, mergeWrittenConfig, safeWriteJson, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { writeUserHooks } from '../lib/user-hooks.js';

/*
 * C4 Test List (align REMOVED or CHANGED something that was already there):
 *  1. an existing array align removed an element from (writeUserHooks strips a prior align hook) is ONE
 *     replaced unit; undo restores the original array exactly and keeps an unrelated user edit
 *  2. the user also edited that array: file untouched, named, backup kept
 *  3. an older-format align hook replaced by an upgrade comes back
 *  4. pure additions to an array stay element-wise (user's elements and later edits untouched)
 *  5. an existing key align took away (removed unit) comes back; edited-since is left
 *  6. property: random pre-existing configs, an align write, an unrelated user edit, undo: every
 *     pre-existing value is restored exactly, or the file is untouched and the backup kept
 */
let dir: string;
let manifest: Record<string, WrittenConfig>;
const note = () => {};
const file = () => path.join(dir, 'hooks.json');
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-removed-'));
  manifest = {};
  setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
});
afterEach(() => { setWriteRecorder(undefined); rmSync(dir, { recursive: true, force: true }); });

const userLint = { command: 'lint', matcher: 'Write' };
const teamProd = { command: 'align check --advisory --format cursor', matcher: 'Write', timeout: 10 };
const read = () => JSON.parse(readFileSync(file(), 'utf8'));
const touch = (fn: (c: Record<string, any>) => void) => { const c = read(); fn(c); writeFileSync(file(), JSON.stringify(c)); };

describe('an existing array align removed an element from', () => {
  const start = (pre: unknown[]) => {
    writeFileSync(file(), JSON.stringify({ version: 1, hooks: { preToolUse: pre, postToolUse: [teamProd] } }));
    writeUserHooks({ host: 'cursor', path: file() }, 'local');
  };

  it('records the array as ONE replaced unit', () => {
    start([userLint, teamProd]);
    const owned = manifest[file()]!.owned!;
    expect(owned.filter((o) => o.path.join('.') === 'hooks.preToolUse').map((o) => [o.kind, o.replaced === true])).toEqual([['value', true]]);
  });

  it('(probe) undo restores [user-lint, team-prod-hook] exactly and keeps an unrelated user edit', () => {
    start([userLint, teamProd]);
    expect(read().hooks.preToolUse.map((h: { command: string }) => h.command)).toEqual(['lint', 'align check --advisory --format cursor --env local']);
    touch((c) => { c.theirs = { keep: true }; });
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([file()]);
    expect(read().hooks.preToolUse).toEqual([userLint, teamProd]);
    expect(read().theirs).toEqual({ keep: true });
  });

  it('a second example: only the team hook was there', () => {
    start([teamProd]);
    touch((c) => { c.theirs = 1; });
    undoWrittenConfigs(manifest);
    expect(read().hooks.preToolUse).toEqual([teamProd]);
  });

  it('when the user also edited that array the file is byte for byte untouched, the array is named, and the backup stays', () => {
    start([userLint, teamProd]);
    touch((c) => { c.hooks.preToolUse.push({ command: 'mine-too' }); c.theirs = 1; });
    const bytes = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(report.skipped.join('\n')).toContain('hooks.preToolUse was edited since align wrote it');
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    expect(existsSync(file() + BACKUP_SUFFIX)).toBe(true);
  });

  it('an older-format align hook replaced by an upgrade comes back', () => {
    const oldFormat = { command: 'align check --advisory', matcher: 'Edit' };
    start([userLint, oldFormat]);
    touch((c) => { c.theirs = 1; });
    undoWrittenConfigs(manifest);
    expect(read().hooks.preToolUse).toEqual([userLint, oldFormat]);
  });

  it('pure additions stay element-wise: the user\'s own later additions to the array survive', () => {
    start([userLint]);
    touch((c) => { c.hooks.preToolUse.push({ command: 'added-later' }); });
    undoWrittenConfigs(manifest);
    expect(read().hooks.preToolUse).toEqual([userLint, { command: 'added-later' }]);
  });

  it('a re-run after our own earlier write (an upgrade of align\'s own hook) is not mistaken for the user\'s', () => {
    start([userLint]);
    writeUserHooks({ host: 'cursor', path: file() }, 'staging');
    touch((c) => { c.theirs = 1; });
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([file()]);
    expect(read().hooks.preToolUse).toEqual([userLint]);
  });
});

describe('an array align added to and later removed a user element from', () => {
  it('the original comes back whole: the units are undone in the right order', () => {
    writeFileSync(file(), JSON.stringify({ hooks: { preToolUse: [userLint] } }));
    writeUserHooks({ host: 'cursor', path: file() }, 'local');
    safeWriteJson(file(), (c) => ({ ...c, hooks: { ...(c['hooks'] as object), preToolUse: (c['hooks'] as { preToolUse: unknown[] }).preToolUse.filter((h) => (h as { command: string }).command !== 'lint') } }), { note });
    touch((c) => { c.theirs = 1; });
    undoWrittenConfigs(manifest);
    expect(read().hooks.preToolUse).toEqual([userLint]);
    expect(read().theirs).toBe(1);
  });
});

describe('an existing key align took away', () => {
  it('comes back from the backup; if it reappeared edited it is left and the file untouched', () => {
    writeFileSync(file(), JSON.stringify({ keep: 1, legacy: { a: [1, 2] } }));
    safeWriteJson(file(), ({ legacy: _l, ...rest }) => ({ ...rest, added: 1 }), { note });
    touch((c) => { c.theirs = 1; });
    expect(manifest[file()]!.owned!.some((o) => o.removed)).toBe(true);
    undoWrittenConfigs(manifest);
    expect(read()).toEqual({ keep: 1, legacy: { a: [1, 2] }, theirs: 1 });

    writeFileSync(file(), JSON.stringify({ keep: 1, legacy: { a: [1, 2] } }));
    rmSync(file() + BACKUP_SUFFIX, { force: true });
    manifest = {};
    safeWriteJson(file(), ({ legacy: _l, ...rest }) => ({ ...rest, added: 1 }), { note });
    touch((c) => { c.legacy = { different: true }; });
    const bytes = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
  });
});

describe('property: nothing that was there before is ever lost', () => {
  /** A small seeded generator, so a failure names its seed. */
  function rng(seed: number) { let x = seed; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
  const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

  function randomConfig(r: () => number): Record<string, any> {
    const servers: Record<string, any> = {};
    for (const n of ['align', 'linear', 'other']) if (r() < 0.6) servers[n] = { command: pick(r, ['align', 'npx', 'node']), args: ['mcp', ...(r() < 0.5 ? ['--env', pick(r, ['prod', 'local'])] : [])] };
    const hooks: Record<string, any[]> = {};
    for (const ev of ['preToolUse', 'postToolUse']) if (r() < 0.7) hooks[ev] = [...(r() < 0.6 ? [{ command: 'lint' }] : []), ...(r() < 0.5 ? [{ command: 'align check --advisory --format cursor', matcher: 'Write' }] : [])];
    return { ...(r() < 0.5 ? { version: 1 } : {}), mcpServers: servers, hooks, ...(r() < 0.5 ? { theirs: { n: Math.floor(r() * 9) } } : {}) };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])('seed %i', (seed) => {
    const r = rng(seed);
    const original = randomConfig(r);
    writeFileSync(file(), JSON.stringify(original, null, 2));
    const originalBytes = readFileSync(file(), 'utf8');
    // align writes: its server entry (overwriting any `align`) and its hooks (stripping prior ones)
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), 'align': { command: 'align', args: ['mcp', '--env', 'local'] }, 'align-local': { command: 'align' } } }), { note });
    writeUserHooks({ host: 'cursor', path: file() }, 'local');
    // an unrelated user edit
    touch((c) => { c.unrelatedEdit = seed; });
    const report = undoWrittenConfigs(manifest);
    const after = read();
    if (report.done.includes(file())) {
      // restored: every pre-existing value is back exactly
      for (const [k, v] of Object.entries(original)) expect(after[k], `seed ${seed} key ${k}`).toEqual(v);
      expect(after.unrelatedEdit).toBe(seed);
      expect(after.mcpServers?.['align-local']).toBeUndefined();
    } else {
      // left: untouched, named, backup kept
      expect(existsSync(file() + BACKUP_SUFFIX), `seed ${seed} backup`).toBe(true);
      expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe(originalBytes);
      expect(report.skipped.length).toBeGreaterThan(0);
    }
    mkdirSync(dir, { recursive: true });
  });
});
