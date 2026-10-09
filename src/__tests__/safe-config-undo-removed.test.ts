import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SUFFIX, mergeWrittenConfig, safeWriteJson, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { applyConfigWrite } from '../lib/launch/config-writes.js';
import { writeMcpConfig } from '../lib/mcp-setup.js';
import { writeUserHooks } from '../lib/user-hooks.js';

/*
 * C4 Test List (align REMOVED or CHANGED something that was already there):
 *  1. an existing array align removed an element from (writeUserHooks strips a prior align hook) is ONE
 *     replaced unit; undo restores the original array exactly and keeps an unrelated user edit
 *  2. the user also edited that array: file untouched, named, backup kept
 *  3. an older-format align hook replaced by an upgrade comes back
 *  4. pure additions to an array stay element-wise (user's elements and later edits untouched)
 *  5. an existing key align took away (removed unit) comes back; edited-since is left
 *  6. a file align created that the user then populated: the next align write takes a snapshot first, so
 *     a user value it replaces (`align`) comes back on undo (probe C), by the setup path and the launch path
 *  7. property: random pre-existing configs, an align write, an unrelated user edit, undo: every
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

describe('a file align created that the user then populated (MEDIUM, last check)', () => {
  const cursorTarget = () => ({ name: 'Cursor', configPath: file(), format: 'mcpServers' as const });
  const launchWrite = () => applyConfigWrite({ kind: 'mcp-entry', file: file(), topKey: 'mcpServers', name: 'align-local', entry: { command: 'align', args: ['mcp', '--env', 'local'] } }, note);
  const userOwn = { command: 'user-own' };

  it('(probe C) launch creates the file, the user adds `align` and `gh`, `mcp --setup` overwrites `align`: undo gives the user\'s `align` back and keeps `gh`', () => {
    launchWrite();
    touch((c) => { c.mcpServers.align = userOwn; c.mcpServers.gh = { command: 'gh' }; });
    writeMcpConfig(cursorTarget() as never, undefined);
    expect(read().mcpServers.align.command).not.toBe('user-own'); // setup really did overwrite it
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([file()]);
    expect(read().mcpServers.align).toEqual(userOwn);
    expect(read().mcpServers.gh).toEqual({ command: 'gh' });
    expect(read().mcpServers['align-local']).toBeUndefined();
  });

  it('a second variant, all on the launch path: the user\'s own `align-local` is never replaced, but a populated file is snapshotted before a second launch write', () => {
    launchWrite();
    touch((c) => { c.mcpServers.mine = { command: 'm' }; });
    applyConfigWrite({ kind: 'mcp-entry', file: file(), topKey: 'mcpServers', name: 'align-local-2', entry: { command: 'align' } }, note);
    expect(existsSync(`${file() + BACKUP_SUFFIX  }.1`)).toBe(true);
    undoWrittenConfigs(manifest);
    expect(read()).toEqual({ mcpServers: { mine: { command: 'm' } } });
  });

  it('snapshots are regular files, 0600, numbered without overwriting, and the manifest holds hashes only (never values)', () => {
    launchWrite();
    touch((c) => { c.mcpServers.secret = { env: { TOKEN: 'hunter2-very-secret' } }; });
    writeMcpConfig(cursorTarget() as never, undefined);
    touch((c) => { c.mcpServers.more = { command: 'x' }; });
    writeMcpConfig(cursorTarget() as never, 'staging');
    const snaps = readdirSync(dir).filter((f) => /\.align-backup\.\d+$/.test(f)).sort();
    expect(snaps).toEqual(['hooks.json.align-backup.1', 'hooks.json.align-backup.2']);
    for (const f of snaps) {
      expect(lstatSync(path.join(dir, f)).isFile()).toBe(true);
      expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path.join(dir, snaps[0]!), 'utf8')).not.toContain('"more"');
    expect(JSON.stringify(manifest)).not.toContain('hunter2');
  });

  it('snapshots go only after a fully clean undo; a left file keeps every one', () => {
    launchWrite();
    touch((c) => { c.mcpServers.align = userOwn; });
    writeMcpConfig(cursorTarget() as never, undefined);
    touch((c) => { c.mcpServers.align.args.push('--edited'); });
    const bytes = readFileSync(file(), 'utf8');
    expect(undoWrittenConfigs(manifest).done).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    expect(existsSync(`${file() + BACKUP_SUFFIX  }.1`)).toBe(true);
    // the user puts it right: now the undo is clean and the snapshots are removed
    touch((c) => { c.mcpServers.align.args.pop(); });
    expect(undoWrittenConfigs(manifest).cleaned).toEqual([file()]);
    expect(existsSync(`${file() + BACKUP_SUFFIX  }.1`)).toBe(false);
    expect(read().mcpServers.align).toEqual(userOwn);
  });

  it('a snapshot that was swapped is not trusted: the replaced entry is left and named, the file untouched', () => {
    launchWrite();
    touch((c) => { c.mcpServers.align = userOwn; });
    writeMcpConfig(cursorTarget() as never, undefined);
    writeFileSync(`${file() + BACKUP_SUFFIX  }.1`, '{"mcpServers":{"align":{"command":"forged"}}}');
    const bytes = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    expect(report.skipped.join('\n')).toContain('cannot restore it');
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
  });

  it('a file already named .align-backup.1 is not ours and is never overwritten: the snapshot takes the next free number', () => {
    launchWrite();
    writeFileSync(`${file() + BACKUP_SUFFIX  }.1`, 'someone else\'s');
    touch((c) => { c.mcpServers.align = userOwn; });
    writeMcpConfig(cursorTarget() as never, undefined);
    expect(readFileSync(`${file() + BACKUP_SUFFIX  }.1`, 'utf8')).toBe('someone else\'s');
    expect(existsSync(`${file() + BACKUP_SUFFIX  }.2`)).toBe(true);
    undoWrittenConfigs(manifest);
    expect(read().mcpServers.align).toEqual(userOwn);
    expect(readFileSync(`${file() + BACKUP_SUFFIX  }.1`, 'utf8')).toBe('someone else\'s'); // still there after the undo
  });

  it('nothing is snapshotted while the file is exactly what align last wrote', () => {
    launchWrite();
    writeMcpConfig(cursorTarget() as never, undefined);
    expect(readdirSync(dir).filter((f) => f.includes('.align-backup'))).toEqual([]);
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

  const alignWrites = () => {
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), 'align': { command: 'align', args: ['mcp', '--env', 'local'] }, 'align-local': { command: 'align' } } }), { note });
    writeUserHooks({ host: 'cursor', path: file() }, 'local');
  };

  /**
   * The user's touch: sometimes an unrelated key, sometimes an edit INSIDE an entry align wrote or
   * replaced. (Editing inside align's own HOOK element is a known, separately tracked gap, so it
   * is not generated.) Returns what was edited.
   */
  const userTouch = (r: () => number, seed: number): 'unrelated' | 'align-local' | 'align' => {
    let edited: 'unrelated' | 'align-local' | 'align' = 'unrelated';
    touch((c) => {
      const roll = r();
      if (roll >= 0.35 && roll < 0.65 && c.mcpServers?.['align-local']) { c.mcpServers['align-local'].command = 'edited-inside'; edited = 'align-local'; }
      else if (roll >= 0.65 && c.mcpServers?.align?.args) { c.mcpServers.align.args.push('--edited-inside'); edited = 'align'; }
      else c.unrelatedEdit = seed;
    });
    return edited;
  };

  const backups = () => readdirSync(dir).filter((f) => f.includes('.align-backup')).map((f) => path.join(dir, f));
  const jsonOf = (f: string): Record<string, any> | null => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

  /** Every top-level value of `protectedState` is in the file, or in a kept copy of it. Never lost. */
  const neverLost = (protectedState: Record<string, any>, seed: string, edited: string) => {
    const holders = [jsonOf(file()), ...backups().map(jsonOf)].filter((x): x is Record<string, any> => x !== null);
    for (const [k, v] of Object.entries(protectedState)) {
      if (k === 'mcpServers') {
        for (const [name, server] of Object.entries(v as Record<string, unknown>)) {
          if (name === edited) continue; // the user edited this one themselves after align wrote the same value
          expect(holders.some((h) => JSON.stringify(h.mcpServers?.[name]) === JSON.stringify(server)), `${seed} mcpServers.${name} lost`).toBe(true);
        }
      } else if (k === 'hooks') {
        for (const [ev, arr] of Object.entries(v as Record<string, unknown[]>)) {
          for (const el of arr) expect(holders.some((h) => (h.hooks?.[ev] ?? []).some((x: unknown) => JSON.stringify(x) === JSON.stringify(el))), `${seed} hooks.${ev} element lost`).toBe(true);
        }
      } else {
        expect(holders.some((h) => JSON.stringify(h[k]) === JSON.stringify(v)), `${seed} ${k} lost`).toBe(true);
      }
    }
  };

  it.each(Array.from({ length: 40 }, (_, n) => n + 1))('pre-existing file, seed %i', (seed) => {
    const r = rng(seed);
    const original = randomConfig(r);
    writeFileSync(file(), JSON.stringify(original, null, 2));
    alignWrites();
    const edited = userTouch(r, seed);
    const afterTouch = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    if (report.done.includes(file())) {
      for (const [k, v] of Object.entries(original)) {
        // an entry the user edited keeps their edit (the original is in the backup)
        if (k === 'mcpServers') for (const [n, srv] of Object.entries(v as object)) { if (n !== edited) expect(read().mcpServers[n], `seed ${seed} server ${n}`).toEqual(srv); }
        else expect(read()[k], `seed ${seed} key ${k}`).toEqual(v);
      }
      if (edited !== 'align-local') expect(read().mcpServers?.['align-local']).toBeUndefined();
    } else {
      expect(readFileSync(file(), 'utf8'), `seed ${seed}: a left file is untouched`).toBe(afterTouch);
      expect(report.skipped.length).toBeGreaterThan(0);
    }
    neverLost(original, `seed ${seed}`, edited);
  });

  it.each(Array.from({ length: 40 }, (_, n) => n + 101))('a file align created that the user then populated, seed %i', (seed) => {
    const r = rng(seed);
    alignWrites(); // creates the file
    const populated = randomConfig(r);
    // the user fills it in (keeping what align put there, as an editor would), including their own `align`
    const created = read();
    const hooks: Record<string, unknown[]> = {};
    for (const ev of new Set([...Object.keys(populated.hooks ?? {}), ...Object.keys(created.hooks ?? {})])) hooks[ev] = [...(populated.hooks?.[ev] ?? []), ...(created.hooks?.[ev] ?? [])];
    const merged = { ...populated, version: 1, mcpServers: { ...populated.mcpServers, 'align-local': created.mcpServers['align-local'] }, hooks };
    writeFileSync(file(), JSON.stringify(merged, null, 2));
    alignWrites(); // setup / a later launch writes again, overwriting `align` and stripping prior hooks
    const edited = userTouch(r, seed);
    const afterTouch = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    if (!report.done.includes(file())) {
      expect(readFileSync(file(), 'utf8'), `seed ${seed}: a left file is untouched`).toBe(afterTouch);
      expect(report.skipped.length).toBeGreaterThan(0);
    } else if (existsSync(file()) && edited !== 'align-local') {
      expect(read().mcpServers?.['align-local']).toBeUndefined();
    }
    // what the user populated (their `align`, their other servers, their hooks) is in the file or a kept copy
    // (`version` is left out: align and the user both wrote it, so nothing of the user's is in it.)
    const { version: _v, ...mine } = populated;
    neverLost(mine, `seed ${seed}`, edited);
  });
});
