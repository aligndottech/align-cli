import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before every test file. The CLI resolves its config and graph directories
    // through env-paths at call time, and both migrations fire from inside
    // createConfigStore()/getLocalDbPath() before any mock can intervene - so without
    // this the suite copies the developer's own config.json and local.db. See that file
    // for why isolating the environment beats a NODE_ENV branch in production code, and
    // home-isolation.test.ts for the guard that keeps this line here.
    setupFiles: ['./src/__tests__/setup/isolate-home.ts'],
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
