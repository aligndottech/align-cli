/**
 * Reading ADR Guard's relationships export (github.com/rodri-oliveira-dev/adr-guard, v1.12.0,
 * `adr-guard export relationships`, contract docs/adr-relationships-export-v1.md). The documents
 * below follow the shapes of that contract's own examples (docs/examples/adr-relationships-export-v1).
 *
 * Test List:
 * 1. a resolved superseded-by is one replacement: the target replaces the source
 * 2. a resolved supersedes is the same replacement read the other way
 * 3. reciprocal declarations of one replacement give one pair, not two
 * 4. an unresolved or ambiguous target is never a pair; it is counted
 * 5. an error ADR Guard reports on either ADR holds the pair back; an error on an unrelated ADR does not
 * 6. depends-on is counted and not recorded as a replacement
 * 7. schema 1.x is read; another major, a missing version, or a file that is not an export is refused
 * 8. a path that is not portable and repository-relative is refused
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdrGuardFileError, parseAdrGuardExport, readAdrGuardExport } from '../../lib/fetchers/adr-guard.js';

const adr = (n: number, slug: string, status: string | null = 'Accepted') => ({
  identifier: `ADR-${n}`, path: `docs/adr/000${n}-${slug}.md`, title: slug, status,
});
const rel = (from: ReturnType<typeof adr>, type: string, to: ReturnType<typeof adr> | null, resolution = 'resolved') => ({
  sourceIdentifier: from.identifier, sourcePath: from.path, type,
  declaredTarget: to ? to.path.split('/').pop() : '0099-missing.md',
  targetIdentifier: to && resolution === 'resolved' ? to.identifier : null,
  targetPath: to && resolution === 'resolved' ? to.path : null,
  resolution,
});
const doc = (adrs: unknown[], relationships: unknown[], issues: unknown[] = [], schemaVersion: unknown = '1.0') =>
  ({ schemaVersion, adrs, relationships, issues });

const OLD = adr(1, 'legacy-storage', 'Superseded');
const NEW = adr(2, 'managed-storage');
const ENC = adr(3, 'encryption');

describe('parseAdrGuardExport', () => {
  it('reads a resolved superseded-by as the target replacing the source', () => {
    const read = parseAdrGuardExport(doc([OLD, NEW, ENC], [rel(OLD, 'superseded-by', NEW)]));
    expect(read.replacements).toEqual([{ newer: NEW.path, older: OLD.path }]);
  });

  it('reads a resolved supersedes as the source replacing the target', () => {
    const read = parseAdrGuardExport(doc([OLD, NEW], [rel(NEW, 'supersedes', OLD)]));
    expect(read.replacements).toEqual([{ newer: NEW.path, older: OLD.path }]);
  });

  it('gives one pair for a replacement both ADRs declare', () => {
    const read = parseAdrGuardExport(doc([OLD, NEW], [rel(OLD, 'superseded-by', NEW), rel(NEW, 'supersedes', OLD)]));
    expect(read.replacements).toEqual([{ newer: NEW.path, older: OLD.path }]);
  });

  it('never pairs an unresolved or ambiguous target, and counts them', () => {
    const read = parseAdrGuardExport(doc([OLD, NEW], [
      rel(OLD, 'superseded-by', null, 'unresolved'),
      rel(NEW, 'supersedes', OLD, 'ambiguous'),
      rel(OLD, 'superseded-by', NEW),
    ]));
    expect(read.replacements).toEqual([{ newer: NEW.path, older: OLD.path }]);
    expect(read.unresolved).toBe(2);
  });

  it('holds a pair back when ADR Guard reports an error on either ADR, and only then', () => {
    const cycle = [rel(OLD, 'superseded-by', NEW), rel(NEW, 'superseded-by', OLD)];
    const errorOn = (path: string) => ({ code: 'ADR010', message: 'cycle', path, severity: 'error' });
    const held = parseAdrGuardExport(doc([OLD, NEW], cycle, [errorOn(OLD.path), errorOn(NEW.path)]));
    expect(held.replacements).toEqual([]);
    expect(held.heldBack).toBe(2);
    // Control: an error on an ADR outside the pair (an invalid status elsewhere) leaves the pair in.
    const other = adr(5, 'invalid-status', null);
    const kept = parseAdrGuardExport(doc([OLD, NEW, other], [rel(OLD, 'superseded-by', NEW)], [errorOn(other.path)]));
    expect(kept.replacements).toEqual([{ newer: NEW.path, older: OLD.path }]);
    expect(kept.heldBack).toBe(0);
    // A warning is not an error.
    const warned = parseAdrGuardExport(doc([OLD, NEW], [rel(OLD, 'superseded-by', NEW)], [{ ...errorOn(OLD.path), severity: 'warning' }]));
    expect(warned.replacements).toHaveLength(1);
  });

  // A replaces B and B replaces A cannot both be true. ADR Guard reports this as a cycle; the reader does
  // not rely on that report being present.
  it('holds back a pair declared in both directions even when no issue says so', () => {
    const read = parseAdrGuardExport(doc([OLD, NEW], [rel(OLD, 'superseded-by', NEW), rel(OLD, 'supersedes', NEW)]));
    expect(read.replacements).toEqual([]);
    expect(read.heldBack).toBe(2);
  });

  it('counts depends-on and records no replacement for it', () => {
    const read = parseAdrGuardExport(doc([NEW, ENC], [rel(NEW, 'depends-on', ENC)]));
    expect(read.replacements).toEqual([]);
    expect(read.dependsOn).toBe(1);
  });

  it('reads any 1.x schema and refuses another major, a missing version, or something else', () => {
    expect(parseAdrGuardExport(doc([OLD, NEW], [rel(OLD, 'superseded-by', NEW)], [], '1.3')).replacements).toHaveLength(1);
    expect(() => parseAdrGuardExport(doc([], [], [], '2.0'))).toThrow(AdrGuardFileError);
    expect(() => parseAdrGuardExport({ adrs: [], relationships: [], issues: [] })).toThrow(AdrGuardFileError);
    expect(() => parseAdrGuardExport({ adrs: [] })).toThrow(AdrGuardFileError);
    expect(() => parseAdrGuardExport([])).toThrow(AdrGuardFileError);
    expect(parseAdrGuardExport(doc([], [])).replacements).toEqual([]);
  });

  it('refuses a path that is not repository-relative', () => {
    const outside = { ...NEW, path: '../elsewhere/0002.md' };
    expect(() => parseAdrGuardExport(doc([OLD, outside], [rel(OLD, 'superseded-by', outside)]))).toThrow(AdrGuardFileError);
    const absolute = { ...NEW, path: '/etc/0002.md' };
    expect(() => parseAdrGuardExport(doc([OLD, absolute], [rel(OLD, 'superseded-by', absolute)]))).toThrow(AdrGuardFileError);
  });
});

describe('readAdrGuardExport', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reads the file, and names it when it is missing or not JSON', async () => {
    dir = mkdtempSync(join(tmpdir(), 'align-adrguard-'));
    const file = join(dir, 'relationships.json');
    writeFileSync(file, JSON.stringify(doc([OLD, NEW], [rel(OLD, 'superseded-by', NEW)])));
    expect((await readAdrGuardExport(file)).replacements).toHaveLength(1);
    await expect(readAdrGuardExport(join(dir, 'nope.json'))).rejects.toThrow(/nope\.json/);
    writeFileSync(file, '{not json');
    await expect(readAdrGuardExport(file)).rejects.toThrow(AdrGuardFileError);
  });
});
