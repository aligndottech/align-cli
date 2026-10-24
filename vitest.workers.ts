// Worker cap for `vitest run`, kept out of vitest.config.ts so a test can import it: loading
// `vitest/config` inside a test pulls in rollup's native binary, which a faked platform cannot satisfy.
// Windows runs fewer workers because every local-graph commit fsyncs and the workers share one disk.
// undefined leaves vitest's own default (cpus - 1), which is what Linux and macOS keep. The cap never
// RAISES the default: on a 2-core runner the default is already 1 and stays 1.
export function maxWorkersFor(platform: string, cpus: number): number | undefined {
  return platform === 'win32' ? Math.max(1, Math.min(2, cpus - 1)) : undefined;
}
