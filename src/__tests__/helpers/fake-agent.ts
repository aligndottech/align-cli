/**
 * A fake agent binary the launch e2e tests put on PATH, runnable on every platform.
 *
 * The recorder is a node script, so what it writes is identical everywhere. Only the thin
 * launcher differs, and it matches what a real install looks like: an executable `sh` script
 * on POSIX, and `<name>.cmd` on Windows, which is exactly what an npm global install gives
 * (`claude.cmd`, `pi.cmd`). That keeps the Windows leg honest: findOnPath resolves the shim
 * through PATHEXT and runAgent spawns it through `cmd.exe /d /s /c`, the production path.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Join PATH entries with the platform's own delimiter (":" splits a drive letter on Windows). */
export function prependPath(dir: string, existing: string | undefined): string {
  return `${dir}${path.delimiter}${existing ?? ''}`;
}

/**
 * Write the fake into `bin`. `recordBody` is a JS expression yielding the object to record,
 * evaluated with `args` (the argv the agent got) and `env` in scope; it is written to `record`.
 * The fake exits with `exitCode`.
 */
export function writeFakeAgent(bin: string, name: string, opts: { record: string; recordBody: string; exitCode: number }): string {
  const js = path.join(bin, `${name}-recorder.cjs`);
  writeFileSync(js, `const args = process.argv.slice(2); const env = process.env;
require('fs').writeFileSync(${JSON.stringify(opts.record)}, JSON.stringify(${opts.recordBody}));
process.exit(${opts.exitCode});
`);
  if (process.platform === 'win32') {
    const shim = path.join(bin, `${name}.cmd`);
    // Plain CRLF batch: run the recorder and let its exit code be the shim's.
    writeFileSync(shim, `@echo off\r\nnode "${js}" %*\r\n`);
    return shim;
  }
  const script = path.join(bin, name);
  writeFileSync(script, `#!/bin/sh\nexec node "${js}" "$@"\n`);
  chmodSync(script, 0o755);
  return script;
}
