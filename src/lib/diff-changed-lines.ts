/**
 * The lines a unified diff changes, with nothing else: the removed lines then the added ones, each
 * without its +/- marker. No file header, no hunk header, no context lines.
 *
 * `align check` embeds the whole diff, and that text is mostly the file's own name and the lines around
 * the change, which sit next to every commit that touched the file. The edit hook embeds only what the
 * edit replaces and writes, and found decisions the diff buried. This is that same text, taken from a
 * diff. Empty when the diff has no changed lines (a pure rename, a mode change).
 */
export function changedLinesOf(diff: string): string {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return [...removed, ...added].join('\n').trim();
}
