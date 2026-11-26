/**
 * rmDir is what about 30 test files call in afterEach to remove their temp folder.
 *
 * Node 22's fs.rmSync retries a folder only when its FIRST rmdir fails with ENOTEMPTY, EEXIST or EPERM. A first rmdir that fails
 * with EBUSY is thrown at once, whatever maxRetries says (lib/internal/fs/rimraf.js, _rmdirSync). On Windows that is the
 * folder an exiting child still has as its working directory: main failed there on 26 Nov 2026
 * (launcher-child-telemetry-e2e, "EBUSY ... rmdir ...\home", two seconds in, with maxRetries 20). So rmDir does the
 * waiting itself. fs.rmSync and Atomics.wait are the two things mocked here: the file system and the clock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmDir } from './helpers/rm-dir.js';

const fail = (code: string): Error => Object.assign(new Error(`${code}: mocked`), { code });

/** Replace the clock, and return the list of waits (ms) rmDir asks for. */
function waits(): number[] {
  const asked: number[] = [];
  vi.spyOn(Atomics, 'wait').mockImplementation((_a, _i, _v, ms) => { asked.push(ms as number); return 'timed-out'; });
  return asked;
}

describe('rmDir', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])('waits and tries again when the removal fails with %s', (code) => {
    const asked = waits();
    const rm = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw fail(code); }).mockImplementation(() => undefined);
    rmDir('/nowhere/align-rmdir-mocked');
    expect(rm).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([150]);
  });

  it('throws at once, without waiting, on an error that waiting cannot fix', () => {
    const asked = waits();
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw fail('EINVAL'); });
    expect(() => rmDir('/nowhere/align-rmdir-mocked')).toThrow(/EINVAL/);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([]);
  });

  it('gives up after 20 tries, having waited a little longer before each one, and throws what it last saw', () => {
    const asked = waits();
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw fail('EBUSY'); });
    expect(() => rmDir('/nowhere/align-rmdir-mocked')).toThrow(/EBUSY/);
    expect(rm).toHaveBeenCalledTimes(20);
    // 19 waits between 20 tries: 150, 300, ... 2850 ms, 28.5 s in all.
    expect(asked).toEqual(Array.from({ length: 19 }, (_, i) => 150 * (i + 1)));
  });

  // Not mocked: the two things every caller relies on.
  it('removes a real folder with folders and files in it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-rmdir-real-'));
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');
    expect(fs.existsSync(path.join(dir, 'a', 'b', 'f.txt'))).toBe(true);
    rmDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('does nothing, and does not throw, when the folder is already gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-rmdir-gone-'));
    fs.rmdirSync(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => rmDir(dir)).not.toThrow();
  });
});
