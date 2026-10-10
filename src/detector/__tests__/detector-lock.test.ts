/**
 * detector.lock.json pins the P3 files align-stack vendors (the shared prompt, the resolver port
 * and its golden vectors). It is a separate lock from contract.lock.json so that adding these
 * files changes none of the P1 contract bytes align-stack already pins.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const detectorDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(detectorDir, 'detector.lock.json'), 'utf8')) as { files: Record<string, string> };
const FILES = ['relationship-prompt.v1.json', 'resolver-vectors.json', 'resolve-pair.ts', 'similar-item.ts', '__tests__/resolve-pair.test.ts'];

describe('detector.lock.json', () => {
  it('lists exactly the vendored P3 files', () => {
    expect(Object.keys(lock.files).sort()).toEqual([...FILES].sort());
  });

  it.each(FILES)('%s matches its pinned sha256', (file) => {
    const actual = createHash('sha256').update(readFileSync(join(detectorDir, file))).digest('hex');
    expect(actual, `${file} changed: regenerate it if it is generated, then update detector.lock.json`).toBe(lock.files[file]);
  });
});
