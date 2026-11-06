import { describe, expect, it } from 'vitest';
import { failureTail } from '../lib/agent/failure-tail.js';

describe('failureTail', () => {
  it('keeps the exit code and the last lines of a string result', () => {
    expect(failureTail('Exit code 1\nline a\nline b\nline c\nError: Cannot find module avvio')).toBe('line b\nline c\nError: Cannot find module avvio');
  });
  it('reads a list of text blocks', () => {
    expect(failureTail([{ type: 'text', text: 'Exit code 1' }, { type: 'text', text: 'boom' }])).toBe('Exit code 1\nboom');
  });
  it('reads an object that holds the blocks under content', () => {
    expect(failureTail({ content: [{ type: 'text', text: 'Command exited with code 2' }] })).toBe('Command exited with code 2');
  });
  it('cuts a very long line', () => {
    const out = failureTail('x'.repeat(500))!;
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });
  it.each([[undefined], [''], ['\n  \n'], [{}], [[]], [42]])('says nothing when there is no text (%j)', (v) => {
    expect(failureTail(v)).toBeUndefined();
  });
});
