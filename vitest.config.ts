import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
