import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_SUFFIX,
  mergeWrittenConfig,
  type SafeFs,
  SafeWriteConflictError,
  safeWriteJson,
  safeWriteText,
  setWriteRecorder,
  undoWrittenConfigs,
  type WrittenConfig,
} from '../lib/safe-config-write.js';
import * as realFs from 'node:fs';
import { expectPosixMode } from './helpers/platform.js';

/*
 * C4 Test List (safe writer):
 *  1. backup: first write keeps the original; a second write keeps the FIRST backup (two writes)
 *  2. a missing file gets no backup and is recorded as created; an existing one is not
 *  3. atomic: no temp file is left behind, and the existing mode survives (0600 and 0640)
 *  4. concurrent change: one change is recomputed over (the other writer's key survives); a
 *     second change aborts with a message naming the file and leaves the other writer's bytes
 *  5. symlink: refused with one line naming link and target, target bytes untouched; a regular
 *     file beside it is written
 *  6. update returning undefined declines (no write, no backup); identical content is unchanged
 *  7. invalid JSON throws and leaves the file alone
 *  8. undo: existing file restored byte-identical and backup removed; created file removed only
 *     while unedited; symlink and missing backup are skipped with a reason
 */
let dir: string;
let notes: string[];
const note = (l: string) => notes.push(l);
const file = () => path.join(dir, 'mcp.json');
/** A manifest kept the way the config store keeps it: merged per file. */
function track(): Record<string, WrittenConfig> {
  const m: Record<string, WrittenConfig> = {};
  setWriteRecorder((f, e) => { m[f] = mergeWrittenConfig(m[f], e); }, (f) => m[f]);
  return m;
}
const noTemps = () => readdirSync(dir).filter((f) => f.includes('align-tmp'));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-safe-'));
  notes = [];
  setWriteRecorder(undefined);
});
afterEach(() => {
  setWriteRecorder(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** A fake that edits the real file at the moment align stages its temp file, `times` times. */
function interfering(times: number): SafeFs {
  let n = 0;
  return {
    ...(realFs as unknown as SafeFs),
    writeFileSync: ((f: string, ...rest: unknown[]) => {
      if (String(f).endsWith('.align-tmp') && n < times) {
        n += 1;
        writeFileSync(file(), JSON.stringify({ other: n }), 'utf8');
      }
      return (realFs.writeFileSync as (...a: unknown[]) => void)(f, ...rest);
    }) as SafeFs['writeFileSync'],
  };
}

describe('safeWriteJson: backup', () => {
  it('keeps the original in <file>.align-backup, byte for byte', () => {
    const original = '{\n  "keep": 1 }\n';
    writeFileSync(file(), original);
    expect(safeWriteJson(file(), (c) => ({ ...c, add: true }), { note })).toBe('written');
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ keep: 1, add: true });
  });

  it('a second write keeps the FIRST backup (two different second writes)', () => {
    const original = '{"keep":1}';
    writeFileSync(file(), original);
    safeWriteJson(file(), (c) => ({ ...c, a: 1 }), { note });
    safeWriteJson(file(), (c) => ({ ...c, b: 2 }), { note });
    safeWriteJson(file(), (c) => ({ ...c, c: 3 }), { note });
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe(original);
  });

  it('a missing file gets no backup and is recorded as created; an existing one is recorded as not created', () => {
    const seen: Array<[string, WrittenConfig]> = [];
    setWriteRecorder((f, e) => seen.push([f, e]));
    const fresh = path.join(dir, 'new', 'a.json');
    safeWriteJson(fresh, () => ({ x: 1 }), { note });
    expect(() => readFileSync(fresh + BACKUP_SUFFIX)).toThrow();
    writeFileSync(file(), '{}');
    safeWriteJson(file(), () => ({ y: 1 }), { note });
    expect(seen.map(([f, e]) => [f, e.created])).toEqual([[fresh, true], [file(), false]]);
  });
});

describe('safeWriteJson: atomic write', () => {
  it.each([0o600, 0o640])('keeps the existing mode %o and leaves no temp file', (mode) => {
    writeFileSync(file(), '{}');
    chmodSync(file(), mode);
    safeWriteJson(file(), () => ({ a: 1 }), { note });
    expectPosixMode(statSync(file()).mode, mode);
    expect(readdirSync(dir).filter((f) => f.includes('align-tmp'))).toEqual([]);
  });
});

describe('safeWriteJson: another writer', () => {
  it('recomputes once when the file changes during our write, so their key survives', () => {
    writeFileSync(file(), '{"orig":1}');
    const status = safeWriteJson(file(), (c) => ({ ...c, mine: true }), { note, fs: interfering(1) });
    expect(status).toBe('written');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ other: 1, mine: true });
  });

  it('aborts when it changes again, naming the file, and leaves the other writer\'s bytes', () => {
    writeFileSync(file(), '{"orig":1}');
    let err: unknown;
    try {
      safeWriteJson(file(), (c) => ({ ...c, mine: true }), { note, fs: interfering(2) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SafeWriteConflictError);
    expect((err as Error).message).toContain(file());
    expect(readFileSync(file(), 'utf8')).toBe('{"other":2}');
    expect(readdirSync(dir).filter((f) => f.includes('align-tmp'))).toEqual([]);
  });
});

describe('safeWriteJson: symlinks', () => {
  it('refuses to write through a link: one line naming link and target, target untouched', () => {
    const real = path.join(dir, 'other-product.json');
    writeFileSync(real, '{"theirs":true}');
    symlinkSync(real, file());
    expect(safeWriteJson(file(), (c) => ({ ...c, mine: 1 }), { note })).toBe('symlink');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(file());
    expect(notes[0]).toContain(real);
    expect(readFileSync(real, 'utf8')).toBe('{"theirs":true}');
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(() => readFileSync(real + BACKUP_SUFFIX)).toThrow();
  });

  it('a regular file next to it is written and says nothing', () => {
    writeFileSync(file(), '{}');
    expect(safeWriteJson(file(), () => ({ a: 1 }), { note })).toBe('written');
    expect(notes).toEqual([]);
  });
});

describe('safeWriteJson: declined, unchanged, invalid', () => {
  it('update returning undefined writes nothing and makes no backup', () => {
    writeFileSync(file(), '{"a":1}');
    expect(safeWriteJson(file(), () => undefined, { note })).toBe('declined');
    expect(readFileSync(file(), 'utf8')).toBe('{"a":1}');
    expect(() => readFileSync(file() + BACKUP_SUFFIX)).toThrow();
  });

  it('identical content is unchanged, and creates no backup', () => {
    writeFileSync(file(), JSON.stringify({ a: 1 }, null, 2));
    expect(safeWriteJson(file(), (c) => c, { note })).toBe('unchanged');
    expect(() => readFileSync(file() + BACKUP_SUFFIX)).toThrow();
  });

  it('invalid JSON throws naming the file and leaves it as it was', () => {
    writeFileSync(file(), '{ not json');
    expect(() => safeWriteJson(file(), (c) => c, { note })).toThrow(`${file()} contains invalid JSON`);
    expect(readFileSync(file(), 'utf8')).toBe('{ not json');
  });

  it('a JSON array at the top is refused the same way', () => {
    writeFileSync(file(), '[1]');
    expect(() => safeWriteJson(file(), (c) => c, { note })).toThrow('invalid JSON');
  });

  it('trailingNewline ends the file with one newline; the default does not', () => {
    safeWriteJson(file(), () => ({ a: 1 }), { note, trailingNewline: true });
    expect(readFileSync(file(), 'utf8').endsWith('}\n')).toBe(true);
    const other = path.join(dir, 'b.json');
    safeWriteJson(other, () => ({ a: 1 }), { note });
    expect(readFileSync(other, 'utf8').endsWith('}')).toBe(true);
  });
});

describe('safeWriteText', () => {
  it('passes null for a missing file, then the current text', () => {
    const f = path.join(dir, 'c.toml');
    const seen: Array<string | null> = [];
    safeWriteText(f, (cur) => { seen.push(cur); return 'a = 1\n'; }, { note });
    safeWriteText(f, (cur) => { seen.push(cur); return `${cur}b = 2\n`; }, { note });
    expect(seen).toEqual([null, 'a = 1\n']);
    expect(readFileSync(f, 'utf8')).toBe('a = 1\nb = 2\n');
  });
});

describe('undoWrittenConfigs: untouched files go back whole', () => {
  it('restores byte-identical content and removes the backup (two files)', () => {
    const manifest = track();
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    writeFileSync(a, '{ "x":   1 }\n');
    writeFileSync(b, '{"y":2}');
    safeWriteJson(a, (c) => ({ ...c, add: 1 }), { note });
    safeWriteJson(b, (c) => ({ ...c, add: 1 }), { note });
    const report = undoWrittenConfigs(manifest);
    expect(report.restored.sort()).toEqual([a, b]);
    expect(report.done.sort()).toEqual([a, b]);
    expect(readFileSync(a, 'utf8')).toBe('{ "x":   1 }\n');
    expect(readFileSync(b, 'utf8')).toBe('{"y":2}');
    expect(() => readFileSync(a + BACKUP_SUFFIX)).toThrow();
  });

  it('removes a file align created while it is exactly what align wrote (two files)', () => {
    const manifest = track();
    const one = path.join(dir, 'one.json');
    const two = path.join(dir, 'two.json');
    safeWriteJson(one, () => ({ a: 1 }), { note });
    safeWriteJson(two, () => ({ b: 1 }), { note });
    const report = undoWrittenConfigs(manifest);
    expect(report.removed.sort()).toEqual([one, two]);
    expect(() => readFileSync(one)).toThrow();
  });
});

describe('undoWrittenConfigs: a file the user touched since keeps their work (HIGH 1, 2)', () => {
  it('align adds align-local, the user adds github: undo keeps github and removes only align-local', () => {
    const manifest = track();
    writeFileSync(file(), '{"mcpServers":{"a":{}}}');
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), 'align-local': { command: 'align' } } }), { note });
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.github = { token: 'user-added-later' };
    writeFileSync(file(), JSON.stringify(cur));
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([file()]);
    expect(report.restored).toEqual([]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ mcpServers: { a: {}, github: { token: 'user-added-later' } } });
  });

  it('a second example: the user adds a top-level key', () => {
    const manifest = track();
    writeFileSync(file(), '{"keep":1}');
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { 'align-local': {} } }), { note });
    writeFileSync(file(), JSON.stringify({ ...JSON.parse(readFileSync(file(), 'utf8')), theirs: true }));
    undoWrittenConfigs(manifest);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ keep: 1, theirs: true });
  });

  it('created file, the user adds a server, align rewrites its entry, undo: the file and the user\'s server survive', () => {
    const manifest = track();
    safeWriteJson(file(), () => ({ mcpServers: { align: { env: 'local' } } }), { note });
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.github = { token: 'user' };
    writeFileSync(file(), JSON.stringify(cur));
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), align: { env: 'prod' } } }), { note });
    const report = undoWrittenConfigs(manifest);
    expect(report.removed).toEqual([]);
    expect(report.cleaned).toEqual([file()]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ mcpServers: { github: { token: 'user' } } });
  });

  it('an entry the user edited is left and named; the manifest keeps the file', () => {
    const manifest = track();
    writeFileSync(file(), '{}');
    safeWriteJson(file(), () => ({ mcpServers: { 'align-local': { command: 'align' } } }), { note });
    writeFileSync(file(), JSON.stringify({ mcpServers: { 'align-local': { command: 'my-own' } }, extra: 1 }));
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(report.skipped.join('\n')).toContain('mcpServers.align-local was edited since align wrote it');
    expect(JSON.parse(readFileSync(file(), 'utf8')).mcpServers['align-local'].command).toBe('my-own');
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe('{}');
  });

  it('an entry the user edited leaves the whole file untouched: not even the entries that could be removed (all or nothing)', () => {
    const manifest = track();
    writeFileSync(file(), '{"mcpServers":{"a":{}}}');
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), 'align-local': { command: 'align' } }, extra: 1 }), { note });
    writeFileSync(file(), JSON.stringify({ mcpServers: { a: {}, 'align-local': { command: 'mine' } }, extra: 1 }));
    const bytes = readFileSync(file(), 'utf8');
    const before = statSync(file()).ino;
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(bytes); // `extra` was removable and was NOT removed
    expect(statSync(file()).ino).toBe(before); // never even re-staged
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe('{"mcpServers":{"a":{}}}');
  });

  it('a file that no longer parses is skipped with what to remove by hand, and the backup stays', () => {
    const manifest = track();
    writeFileSync(file(), '{}');
    safeWriteJson(file(), () => ({ mcpServers: { 'align-local': {} } }), { note });
    writeFileSync(file(), '{ broken');
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(report.skipped.join('\n')).toContain(file());
    expect(report.skipped.join('\n')).toContain('mcpServers.align-local');
    expect(readFileSync(file(), 'utf8')).toBe('{ broken');
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe('{}');
  });

  it('text files: only the managed block comes out, and an edited block is left (two cases)', () => {
    const manifest = track();
    const f = path.join(dir, 'config.toml');
    const markers = { start: '# >>> align >>>', end: '# <<< align <<<' };
    writeFileSync(f, 'model = "x"\n');
    safeWriteText(f, (cur) => `${cur}\n${markers.start}\n[mcp_servers.align]\n${markers.end}\n`, { note, markers });
    writeFileSync(f, `${readFileSync(f, 'utf8')}user = 1\n`);
    expect(undoWrittenConfigs(manifest).cleaned).toEqual([f]);
    expect(readFileSync(f, 'utf8')).toBe('model = "x"\n\nuser = 1\n');

    const g = path.join(dir, 'other.toml');
    safeWriteText(g, () => `${markers.start}\n[mcp_servers.align]\n${markers.end}\n`, { note, markers });
    writeFileSync(g, `${markers.start}\n[mcp_servers.align]\ncommand = "mine"\n${markers.end}\n`);
    const report = undoWrittenConfigs(manifest);
    expect(report.skipped.join('\n')).toContain('block align manages was edited');
    expect(readFileSync(g, 'utf8')).toContain('command = "mine"');
  });
});

