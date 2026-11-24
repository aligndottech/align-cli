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
 * linked against glibc. An unreadable report is NOT taken as musl: a wrong guess would block a machine that works.
 */
export function isMuslLinux(platform: string = process.platform, report: ProcessReport | undefined = readReport()): boolean {
  if (platform !== 'linux' || !report?.header) return false;
  return report.header.glibcVersionRuntime === undefined;
}

/** The dynamic loader's own wording for a native library that needs glibc, as it appears in a dlopen error. */
const LOADER_FAILURE = /ld-linux|Error loading shared library|Error relocating|symbol not found/i;

export function isLoaderFailure(message: string): boolean {
  return LOADER_FAILURE.test(message);
}

/** One message for both ways of finding out (checked up front, or the loader failed), so the advice cannot drift. */
export function glibcRequiredMessage(detail?: string): string {
  const advice = 'Local mode needs a glibc-based Linux: its on-device embedding runtime (ONNX Runtime) does not load on musl systems such as Alpine. '
    + 'Run it on a glibc image instead, for example node:22-bookworm-slim (Debian), or use cloud mode (`align login`).';
  return detail ? `${advice} (${detail})` : advice;
}
