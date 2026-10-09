/**
 * Pin `process.platform` for a suite, and put it back afterwards.
 *
 * ALI-1135 made what `align mcp --setup` writes depend on the platform: on Windows an npm
 * global install exposes `align.cmd`, which a client cannot spawn without a shell, so the
 * entry goes through `cmd /c`. Every assertion on that entry is therefore conditional
 * behaviour, and a test that inherits the runner's platform is only testing one side of it -
 * green on Linux, red on this repo's Windows leg, having established nothing either way
 * (tdd.md, "a test must establish its own preconditions").
 *
 * One helper rather than a copy of the same three lines per suite: the restore is the part
 * that is easy to get wrong, and a suite that forgets it leaks the stub into every file
 * vitest runs after it in the same worker.
 */
import { afterAll, beforeEach, expect } from 'vitest';

/** The set `process.platform` can hold, without naming the NodeJS global (eslint: no-undef). */
export type Platform = typeof process.platform;

const REAL = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** Set the platform for the next assertion. Call inside a test or a beforeEach. */
export function setPlatform(value: Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Restore whatever this process really runs on. */
export function restorePlatform(): void {
  Object.defineProperty(process, 'platform', REAL);
}

/**
 * Pin one platform for every test in the calling file. Registers its own restore, so the
 * suite cannot leave the stub behind.
 */
export function pinPlatform(value: Platform): void {
  beforeEach(() => setPlatform(value));
  afterAll(restorePlatform);
}

/**
 * The `{command, args}` an `align mcp` server entry holds on the platform the test really runs
 * on: bare `align` on POSIX, `cmd /c align ...` on Windows (ALI-1135). For tests that are about
 * something else (the launch pipeline, overwrite policy) and only need the entry's shape to
 * match what production wrote, so they stay correct on both legs without pinning a platform.
 */
export function alignEntryShape(args: string[]): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'align', ...args] }
    : { command: 'align', args };
}

/** The same entry as one argv array, the form OpenCode stores (`command: [...]`). */
export function alignEntryArgv(args: string[]): string[] {
  const { command, args: rest } = alignEntryShape(args);
  return [command, ...rest];
}

/**
 * Assert a file's permission bits on POSIX only. Windows has no 0600/0700: stat reports 0o666
 * for a writable file and 0o777 for a directory whatever the writer asked for, and chmod can only
 * toggle read-only. The rest of the calling test still runs there; only this one claim is dropped.
 */
export function expectPosixMode(statMode: number, expected: number): void {
  if (process.platform === 'win32') return;
  expect(statMode & 0o777).toBe(expected);
}
