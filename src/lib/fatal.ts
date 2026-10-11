/**
 * What the last-resort handler in index.ts prints and exits with. A usage mistake the user can
 * fix by retyping (an unknown --env) is exit 2 with only its message: a "report it at ..."
 * footer on it sends people to file a bug for their own typo.
 */
export function describeFatal(err: unknown, debug: boolean): { lines: string[]; code: number; stack?: Error } {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === 'UnknownEnvError') return { lines: [`\nalign: ${e.message}\n`], code: 2 };
  if (debug) return { lines: [], code: 1, stack: e };
  return {
    lines: [
      `\nalign: ${e.message}\n`,
      'Run with ALIGN_DEBUG=1 for the full stack trace, or report it at',
      'https://github.com/aligndottech/align-cli/issues',
    ],
    code: 1,
  };
}
