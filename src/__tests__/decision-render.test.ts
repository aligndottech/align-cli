// ALI-851: the TypeScript twin of align-stack's test_decision_render.py.
//
// Test List (Given/When/Then, two examples per rule per align-stack's tdd.md, which this
// CLI follows for the same reason):
// - ordinal renders, never a uuid, even when the input carries one (ALI-598)
// - a missing/invalid ordinal throws loudly rather than defaulting
// - the status flag is RETIRED for superseded/archived, CONFLICTED for conflicted, absent
//   for active - and it is FIRST in the bracket (ALI-655)
// - the bracket order is exactly status | platform | decided | by | altitude | dimension,
//   each omitted independently when absent, parsed rather than substring-matched
// - compact budget returns the index line only; full budget adds statement, rationale, cite
// - a rationale/statement under budget is never cut; one over budget is cut and elided
// - an unknown budget throws
// - the shared fixture renders byte-identical to its own recorded `expected` field (the
//   cross-language pin: align-stack's test_decision_render.py renders the SAME fixture
//   content and pins the SAME expected strings, so both sides agreeing with one golden is
//   how the two languages are proven to agree with each other)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FULL_RATIONALE_TOKEN_BUDGET,
  FULL_STATEMENT_TOKEN_BUDGET,
  type RenderableDecision,
  renderDecision,
} from '../lib/decision-render.js';
import { estimateTokens } from '../lib/token-estimate.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'decision-render-fixture.json',
);

const UUID_CANDIDATE = '965c223d-228f-4fdf-8626-080ba84cc1ed';

function minimal(overrides: Partial<RenderableDecision> = {}): RenderableDecision {
  return { ordinal: 1, title: 'Use Postgres for the job queue', ...overrides };
}

describe('renderDecision - ordinal never a uuid (ALI-598)', () => {
  it('renders the ordinal, not the id', () => {
    const out = renderDecision(minimal({ id: UUID_CANDIDATE }), { budget: 'compact' });
    expect(out.startsWith('1. ')).toBe(true);
  });

  it('a uuid present on the input never appears in the output', () => {
    // Positive control: the candidate line still renders real content, so a change that
    // dropped the candidate entirely would not also pass this test.
    const out = renderDecision(minimal({ id: UUID_CANDIDATE, cite: 'align-stack#1742' }), {
      budget: 'full',
    });
    expect(out).toContain('Use Postgres');
    expect(out).not.toContain(UUID_CANDIDATE);
  });
});

describe('renderDecision - ordinal validation', () => {
  it('throws when ordinal is missing', () => {
    const bad = { title: 'no ordinal' } as unknown as RenderableDecision;
    expect(() => renderDecision(bad, { budget: 'compact' })).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity])('throws when ordinal is %s', (ordinal) => {
    expect(() => renderDecision(minimal({ ordinal }), { budget: 'compact' })).toThrow();
  });

  it('throws when ordinal is a string, not just a non-integer number', () => {
    const bad = minimal({ ordinal: '1' as unknown as number });
    expect(() => renderDecision(bad, { budget: 'compact' })).toThrow();
  });
});

describe('renderDecision - budget validation', () => {
  it('throws naming the bad value', () => {
    expect(() =>
      renderDecision(minimal(), { budget: 'bogus' as unknown as 'compact' }),
    ).toThrow(/bogus/);
  });
});

describe('renderDecision - status flag', () => {
  it.each([
    ['superseded', 'RETIRED'],
    ['archived', 'RETIRED'],
    ['conflicted', 'CONFLICTED'],
    ['active', null],
    [null, null],
  ] as const)('status=%s -> flag %s', (status, expectedFlag) => {
    const out = renderDecision(minimal({ status, platform: 'jira' }), { budget: 'full' });
    const bracket = out.split('\n')[0].split('[')[1].replace(/\]$/, '');
    const parts = bracket.split('|').map((p) => p.trim());
    if (expectedFlag === null) {
      expect(parts).not.toContain('RETIRED');
      expect(parts).not.toContain('CONFLICTED');
    } else {
      expect(parts[0]).toBe(expectedFlag);
    }
  });

  it('is first when platform and altitude are also present (ALI-655)', () => {
    const out = renderDecision(
      minimal({ status: 'superseded', platform: 'jira', architectural_altitude: 'mission-critical' }),
      { budget: 'full' },
    );
    const bracket = out.split('\n')[0].split('[')[1].replace(/\]$/, '');
    expect(bracket.split('|')[0].trim()).toBe('RETIRED');
  });
});

