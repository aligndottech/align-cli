import { describe, expect, it } from 'vitest';
import { ttyConfirm } from '../lib/share/tty.js';

/** L9 review item 1: no interactive terminal is "null" (refuse), never a blocking read and never a yes. */
describe('ttyConfirm', () => {
  it('returns null when the paths cannot be opened, and when they open but are not terminals', async () => {
    expect(await ttyConfirm('x', 'q', ['/nonexistent/in', '/nonexistent/out'])).toBeNull();
    const devnull = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(await ttyConfirm('x', 'q', [devnull, devnull])).toBeNull(); // opens fine, is not a tty: cannot prove interactive
  });
});
