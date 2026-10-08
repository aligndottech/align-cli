import { describe, expect, it } from 'vitest';

import { shapeDecisionRationale } from '../lib/mcp-timeline-tools.js';

/**
 * ALI-1465. #335 (ALI-1426) made `goals` take the first non-empty list across the top level
 * of decision_json and `ai`. `risks` and `alternatives_considered` still used `??`, so an
 * empty top-level `[]` hid a populated `ai` list. All three now share one helper.
 *
 * Test list, for risks AND for alternatives_considered:
 *  - top level `[]`, ai holds a distinct value -> the ai value
 *  - top level non-empty, ai non-empty -> the top level wins
 *  - both absent -> []
 *  - a non-array top level -> falls through to ai
 *
 * Shapes are preserved: risks are strings, alternatives are objects (with a string entry
 * mixed in), returned as stored.
 */

const run = (decisionJson: Record<string, unknown>) =>
  shapeDecisionRationale(
    {
      id: 'd-1465',
      title: 'Pin the retry budget at three attempts',
      summary: 'Retries are capped so a dead provider fails fast.',
      status: 'active',
      platform: 'github',
      created_at: '2026-10-08T10:00:00.000Z',
      decision_json: decisionJson,
    },
    'd-1465',
  );

const AI_RISKS = ['A slow provider exhausts the budget before it recovers'];
const TOP_RISKS = ['Callers retry on top of us and multiply the load'];
const AI_ALTS = [
  { option: 'Unbounded retries with backoff', rejected_because: 'no upper bound on latency' },
  'Fail on first error',
];
const TOP_ALTS = [{ option: 'Circuit breaker only', rejected_because: 'too coarse per call' }];

describe('shapeDecisionRationale risks, alternatives_considered and positions_considered (ALI-1465)', () => {
  const cases = [
    { field: 'risks', top: TOP_RISKS, ai: AI_RISKS },
    { field: 'alternatives_considered', top: TOP_ALTS, ai: AI_ALTS },
    {
      field: 'positions_considered',
      top: [{ position: 'Keep the shared token', held_by: 'platform' }],
      ai: [{ position: 'Per-connector tokens', held_by: 'security' }],
    },
  ] as const;

  for (const { field, top, ai } of cases) {
    it(`${field}: an empty top-level list yields to a populated ai list`, () => {
      expect(run({ [field]: [], ai: { [field]: ai } })[field]).toEqual(ai);
    });

    it(`${field}: a populated top level wins over ai`, () => {
      expect(run({ [field]: top, ai: { [field]: ai } })[field]).toEqual(top);
    });

    it(`${field}: both absent returns []`, () => {
      expect(run({ ai: {} })[field]).toEqual([]);
    });

    it(`${field}: a non-array top level falls through to ai`, () => {
      expect(run({ [field]: 'not a list', ai: { [field]: ai } })[field]).toEqual(ai);
    });
  }
});