describe('undoWrittenConfigs: backups are only trusted when align made them (HIGH 3)', () => {
  it('a backup path that already existed as a symlink is never followed, and never overwritten', () => {
    const manifest = track();
    writeFileSync(file(), '{"orig":1}');
    const elsewhere = path.join(dir, 'elsewhere');
    writeFileSync(elsewhere, '{"stale":"something else"}');
    symlinkSync(elsewhere, file() + BACKUP_SUFFIX);
    safeWriteJson(file(), (c) => ({ ...c, add: 1 }), { note });
    expect(readFileSync(elsewhere, 'utf8')).toBe('{"stale":"something else"}');
    expect(manifest[file()]!.backup).toBe('foreign');
    const report = undoWrittenConfigs(manifest);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ orig: 1 }); // surgical: add removed, nothing stale restored
    expect(report.cleaned).toEqual([file()]);
    expect(readFileSync(elsewhere, 'utf8')).toBe('{"stale":"something else"}');
  });

  it('a regular backup that existed before align is not trusted either', () => {
    const manifest = track();
    writeFileSync(file(), '{"orig":1}');
    writeFileSync(file() + BACKUP_SUFFIX, '{"someone":"elses"}');
    safeWriteJson(file(), (c) => ({ ...c, add: 1 }), { note });
    undoWrittenConfigs(manifest);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ orig: 1 });
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe('{"someone":"elses"}');
  });

  it('a backup of ours that was swapped for different bytes is not restored', () => {
    const manifest = track();
    writeFileSync(file(), '{"orig":1}');
    safeWriteJson(file(), (c) => ({ ...c, add: 1 }), { note });
    writeFileSync(file() + BACKUP_SUFFIX, '{"tampered":1}');
    const report = undoWrittenConfigs(manifest);
    expect(report.restored).toEqual([]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ orig: 1 });
  });

  it('skips a symlinked file and leaves it in the manifest (done is empty)', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, file());
    const report = undoWrittenConfigs({ [file()]: { created: false, sha256: 'x', backup: 'made', backupSha256: 'y' } });
    expect(report.skipped.join('\n')).toContain('symlink');
    expect(report.done).toEqual([]);
  });

  it('an entry with no record of what was added is skipped, not guessed at', () => {
    writeFileSync(file(), '{"a":1}');
    const report = undoWrittenConfigs({ [file()]: { created: false, sha256: 'x', backup: 'none' } });
    expect(report.skipped.join('\n')).toContain('no record of what it added');
    expect(report.done).toEqual([]);
  });
});

