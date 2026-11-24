/**
 * #719: an "aligned" from a judge that read only part of the text must say so. Test List:
 * 1. nothing cut -> no note (two shapes: all null, no cuts at all)
 * 2. a cut decision is named with characters kept of written; the window is named
 * 3. a cut proposed change is named; both are named together
 */
import { describe, expect, it } from 'vitest';
import { promptCutNote } from '../lib/prompt-cut-note.js';

const titles = ['Commit one', '22. `Str.format` is the only template surface'];

describe('promptCutNote', () => {
  it('is null when nothing was cut', () => {
    expect(promptCutNote({ windowTokens: 32_768, subject: null, candidates: [null, null] }, titles)).toBeNull();
    expect(promptCutNote(undefined, titles)).toBeNull();
  });

  it('names a cut decision with the characters kept of written, and the window', () => {
    const note = promptCutNote({ windowTokens: 8_192, subject: null, candidates: [null, { kept: 2100, total: 4174 }] }, titles)!;
    expect(note).toContain('8,192-token window');
    expect(note).toContain('"22. `Str.format` is the only template surface", 2,100 of 4,174 characters');
    expect(note).not.toContain('Commit one');
    expect(note).toMatch(/aligned[\s\S]*larger context window/i);
  });

  it('names a cut proposed change, and lists it with a cut decision', () => {
    const note = promptCutNote({ windowTokens: 4_096, subject: { kept: 0, total: 716 }, candidates: [{ kept: 0, total: 300 }, null] }, titles)!;
    expect(note).toContain('the proposed change, 0 of 716 characters');
    expect(note).toContain('"Commit one", 0 of 300 characters');
  });
});
