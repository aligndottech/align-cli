/** The line for a config Align could not read with certainty (not a foreign align-local). */
export function unreadableNote(u: { file: string; line: number; reason: string }): string {
  return `${u.file}: Align cannot be sure what line ${u.line} says (${u.reason}), so it did not add its graph for this session.`;
}
