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
import { afterAll, beforeEach } from 'vitest';

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