describe('renderDecision - bracket order is parsed, not substring-matched', () => {
  it('every field present renders in the exact order', () => {
    const out = renderDecision(
      minimal({
        status: 'superseded',
        platform: 'jira',
        decided_at: '2026-08-01T10:00:00Z',
        author: 'Jane Doe',
        architectural_altitude: 'mission-critical',
        dimension: 'infra: max_tokens=4096',
      }),
      { budget: 'full' },
    );
    const firstLine = out.split('\n')[0];
    expect(firstLine.startsWith('1. Use Postgres for the job queue [')).toBe(true);
    const bracket = firstLine.split('[')[1].replace(/\]$/, '');
    const parts = bracket.split('|').map((p) => p.trim());
    expect(parts).toEqual([
      'RETIRED',
      'jira',
      'decided 2026-08-01',
      'by Jane Doe',
      'mission-critical',
      'infra: max_tokens=4096',
    ]);
  });

  it('omits altitude and dimension when absent, and still parses', () => {
    const out = renderDecision(
      minimal({ status: 'active', platform: 'slack', decided_at: '2026-07-01T00:00:00Z', author: 'Bob' }),
      { budget: 'full' },
    );
    const firstLine = out.split('\n')[0];
    const bracket = firstLine.split('[')[1].replace(/\]$/, '');
    const parts = bracket.split('|').map((p) => p.trim());
    expect(parts).not.toContain('');
    expect(parts).toEqual(['slack', 'decided 2026-07-01', 'by Bob']);
  });

  it('renders no bracket at all when nothing qualifies', () => {
    const out = renderDecision(minimal(), { budget: 'full' });
    const firstLine = out.split('\n')[0];
    expect(firstLine).toBe('1. Use Postgres for the job queue');
    expect(firstLine).not.toContain('[');
  });
});

describe('renderDecision - decided_at parsing matches the Python twin (MISSING on unparseable)', () => {
  it.each(['not-a-date', '', '   ', '2026-13-45'])(
    'omits the decided fact for %j (already-invalid shape or calendar)',
    (decidedAt) => {
      const out = renderDecision(minimal({ decided_at: decidedAt, platform: 'jira' }), { budget: 'full' });
      expect(out.split('\n')[0]).not.toContain('decided');
    },
  );

  it.each(['12345', '0'])(
    'omits the decided fact for %j, which a bare `new Date()` parses as a real (wrong) date',
    (decidedAt) => {
      // Regression: new Date("12345") silently succeeds as year 12345 and new Date("0") as
      // year 2000 - neither looks like an ISO date, and Python's fromisoformat rejects both.
      const out = renderDecision(minimal({ decided_at: decidedAt, platform: 'jira' }), { budget: 'full' });
      expect(out.split('\n')[0]).not.toContain('decided');
    },
  );

  it('renders the decided fact for a real ISO date', () => {
    const out = renderDecision(minimal({ decided_at: '2026-08-01T10:00:00Z', platform: 'jira' }), {
      budget: 'full',
    });
    expect(out.split('\n')[0]).toContain('decided 2026-08-01');
  });
});

