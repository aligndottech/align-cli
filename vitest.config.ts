import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
      // Ratchet floor - raise over time. Set safely below current so CI gates
      // without flaking. (lines ~47%, branches ~76%, functions ~76% today.)
      thresholds: {
        statements: 45,
        branches: 70,
        functions: 70,
        lines: 45,
      },
    },
  },
});