describe('symlinked directories (MEDIUM 4)', () => {
  it('refuses to write into a linked agent dir, naming the link, and writes nothing there', () => {
    mkdirSync(path.join(dir, 'clank'));
    writeFileSync(path.join(dir, 'clank', 'mcp.json'), '{"mcpServers":{"clank":{}}}');
    symlinkSync(path.join(dir, 'clank'), path.join(dir, 'piagent'));
    const f = path.join(dir, 'piagent', 'mcp.json');
    expect(safeWriteJson(f, (c) => ({ ...c, mcpServers: { 'align-local': {} } }), { note, root: dir })).toBe('symlink');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(path.join(dir, 'piagent'));
    expect(notes[0]).toContain(path.join(dir, 'clank'));
    expect(readFileSync(path.join(dir, 'clank', 'mcp.json'), 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
    expect(readdirSync(path.join(dir, 'clank'))).toEqual(['mcp.json']);
  });

  it('a real nested dir under the same root is written', () => {
    const f = path.join(dir, 'real', 'deeper', 'mcp.json');
    expect(safeWriteJson(f, () => ({ a: 1 }), { note, root: dir })).toBe('written');
    expect(notes).toEqual([]);
  });

  it('creates missing directories 0700', () => {
    const f = path.join(dir, 'newagent', 'mcp.json');
    safeWriteJson(f, () => ({ a: 1 }), { note, root: dir });
    expectPosixMode(statSync(path.dirname(f)).mode, 0o700);
  });
});

describe('the staged temp file (MEDIUM 5)', () => {
  it('is created exclusively, 0600 for a new file, and a stale one from a crash is swept', () => {
    const stale = path.join(dir, '.mcp.json.deadbeef.align-tmp');
    writeFileSync(stale, 'half written');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(stale, old, old);
    const fresh = path.join(dir, '.mcp.json.cafe0000.align-tmp');
    writeFileSync(fresh, 'another align, right now');
    safeWriteJson(file(), () => ({ a: 1 }), { note });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // too young to be a crash leftover
    expectPosixMode(statSync(file()).mode, 0o600);
  });

  it('picks another name when the first is taken (EEXIST), instead of writing through it', () => {
    let calls = 0;
    const fs: SafeFs = {
      ...(realFs as unknown as SafeFs),
      writeFileSync: ((f: string, data: unknown, o: unknown) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        return (realFs.writeFileSync as (...a: unknown[]) => void)(f, data, o);
      }) as SafeFs['writeFileSync'],
    };
    expect(safeWriteJson(file(), () => ({ a: 1 }), { note, fs })).toBe('written');
    expect(calls).toBe(2);
    expect(noTemps()).toEqual([]);
  });

  it('writes the temp file with the exclusive flag', () => {
    const flags: unknown[] = [];
    const fs: SafeFs = {
      ...(realFs as unknown as SafeFs),
      writeFileSync: ((f: string, data: unknown, o: { flag?: string }) => {
        flags.push(o.flag);
        return (realFs.writeFileSync as (...a: unknown[]) => void)(f, data, o);
      }) as SafeFs['writeFileSync'],
    };
    safeWriteJson(file(), () => ({ a: 1 }), { note, fs });
    expect(flags).toEqual(['wx']);
  });
});

describe('invalid JSON message', () => {
  it('does not send a launch-path user to `align mcp --setup` by default, and does when the caller says so', () => {
    writeFileSync(file(), '{ nope');
    expect(() => safeWriteJson(file(), (c) => c, { note })).toThrow(/fix it manually, then run align again/);
    expect(() => safeWriteJson(file(), (c) => c, { note })).not.toThrow(/mcp --setup/);
    expect(() => safeWriteJson(file(), (c) => c, { note, invalidJsonAdvice: ' before running align mcp --setup' })).toThrow('before running align mcp --setup');
  });
});

describe('the created-file backup', () => {
  it('a file align created gets no backup on a later rewrite (there is no pre-Align state)', () => {
    track();
    safeWriteJson(file(), () => ({ a: 1 }), { note });
    safeWriteJson(file(), (c) => ({ ...c, b: 2 }), { note });
    expect(existsSync(file() + BACKUP_SUFFIX)).toBe(false);
  });
});

describe('undoWrittenConfigs: an entry align overwrote comes back from the backup (HIGH, second review)', () => {
  const userAlign = { command: 'align', args: ['mcp', '--env', 'prod'] };
  const setup = (align: unknown, original: unknown) => {
    const manifest = track();
    writeFileSync(file(), JSON.stringify({ mcpServers: { align: original } }));
    safeWriteJson(file(), (c) => ({ ...c, mcpServers: { ...(c['mcpServers'] as object), align } }), { note });
    return manifest;
  };

  it('records ONE replaced item at mcpServers.align and does not diff into its args', () => {
    const manifest = setup({ command: 'align', args: ['mcp', '--env', 'local'] }, userAlign);
    expect(manifest[file()]!.owned!.map((o) => [o.path.join('.'), o.kind, o.replaced === true])).toEqual([['mcpServers.align', 'value', true]]);
  });

  it('(b) after an unrelated user edit, undo puts the user\'s own array-valued entry back exactly and keeps the edit', () => {
    const manifest = setup({ command: 'align', args: ['mcp', '--env', 'local'] }, userAlign);
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.other = { command: 'x' };
    writeFileSync(file(), JSON.stringify(cur));
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([file()]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ mcpServers: { align: userAlign, other: { command: 'x' } } });
    expect(JSON.parse(readFileSync(file(), 'utf8')).mcpServers.align.args).toEqual(['mcp', '--env', 'prod']);
  });

  it('(b2) a different command shape comes back too (second example)', () => {
    const npx = { command: 'npx', args: ['-y', '@aligndottech/cli', 'mcp'] };
    const manifest = setup({ command: 'align', args: ['mcp', '--env', 'local'] }, npx);
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.other = {};
    writeFileSync(file(), JSON.stringify(cur));
    undoWrittenConfigs(manifest);
    expect(JSON.parse(readFileSync(file(), 'utf8')).mcpServers.align).toEqual(npx);
  });

  it('(b2) when the user also edited the overwritten entry, the file is left byte for byte, named, and the backup is kept', () => {
    const manifest = setup({ command: 'align', args: ['mcp', '--env', 'local'] }, userAlign);
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.align.args.push('--verbose');
    cur.mcpServers.other = {};
    writeFileSync(file(), JSON.stringify(cur));
    const bytes = readFileSync(file(), 'utf8');
    const report = undoWrittenConfigs(manifest);
    expect(report.done).toEqual([]);
    expect(report.cleaned).toEqual([]);
    expect(report.skipped.join('\n')).toContain('mcpServers.align was edited since align wrote it');
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    expect(existsSync(file() + BACKUP_SUFFIX)).toBe(true);
  });

  it('with the backup gone or swapped it is left and named, never half-restored, and nothing is rewritten', () => {
    const manifest = setup({ command: 'align', args: ['mcp', '--env', 'local'] }, userAlign);
    const cur = JSON.parse(readFileSync(file(), 'utf8'));
    cur.mcpServers.other = {};
    writeFileSync(file(), JSON.stringify(cur));
    const bytes = readFileSync(file(), 'utf8');
    writeFileSync(file() + BACKUP_SUFFIX, '{"tampered":1}');
    const report = undoWrittenConfigs(manifest);
    expect(report.skipped.join('\n')).toContain('align cannot restore it');
    expect(readFileSync(file(), 'utf8')).toBe(bytes);
    expect(readFileSync(file() + BACKUP_SUFFIX, 'utf8')).toBe('{"tampered":1}');
  });

  it('an array-valued hooks event only loses the elements align added', () => {
    const manifest = track();
    writeFileSync(file(), JSON.stringify({ hooks: { preToolUse: [{ command: 'mine' }] } }));
    safeWriteJson(file(), (c) => ({ ...c, hooks: { preToolUse: [...((c['hooks'] as { preToolUse: unknown[] }).preToolUse), { command: 'align check' }] } }), { note });
    writeFileSync(file(), JSON.stringify({ ...JSON.parse(readFileSync(file(), 'utf8')), theirs: 1 }));
    undoWrittenConfigs(manifest);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ hooks: { preToolUse: [{ command: 'mine' }] }, theirs: 1 });
  });

  it('a Codex block that replaced an existing block comes back from the backup; the user\'s later edit survives', () => {
    const manifest = track();
    const f = path.join(dir, 'config.toml');
    const markers = { start: '# >>> align', end: '# <<< align' };
    const teamBlock = `${markers.start}\n[mcp_servers.align]\nargs = ["mcp", "--env", "prod"]\n${markers.end}`;
    writeFileSync(f, `model = "x"\n\n${teamBlock}\n`);
    safeWriteText(f, (cur) => cur!.replace(/# >>> align[\s\S]*# <<< align/, `${markers.start}\n[mcp_servers.align]\nargs = ["mcp", "--env", "local"]\n${markers.end}`), { note, markers });
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n[other]\nk = 1\n`);
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([f]);
    expect(readFileSync(f, 'utf8')).toBe(`model = "x"\n\n${teamBlock}\n\n[other]\nk = 1\n`);
  });

  it('a replaced Codex block with no usable backup is left, named, and the file untouched', () => {
    const manifest = track();
    const f = path.join(dir, 'config.toml');
    const markers = { start: '# >>> align', end: '# <<< align' };
    writeFileSync(f, `${markers.start}\nold\n${markers.end}\n`);
    safeWriteText(f, () => `${markers.start}\nnew\n${markers.end}\n`, { note, markers });
    writeFileSync(f, `${readFileSync(f, 'utf8')}extra = 1\n`);
    unlinkSync(f + BACKUP_SUFFIX);
    const bytes = readFileSync(f, 'utf8');
    const report = undoWrittenConfigs(manifest);
    expect(report.skipped.join('\n')).toContain('cannot restore it');
    expect(readFileSync(f, 'utf8')).toBe(bytes);
  });
});

describe('a symlinked directory OUTSIDE the home dir (MEDIUM, second review)', () => {
  it('is refused even with no root given (a PI_CODING_AGENT_DIR that is a link)', () => {
    mkdirSync(path.join(dir, 'clank'));
    writeFileSync(path.join(dir, 'clank', 'mcp.json'), '{"mcpServers":{"clank":{}}}');
    symlinkSync(path.join(dir, 'clank'), path.join(dir, 'piagent'));
    const f = path.join(dir, 'piagent', 'mcp.json');
    expect(safeWriteJson(f, (c) => ({ ...c, a: 1 }), { note })).toBe('symlink');
    expect(notes[0]).toContain(path.join(dir, 'piagent'));
    expect(readFileSync(path.join(dir, 'clank', 'mcp.json'), 'utf8')).toBe('{"mcpServers":{"clank":{}}}');
  });

  it('a real directory outside the home dir is written', () => {
    mkdirSync(path.join(dir, 'real'));
    expect(safeWriteJson(path.join(dir, 'real', 'mcp.json'), () => ({ a: 1 }), { note })).toBe('written');
  });
});
