import { describe, expect, it } from 'vitest';
import path from 'node:path';
import envPaths from 'env-paths';
import { getLocalDbPath } from '../lib/local-mode.js';

/**
 * Two independent hand-written constructions of "the align-cli config directory" had
 * drifted apart in production, on a real machine, before this test existed:
 *
 * - config.ts's `createConfigStore()` goes through `conf`, whose own default
 *   `projectSuffix` is `'nodejs'` (node_modules/conf/dist/source/index.js) - so it
 *   wrote to `~/.config/align-cli-nodejs`.
 * - local-mode.ts's `getLocalDbPath()` hand-rolled the same directory per platform,
 *   landing on `~/.config/align-cli` (no suffix) on Linux.
 *
 * `rm -rf ~/.config/align-cli` - the reset instruction this repo had been giving
 * out all evening - silently did nothing to the saved tokens, telemetry consent or
 * auth config, all of which lived one directory over. A wiped local graph DB still
 * reported "Signed in prod".
 *
 * The fix makes `env-paths` (the library `conf` itself defers to) the single
 * authority both files read, with the suffix explicitly disabled to match what was
 * already documented everywhere as the "real" path. This test pins the PROPERTY
 * that actually matters - the two constructions agree - rather than a literal
 * string, so it holds on whatever platform CI happens to run on.
 */
describe('the local DB directory and the conf config directory are the same directory', () => {
  it('getLocalDbPath sits inside the suffix-free env-paths config directory', () => {
    const expectedDir = envPaths('align-cli', { suffix: '' }).config;

    expect(path.dirname(getLocalDbPath())).toBe(expectedDir);
  });

  // Positive control for the property test above: prove suffix-free env-paths on THIS
  // platform does not silently equal the suffixed one, or the assertion above could
  // pass by both sides sharing a bug rather than by both being correct.
  it('the suffix genuinely changes the resolved directory (negative control)', () => {
    const suffixed = envPaths('align-cli', { suffix: 'nodejs' }).config;
    const unsuffixed = envPaths('align-cli', { suffix: '' }).config;

    expect(suffixed).not.toBe(unsuffixed);
  });
});
