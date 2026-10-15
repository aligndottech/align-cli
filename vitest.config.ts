import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default 5 s is right for Linux and macOS. The Windows runner opens and commits to the local graph an order of
    // magnitude slower (fsync per commit) and runs two workers on two cores, so ordinary DB tests there take 6-15 s and a
    // different handful timed out on every run (22 on main, then a different 4 once those were fixed). One platform-scaled
    // default beats a per-file number that the next slow test needs again. Tests that need more still set their own.
    testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
    // ALI-1669: on win32, a parallel run of 2 worker threads on the runner's 2 cores leaves no
    // slack for vitest's own internal worker<->main-process RPC heartbeat (onTaskUpdate) to be
    // serviced in time under load, which throws "[vitest-worker]: Timeout calling 'onTaskUpdate'"
    // as an UNHANDLED error and fails the whole run even when every test passed (confirmed: a
    // run with 7039/7039 tests green still exited 1 from exactly this). That RPC round-trip's
    // timeout is internal to vitest/birpc and not configurable directly; the lever that is
    // configurable is removing the contention that makes it slow. singleThread trades wall-clock
    // time (roughly 2x on a 2-core runner) for that reliability - acceptable here because this
    // config only takes effect on win32, which already only runs cross-platform on a push to
    // main or a manual proof-before-merge dispatch (ci.yaml), never on every PR.
    poolOptions: process.platform === 'win32' ? { threads: { singleThread: true } } : undefined,
    // L6: the launcher starts a detached `align sync` for a due source. No test may start a real one from a developer's own state directory.
    env: { ALIGN_NO_SYNC: '1', ALIGN_NO_TRUSTED_BIN: '1' },
    // No test may read or write the developer's real home folder (~/.claude, ~/.config/align-cli, ~/.local/state).
    // This points HOME at a temp folder before any test module is imported; see helpers/isolated-home.ts.
    setupFiles: ['src/__tests__/helpers/isolated-home.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
      // Ratchet floor - raise over time. Set safely below current so CI gates
      // without flaking. (lines/statements ~55.6%, branches ~77%, functions ~77.6%
      // today, after the ALI-161 MCP-dispatch + login-flow coverage.)
      thresholds: {
        statements: 53,
        branches: 74,
        functions: 75,
        lines: 53,
      },
    },
  },
});
