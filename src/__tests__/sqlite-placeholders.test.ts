import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Node 22.16 (the CI floor) binds numbered SQLite placeholders (?1, ?2) wrongly: the statement fails with
 * "column index out of range" where Node 24 accepts it. A suite on one Node cannot see that, so this test reads
 * the source instead: no SQL string under src/lib or src/commands may use one. Use `?` and bind each value.
 */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}
const NUMBERED = /[\s(=,]\?\d+\b/;

describe('SQL placeholders', () => {
  const root = path.resolve(__dirname, '..');
  const files = [...walk(path.join(root, 'lib')), ...walk(path.join(root, 'commands'))];

  it('the sweep reads real source (positive control)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /judgements-db\.ts$/.test(f))).toBe(true);
  });
  it('the pattern catches a numbered placeholder and passes an anonymous one', () => {
    expect(NUMBERED.test('WHERE a = ?1 AND (?2 IS NULL)')).toBe(true);
    expect(NUMBERED.test('WHERE a = ? AND (? IS NULL)')).toBe(false);
  });
  it('no source file uses a numbered placeholder', () => {
    const hits = files.filter((f) => NUMBERED.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(root, f))).toEqual([]);
  });
});
