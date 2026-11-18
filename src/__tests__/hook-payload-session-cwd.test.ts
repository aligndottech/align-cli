import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readSessionStartCwd } from '../lib/hook-payload.js';

const stream = (payload: unknown): Readable => Readable.from([JSON.stringify(payload)]);

// Test List: cwd wins over workspace_roots; Cursor's payload (no cwd) uses the first root;
// an empty, non-string or absent root list gives null, so the caller falls back to process cwd.
describe('readSessionStartCwd', () => {
  it('reads cwd', async () => {
    expect(await readSessionStartCwd(stream({ cwd: '/a' }))).toBe('/a');
  });
  it('prefers cwd over workspace_roots when both are present', async () => {
    expect(await readSessionStartCwd(stream({ cwd: '/a', workspace_roots: ['/b'] }))).toBe('/a');
  });
  it('uses the first workspace root when there is no cwd (Cursor)', async () => {
    expect(await readSessionStartCwd(stream({ workspace_roots: ['/b', '/c'] }))).toBe('/b');
  });
  it.each([[[]], [[7]], [['']], ['/b'], [null]])('returns null for workspace_roots %j', async (roots) => {
    expect(await readSessionStartCwd(stream({ workspace_roots: roots }))).toBeNull();
  });
});
