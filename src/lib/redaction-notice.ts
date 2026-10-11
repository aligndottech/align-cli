/**
 * How many secrets this run replaced before writing to the local graph, so the person is told ONCE
 * per run rather than once per item (an import of 5,000 items must not print 5,000 lines).
 *
 * Process-wide on purpose: one CLI process is one run. ingestOne adds to it; cli.ts prints the
 * notice after the command (postAction) and index.ts on exit as a fallback for a command that
 * exits early. Taking the notice resets the count, so the two cannot both print it. The MCP server
 * is one long run, so align_capture reports its own count in the tool result instead.
 */
let pending = 0;

export function noteRedacted(n: number): void {
  if (n > 0) pending += n;
}

export function redactionNoticeText(n: number): string {
  return `Align replaced ${n} secret${n === 1 ? '' : 's'} (keys, tokens, passwords, private keys) with placeholders such as <GITHUB_TOKEN> before saving to your local graph. The raw values were not stored.`;
}

/** The notice for everything redacted since the last call, or null when nothing was. */
export function takeRedactionNotice(): string | null {
  if (pending === 0) return null;
  const n = pending;
  pending = 0;
  return redactionNoticeText(n);
}

/** Print the notice once if there is one. Used by cli.ts after the command and by index.ts on exit. */
export function printRedactionNotice(write: (line: string) => void = (l) => console.error(l)): void {
  const notice = takeRedactionNotice();
  if (notice !== null) write(notice);
}
