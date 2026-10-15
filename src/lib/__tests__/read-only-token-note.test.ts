import { describe, expect, it } from 'vitest';
import { readOnlyTokenNote } from '../read-only-token-note.js';

// David's setup felt harder than it should: when GitHub CLI was signed in, setup printed a refusal and a second
// instruction, and the steps to make a read-only token were spread across two messages. One note, three steps, the
// reason in one clause. Two examples: with a refused CLI token, and without one.
describe('readOnlyTokenNote', () => {
  it('after a refused CLI token: one reason clause, then three steps, the link not repeated', () => {
    const lines = readOnlyTokenNote({ cliLabel: 'GitHub CLI', refused: 'token can write (scopes: repo, workflow)' });
    expect(lines[0]).toMatch(/GitHub CLI.*read-only/i);
    expect(lines.filter((l) => /^\s*\d\./.test(l))).toHaveLength(3);
    expect(lines.join('\n')).toMatch(/pre-selected/i);
    expect(lines.join('\n')).not.toMatch(/https?:\/\//);
  });

  it('with no CLI token: the same three steps, and no mention of a refusal', () => {
    const lines = readOnlyTokenNote({});
    expect(lines.filter((l) => /^\s*\d\./.test(l))).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/refus|will not reuse|can write/i);
  });
});
