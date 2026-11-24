/**
 * Local mode's on-device embeddings run Microsoft's native ONNX Runtime, which is built against glibc. On a musl
 * system (Alpine, e.g. node:22-alpine) the loader fails with a dynamic-loader error naming ld-linux-x86-64.so.2,
 * which reads as a broken install. These helpers let local mode say what is wrong and what to change instead (#720).
 * Alpine is not supported: the fix is a glibc-based image.
 */

interface ProcessReport { header?: { glibcVersionRuntime?: string } }

function readReport(): ProcessReport | undefined {
  try {
    return (process as unknown as { report?: { getReport(): ProcessReport } }).report?.getReport();
  } catch {
    return undefined;
  }
}

/**
 * True on Linux when Node itself runs on musl. Node's process report carries `glibcVersionRuntime` only when it is
 * linked against glibc. The platform is checked first and the report (which walks native state) is read only on Linux.
 * An unreadable report is NOT taken as musl: a wrong guess would block a machine that works.
 */
export function isMuslLinux(platform: string = process.platform, report: () => ProcessReport | undefined = readReport): boolean {
  if (platform !== 'linux') return false;
  const r = report();
  if (!r?.header) return false;
  return r.header.glibcVersionRuntime === undefined;
}

/** The Linux dynamic loader's own wording. Case-sensitive and Linux-only: a macOS dyld "Symbol not found" is not one. */
const LOADER_FAILURE = /ld-linux-|ld-musl|Error loading shared library|Error relocating/;
const OLD_GLIBC = /version `GLIBC_(\d+(?:\.\d+)*)' not found/;

export function isLoaderFailure(message: string, platform: string = process.platform): boolean {
  return platform === 'linux' && LOADER_FAILURE.test(message);
}

/** The runtime was built against a newer glibc than this system has. */
export function isOldGlibc(message: string, platform: string = process.platform): boolean {
  return platform === 'linux' && OLD_GLIBC.test(message);
}

export function glibcTooOldMessage(detail: string): string {
  const need = OLD_GLIBC.exec(detail)?.[1];
  return `Local mode needs glibc ${need ?? 'a newer version'} or newer: this system's C library is too old for its on-device embedding runtime (ONNX Runtime). `
    + 'Run it on a newer image instead, for example node:22-bookworm-slim (Debian), or use cloud mode (`align login`). '
    + `(${detail})`;
}

/** One message for both ways of finding out (checked up front, or the loader failed), so the advice cannot drift. */
export function glibcRequiredMessage(detail?: string): string {
  const advice = 'Local mode needs a glibc-based Linux: its on-device embedding runtime (ONNX Runtime) does not load on musl systems such as Alpine. '
    + 'Run it on a glibc image instead, for example node:22-bookworm-slim (Debian), or use cloud mode (`align login`).';
  return detail ? `${advice} (${detail})` : advice;
}
