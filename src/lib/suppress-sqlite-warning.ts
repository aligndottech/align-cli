/**
 * ALI-1779: Node 22.16 prints `ExperimentalWarning: SQLite is an experimental feature` on every
 * command, because the local graph loads `node:sqlite` (stable-ish from Node 24, still flagged
 * experimental on the 22.x floor). It is stderr noise the user cannot act on. Only that one
 * warning is dropped: any other warning, and any other ExperimentalWarning, is forwarded as is.
 * Installed before the CLI is imported, because the warning fires when `node:sqlite` loads.
 */
type EmitWarning = (warning: string | Error, ...rest: any[]) => void;

function isSqliteExperimental(warning: unknown, rest: unknown[]): boolean {
  const first = rest[0];
  const type = warning instanceof Error
    ? warning.name
    : typeof first === 'string'
      ? first
      : (first as { type?: string } | undefined)?.type;
  if (type !== 'ExperimentalWarning') return false;
  const message = warning instanceof Error ? warning.message : String(warning);
  return /^SQLite is an experimental feature/.test(message);
}

export function installSqliteWarningFilter(proc: { emitWarning: EmitWarning }): void {
  const original = proc.emitWarning;
  proc.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimental(warning, rest)) return;
    return original.call(proc, warning, ...rest);
  };
}
