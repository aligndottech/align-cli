/**
 * The instructions for making a read-only token, as one note (David, 14 Oct: setup felt harder than it should).
 *
 * Align never reuses a token that can write, even one the user's own CLI holds: it would hold a credential that
 * can change their repos while promising to only read. So the note gives one short reason (when a CLI token was
 * refused) and three steps. The link is printed by the caller just before, so it is not repeated here.
 */
export function readOnlyTokenNote(opts: { cliLabel?: string; refused?: string }): string[] {
  const reason = opts.cliLabel && opts.refused
    ? [`${opts.cliLabel}: ${opts.refused}. Align uses a read-only token instead.`]
    : [];
  return [
    ...reason,
    'Make a read-only token in your browser:',
    '  1. Click Generate token. Everything is already pre-selected as read-only.',
    '  2. Copy the token it shows.',
    '  3. Paste it below.',
  ];
}
