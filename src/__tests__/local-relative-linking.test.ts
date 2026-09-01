// ALI-785: 0 of 1,729 relates edges crossed a platform boundary on a 403-decision,
// six-source corpus. Measured cause: an ABSOLUTE cosine floor of 0.65 is unreachable
// for cross-register pairs on MiniLM-L6 - near-duplicates score ~0.95, genuine
// cross-tool paraphrases ~0.45-0.62, background noise ~0.28-0.40. The lab that fixed
// the rule (embed-scheme + rank + corpus simulation, 2026-08-31) showed text cleaning
// moves nothing, while "top-3 with floor 0.45" recovers the real cross-tool edges
// (Slack thread <-> the Jira ticket it produced, at 0.62-0.64) without admitting the
// noise floor. 0.45 is also the adjudication floor used elsewhere in the product.
//
// Rule under test: relates links = (score >= 0.65, cap 10) UNION (top-3, score >= 0.45).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'relates'],
}));

import { cosineSimilarity } from '../lib/local-embeddings.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { DatabaseSync } from 'node:sqlite';

describe('relative linking: top-3 with floor 0.45, union the absolute 0.65 rule', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-785-${Date.now()}-${Math.trunc(performance.now() * 1000)}.db`);
    client = createLocalGatewayClient(dbPath);
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);
  });

  afterEach(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  /** Seed n decisions scoring 0 against everything, then capture one more whose
   *  comparisons against the n priors take the given scores, in insertion order. */
  async function captureAgainst(scores: number[]): Promise<void> {
    for (let i = 0; i < scores.length; i++) {
      await client.captureDecision(`prior decision number ${i}`, 'cli');
    }
    let call = 0;
    vi.mocked(cosineSimilarity).mockImplementation(() => scores[call++] ?? 0);
    await client.captureDecision('the new decision under test', 'cli');
  }

  function linkScores(): number[] {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT confidence FROM decision_links WHERE relation = 'relates' ORDER BY confidence DESC").all() as { confidence: number }[];
    db.close();
    return rows.map((r) => r.confidence);
  }

  it('links the top-3 sub-0.65 neighbours when they clear the 0.45 floor', async () => {
    // The cross-tool case the absolute rule silently dropped: real neighbours at
    // 0.5-0.6, nothing at 0.65. Rank 4 (0.46) clears the floor but not the top-3.
    await captureAgainst([0.60, 0.55, 0.50, 0.46, 0.30]);
    expect(linkScores()).toEqual([0.60, 0.55, 0.50]);
  });

  it('links nothing when every neighbour sits in the noise floor', async () => {
    // Background on the measured corpus is 0.28-0.40; top-3 must NOT dredge it.
    await captureAgainst([0.44, 0.40, 0.30]);
    expect(linkScores()).toEqual([]);
  });

  it('unions: absolute matches keep their behaviour, the relative rule adds the rest of the top-3', async () => {
    await captureAgainst([0.90, 0.70, 0.50, 0.20]);
    expect(linkScores()).toEqual([0.90, 0.70, 0.50]);
  });

  it('does not double-link a neighbour that qualifies under both rules', async () => {
    await captureAgainst([0.90, 0.80, 0.70]);
    expect(linkScores()).toEqual([0.90, 0.80, 0.70]);
  });

  it('keeps the absolute cap at 10 and adds nothing relative when the top-3 are all absolute', async () => {
    await captureAgainst(new Array(12).fill(0.8));
    expect(linkScores()).toHaveLength(10);
  });
});
