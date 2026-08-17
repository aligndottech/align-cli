/**
 * ALI-196 spike proof: generate a decisions file WITHOUT ever parsing the user's own.
 *
 * Tom's constraint is augment, never overwrite. The mechanism chosen makes that structural
 * rather than careful: Align owns `.align/decisions.md` outright, so the worst bug it can
 * have is writing a wrong file that contains nothing of the user's. The only touch to
 * CLAUDE.md is a single idempotent append of an import line, with no parsing of what is
 * already there.
 *
 * The alternative - splicing a managed block inside CLAUDE.md - needs a marker parser, and
 * `@align/docs-pipeline` is `private: true` in a different repo, so align-cli cannot import
 * `fillGeneratedRegions`. Reimplementing it would mean a second lenient-matcher/strict-builder
 * in the world, which is the bug class that function's four guards exist to close.
 *
 * The load-bearing test here is idempotence. A file that differs between two runs against an
 * unchanged graph turns every regeneration into a git diff, and the feature becomes noise.
 */

import { describe, expect, it } from 'vitest';
import {
  ALIGN_IMPORT_LINE,
  appendImportLine,
  type ContextDecision,
  renderDecisionsFile,
} from '../lib/decisions-context.js';

const DECISIONS: ContextDecision[] = [
  { title: 'Use Postgres 16 for new services', cite: 'align-stack#1441', sourceUrl: 'https://github.com/x/y/pull/1441' },
  { title: 'Synchronous gRPC for service calls', cite: 'align-stack#1200', sourceUrl: 'https://github.com/x/y/pull/1200' },
];

const HAND_WRITTEN = `# My project

Some hand-tuned guidance nobody else may touch.

## Conventions
- tabs, not spaces
`;

describe('ALI-196 the generated file', () => {
  it('renders each decision with its source, so the file is auditable', () => {
    const out = renderDecisionsFile(DECISIONS);

    expect(out).toContain('Use Postgres 16 for new services');
    expect(out).toContain('align-stack#1441');
    // Positive control: an empty render would satisfy every "not.toContain" below.
    expect(out.length).toBeGreaterThan(0);
  });

  it('IS IDEMPOTENT: two runs over the same input are byte-identical', () => {
    // The acceptance test for the whole feature. A "generated on <date>" header is the
    // obvious thing to write and it breaks this, so the renderer carries no timestamp.
    expect(renderDecisionsFile(DECISIONS)).toBe(renderDecisionsFile(DECISIONS));
  });

  it('carries no timestamp, which is what makes the above possible', () => {
    // Pinned explicitly rather than implied, because adding one back would look harmless
    // and would only surface as a permanent diff in someone else's repo.
    expect(renderDecisionsFile(DECISIONS)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('orders deterministically regardless of the order the graph returned', () => {
    // A LIMIT with no ORDER BY, or object-key iteration upstream, would reorder the block
    // between runs and defeat idempotence without changing a single decision (tdd.md).
    const reversed = [...DECISIONS].reverse();

    expect(renderDecisionsFile(reversed)).toBe(renderDecisionsFile(DECISIONS));
  });

  it('says plainly when the graph returned nothing', () => {
    // "No decisions yet" and "the fetch failed" must not look alike. ALI-414's lesson on a
    // new surface: an empty managed block reads as "no decisions exist", which is a claim.
    const out = renderDecisionsFile([]);

    expect(out).toMatch(/no decisions/i);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('ALI-196 the one touch to the user file', () => {
  it('appends the import line and preserves every hand-written byte', () => {
    const out = appendImportLine(HAND_WRITTEN);

    expect(out).toContain(ALIGN_IMPORT_LINE);
    // The whole constraint, asserted directly: their content survives verbatim.
    expect(out.startsWith(HAND_WRITTEN)).toBe(true);
  });

  it('IS IDEMPOTENT: a second run does not add the line twice', () => {
    const once = appendImportLine(HAND_WRITTEN);
    const twice = appendImportLine(once);

    expect(twice).toBe(once);
    expect(twice.split(ALIGN_IMPORT_LINE).length - 1).toBe(1);
  });

  it('never reorders or removes anything, even in a file that already mentions align', () => {
    // A file that talks ABOUT align must not be mistaken for one that imports it.
    const mentions = `${HAND_WRITTEN}\nWe use align for decisions.\n`;

    const out = appendImportLine(mentions);

    expect(out.startsWith(mentions)).toBe(true);
    expect(out.split(ALIGN_IMPORT_LINE).length - 1).toBe(1);
  });
});
