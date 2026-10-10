import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default 5 s is right for Linux and macOS. The Windows runner opens and commits to the local graph an order of
    // magnitude slower (fsync per commit) and runs two workers on two cores, so ordinary DB tests there take 6-15 s and a
    // different handful timed out on every run (22 on main, then a different 4 once those were fixed). One platform-scaled
    // default beats a per-file number that the next slow test needs again. Tests that need more still set their own.
    testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
    // L6: the launcher starts a detached `align sync` for a due source. No test may start a real one from a developer's own state directory.
    env: { ALIGN_NO_SYNC: '1' },
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