describe('renderDecision - budget presets', () => {
  it('compact is the index line only', () => {
    const out = renderDecision(
      minimal({
        status: 'conflicted',
        platform: 'github',
        summary: 'A very long statement that must not appear in compact.',
      }),
      { budget: 'compact' },
    );
    expect(out).not.toContain('\n');
    expect(out).not.toContain('A very long statement');
  });

  it('full adds statement, rationale and cite', () => {
    const out = renderDecision(
      minimal({
        summary: 'We will use SKIP LOCKED instead of adding Redis.',
        decision_json: { ai: { rationale: 'Reduces operational complexity.' } },
        cite: 'align-stack#1742',
      }),
      { budget: 'full' },
    );
    const lines = out.split('\n');
    expect(lines.some((ln) => ln.includes('SKIP LOCKED'))).toBe(true);
    expect(lines.some((ln) => ln.includes('Reduces operational complexity'))).toBe(true);
    expect(lines[lines.length - 1].trim()).toBe('align-stack#1742');
  });

  it('omits the cite line when absent', () => {
    const out = renderDecision(minimal({ summary: 'short' }), { budget: 'full' });
    expect(out).not.toContain('align-stack#');
  });
});

describe('renderDecision - elision', () => {
  it('a short rationale is never cut', () => {
    const rationale = 'A short rationale under two hundred characters, well inside budget.';
    expect(rationale.length).toBeLessThan(200);
    const out = renderDecision(minimal({ decision_json: { ai: { rationale } } }), { budget: 'full' });
    expect(out).toContain(rationale);
    expect(out).not.toContain('...');
  });

  it('a long rationale is cut under budget and elided', () => {
    const rationale = 'x'.repeat(6000);
    const out = renderDecision(minimal({ decision_json: { ai: { rationale } } }), { budget: 'full' });
    const rationaleLine = out.split('\n').find((ln) => ln.trim().startsWith('Rationale:'))!;
    expect(rationaleLine.trimEnd().endsWith('...')).toBe(true);
    expect(estimateTokens(rationaleLine)).toBeLessThanOrEqual(FULL_RATIONALE_TOKEN_BUDGET + 10);
  });

  it('the capped rationale body itself never estimates over its own token budget', () => {
    // Regression for a float round-trip bug: charsForTokens(110) -> 256 chars, but
    // estimateTokens(256) -> 111, one over. Assert the tight invariant directly on the
    // capped text (not the whole "   Rationale: ..." line, which has an unrelated prefix
    // padding out the +10 slack above and could hide the same bug reappearing).
    const rationale = 'z'.repeat(2000);
    const out = renderDecision(minimal({ decision_json: { ai: { rationale } } }), { budget: 'full' });
    const rationaleLine = out.split('\n').find((ln) => ln.trim().startsWith('Rationale:'))!;
    const capped = rationaleLine.replace(/^\s*Rationale:\s*/, '');
    expect(estimateTokens(capped)).toBeLessThanOrEqual(FULL_RATIONALE_TOKEN_BUDGET);
  });

  it('a short statement is never cut', () => {
    const summary = 'A short statement.';
    const out = renderDecision(minimal({ summary }), { budget: 'full' });
    expect(out).toContain(summary);
    expect(out).not.toContain('...');
  });

  it('a long statement is cut under budget and elided', () => {
    const summary = 'y'.repeat(6000);
    const out = renderDecision(minimal({ summary }), { budget: 'full' });
    const statementLine = out.split('\n')[1];
    expect(statementLine.trimEnd().endsWith('...')).toBe(true);
    expect(estimateTokens(statementLine)).toBeLessThanOrEqual(FULL_STATEMENT_TOKEN_BUDGET + 10);
  });
});

interface FixtureCase {
  name: string;
  decision: RenderableDecision;
  expected: Record<string, string>;
}

describe('renderDecision - shared fixture golden parity (cross-language pin)', () => {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const data = JSON.parse(raw) as { cases: FixtureCase[] };

  it('the fixture loads and is non-empty (positive control)', () => {
    expect(data.cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const testCase of data.cases) {
    for (const [budget, expected] of Object.entries(testCase.expected)) {
      it(`${testCase.name} [${budget}] matches the shared golden`, () => {
        const actual = renderDecision(testCase.decision, { budget: budget as 'compact' | 'full' });
        expect(actual).toBe(expected);
      });
    }
  }
});
