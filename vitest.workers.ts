// Worker cap for `vitest run`, kept out of vitest.config.ts so a test can import it: loading
// `vitest/config` inside a test pulls in rollup's native binary, which a faked platform cannot satisfy.
// Windows runs fewer workers because every local-graph commit fsyncs and the workers share one disk (ALI-1771).
// undefined leaves vitest's own default, which is what Linux and macOS keep.
export function maxWorkersFor(platform: string): number | undefined {
  return platform === 'win32' ? 2 : undefined;
}
