import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_SUFFIX,
  type SafeFs,
  SafeWriteConflictError,
  safeWriteJson,
  safeWriteText,
  setWriteRecorder,
  undoWrittenConfigs,
  type WrittenConfig,
} from '../lib/safe-config-write.js';
import * as realFs from 'node:fs';

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
    expect(statSync(file()).mode & 0o777).toBe(mode);
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

describe('undoWrittenConfigs', () => {
  it('restores byte-identical content and removes the backup (two files)', () => {
    const manifest: Record<string, WrittenConfig> = {};
    setWriteRecorder((f, e) => { manifest[f] = e; });
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    writeFileSync(a, '{ "x":   1 }\n');
    writeFileSync(b, '{"y":2}');
    safeWriteJson(a, (c) => ({ ...c, add: 1 }), { note });
    safeWriteJson(b, (c) => ({ ...c, add: 1 }), { note });
    const report = undoWrittenConfigs(manifest);
    expect(report.restored.sort()).toEqual([a, b]);
    expect(readFileSync(a, 'utf8')).toBe('{ "x":   1 }\n');
    expect(readFileSync(b, 'utf8')).toBe('{"y":2}');
    expect(() => readFileSync(a + BACKUP_SUFFIX)).toThrow();
  });

  it('removes a file align created, but only while it still holds what align wrote', () => {
    const manifest: Record<string, WrittenConfig> = {};
    setWriteRecorder((f, e) => { manifest[f] = e; });
    const untouched = path.join(dir, 'u.json');
    const edited = path.join(dir, 'e.json');
    safeWriteJson(untouched, () => ({ a: 1 }), { note });
    safeWriteJson(edited, () => ({ a: 1 }), { note });
    writeFileSync(edited, '{"a":1,"user":"edit"}');
    const report = undoWrittenConfigs(manifest);
    expect(report.removed).toEqual([untouched]);
    expect(report.skipped.join('\n')).toContain('edited since align created it');
    expect(readFileSync(edited, 'utf8')).toContain('user');
  });

  it('skips a symlink and a missing backup, with a reason each', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, file());
    const lost = path.join(dir, 'lost.json');
    writeFileSync(lost, '{}');
    const report = undoWrittenConfigs({ [file()]: { created: false, sha256: 'x' }, [lost]: { created: false, sha256: 'x' } });
    expect(report.restored).toEqual([]);
    expect(report.skipped.join('\n')).toContain('symlink');
    expect(report.skipped.join('\n')).toContain('no backup found');
    expect(mkdirSync(dir, { recursive: true }) ?? true).toBe(true);
  });
});
