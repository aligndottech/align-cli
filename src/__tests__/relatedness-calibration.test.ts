/**
 * The retrieval floor is a measured number, and this is the measurement.
 *
 * `RELATES_THRESHOLD` was 0.30 until commit 0cbef08 raised it to 0.45 inside a rename, with no
 * mention in the message and no evidence either way. Neither value was ever checked against
 * data. Measured against the corpus in fixtures/relatedness-corpus.json:
 *
 *     0.45  recovers 3 of 8 related pairs   0 false positives
 *     0.30  recovers 7 of 8                 0 false positives
 *     0.25  recovers 7 of 8                 0 false positives
 *
 * 0.45 drops five pairs a reviewer would want, including an edit that reads the tenant from a
 * client header against a decision saying the tenant comes from the token. 0.30 and 0.25 tie on
 * accuracy, so the tie-break is margin: the worst false positive scores 0.2051, which 0.30
 * clears by 0.095 and 0.25 by only 0.045. With six negatives, the wider margin is worth more
 * than the identical recall.
 *
 * One related pair is unrecoverable at any usable floor: "switch the database to mongodb"
 * against a Postgres decision scores 0.1977, BELOW the worst unrelated pair. No threshold
 * separates it, so this file asserts 7 of 8 rather than pretending 8 is reachable. Raising
 * recall past that needs better embedding input, not a lower gate.
 *
 * The scores are recorded in the fixture so this runs offline in milliseconds. Recompute them
 * against the real model with ALIGN_CALIBRATE=1 (see the opt-in block at the bottom), which is
 * the control that stops the recorded numbers becoming folklore.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RELATES_THRESHOLD, RETRIEVAL_RELATES_THRESHOLD } from '../lib/local-gateway-client.js';

interface Pair { label: 'related' | 'unrelated'; change: string; decision: string; score: number }

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'relatedness-corpus.json'), 'utf8'),
) as { pairs: Pair[] };

const related = corpus.pairs.filter(p => p.label === 'related');
const unrelated = corpus.pairs.filter(p => p.label === 'unrelated');

const recallAt = (t: number): number => related.filter(p => p.score >= t).length;
const falsePositivesAt = (t: number): number => unrelated.filter(p => p.score >= t).length;

describe('relatedness corpus', () => {
  // Positive control on the fixture itself: a corpus that lost its scores, or that is all
  // positives, would make every assertion below vacuous.
  it('has both labels and a score on every pair', () => {
    expect(related.length).toBeGreaterThanOrEqual(8);
    expect(unrelated.length).toBeGreaterThanOrEqual(6);
    for (const p of corpus.pairs) expect(typeof p.score).toBe('number');
  });

  it('contains hard negatives, or the separation would prove nothing', () => {
    // A negative scoring above 0.15 is one that shares real vocabulary with its decision.
    // Without at least one, any floor looks perfect.
    expect(unrelated.filter(p => p.score > 0.15).length).toBeGreaterThanOrEqual(1);
  });
});

describe('RETRIEVAL_RELATES_THRESHOLD is the value the corpus supports', () => {
  it('admits no unrelated pair', () => {
    expect(falsePositivesAt(RETRIEVAL_RELATES_THRESHOLD)).toBe(0);
  });

  it('recovers at least 7 of the 8 related pairs', () => {
    expect(recallAt(RETRIEVAL_RELATES_THRESHOLD)).toBeGreaterThanOrEqual(7);
  });

  // The margin that chose 0.30 over 0.25. If a future corpus adds a negative above the floor
  // this fails, which is the point: the number is downstream of the data.
  it('clears the worst unrelated pair by at least 0.05', () => {
    const worstNoise = Math.max(...unrelated.map(p => p.score));
    expect(RETRIEVAL_RELATES_THRESHOLD - worstNoise).toBeGreaterThanOrEqual(0.05);
  });

  // The old value, kept as the reason this change exists rather than as an insult to it.
  it('recovers strictly more than the 0.45 it replaced on this surface', () => {
    expect(recallAt(RETRIEVAL_RELATES_THRESHOLD)).toBeGreaterThan(recallAt(0.45));
    expect(recallAt(0.45)).toBeLessThanOrEqual(3);
  });
});

describe('the adjudicating floor stays where it was, deliberately', () => {
  // Not lowered, and not by oversight. Stage 2 pays per candidate: up to 5 sequential calls to
  // the user's own LLM, ~11s, and a keyless CI runner that currently exits 0 on `no-context`
  // would start exiting 2 on `unknown` the moment retrieval finds anything. The classifier also
  // cannot reject a candidate - its vocabulary has ten positive members and no "unrelated" - so
  // a loose candidate reaching it is reported, not filtered.
  it('is higher than the retrieval floor', () => {
    expect(RELATES_THRESHOLD).toBeGreaterThan(RETRIEVAL_RELATES_THRESHOLD);
  });

  it('is unchanged at 0.45', () => {
    expect(RELATES_THRESHOLD).toBe(0.45);
  });
});

/**
 * The control for the recorded scores. Skipped by default because it downloads ~23MB and every
 * other test in this suite mocks the model; run it when the model, the dtype or the corpus
 * changes. It re-measures each pair and fails if a recorded score has drifted, which is what
 * keeps the numbers above honest rather than historical.
 */
describe.skipIf(!process.env['ALIGN_CALIBRATE'])('recorded scores match the real model', () => {
  it('re-measures every pair within tolerance', async () => {
    const { getEmbedding, cosineSimilarity } = await import('../lib/local-embeddings.js');
    for (const p of corpus.pairs) {
      const [a, b] = [await getEmbedding(p.change), await getEmbedding(p.decision)];
      expect(cosineSimilarity(a, b)).toBeCloseTo(p.score, 2);
    }
  }, 300_000);
});
