import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
      // Ratchet floor - raise over time. Set safely below current so CI gates
      // without flaking. (lines/statements ~53%, branches ~77%, functions ~77% today,
      // after the ALI-160 first-run launch-blocker fixes + tests.)
      thresholds: {
        statements: 50,
        branches: 72,
        functions: 73,
        lines: 50,
      },
    },
  },
});
