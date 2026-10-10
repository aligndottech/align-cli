import { describe, expect, it } from 'vitest';
import { failedJudgements, readOutcomes } from '../lib/share/wire.js';

/**
 * L9 Test List, reading POST /ingest/batch's answer to a share (the CLI client used to read snapshots[0]):
 * - Every request item gets exactly one outcome; an item the response never mentions is `unknown`, never created.
 * - snapshots are matched to items by request_index, not by position: a batch where item 0 was matched and item 1 created
 *   puts the snapshot on item 1.
 * - matched / skipped / refused / match_ambiguous each map to their own outcome, with the ids and reasons the server gave.
 * - A re-share the server updated (is_new false) is `updated`; a created item named in match_ambiguous is `created` and ambiguous.
 * - judgement results attach to the item by request_index; no report at all is `null` (an older gateway), not an empty list.
 * - An old gateway's untagged snapshots are position-aligned only when the counts agree and nothing else was reported.
 */
describe('readOutcomes', () => {
  it('puts a snapshot on the item that wrote it, whatever its position', () => {
    const out = readOutcomes(2, {
      snapshots: [{ id: 'S1', request_index: 1 }],
      matched: [{ request_index: 0, existing_id: 'T0', status: 'active' }],
    });
    expect(out[0]).toMatchObject({ kind: 'matched', remoteId: 'T0', status: 'active' });
    expect(out[1]).toMatchObject({ kind: 'created', remoteId: 'S1', ambiguous: false });
  });
  it('maps skipped, refused and ambiguous, and leaves an unmentioned item unknown', () => {
    const out = readOutcomes(5, {
      snapshots: [{ id: 'S0', request_index: 0 }],
      match_ambiguous: [0],
      skipped: [{ index: 1, reason: 'archived_in_team', existing_id: 'E1' }],
      refused: [{ request_index: 2, reason: 'not_visible' }],
    });
    expect(out[0]).toMatchObject({ kind: 'created', ambiguous: true });
    expect(out[1]).toMatchObject({ kind: 'skipped', remoteId: 'E1', reason: 'archived_in_team' });
    expect(out[2]).toEqual({ kind: 'refused', index: 2, reason: 'not_visible' });
    expect(out[3]).toEqual({ kind: 'unknown', index: 3 });
    expect(out[4]).toEqual({ kind: 'unknown', index: 4 });
  });
  it('reads a re-share the server updated as updated', () => {
    expect(readOutcomes(1, { snapshots: [{ id: 'S', request_index: 0, is_new: false }] })[0]).toMatchObject({ kind: 'updated', remoteId: 'S' });
    expect(readOutcomes(1, { snapshots: [{ id: 'S', request_index: 0, is_new: true }] })[0]).toMatchObject({ kind: 'created' });
  });
  it('attaches judgement results by request_index, and null when the gateway reported none', () => {
    const out = readOutcomes(2, {
      snapshots: [{ id: 'A', request_index: 0 }, { id: 'B', request_index: 1 }],
      judgements: [{ request_index: 1, decision_id: 'B', results: [{ ok: true, stored: true }, { ok: false, error: 'ratification_not_permitted' }] }],
    });
    expect(out[0]).toMatchObject({ judgements: null });
    expect((out[1] as { judgements: unknown }).judgements).toHaveLength(2);
    expect(failedJudgements((out[1] as { judgements: never }).judgements)).toEqual([{ index: 1, error: 'ratification_not_permitted' }]);
    expect(failedJudgements(null)).toEqual([]);
  });
  it('carries what a matched share still needs confirmed', () => {
    const out = readOutcomes(1, {
      matched: [{ request_index: 0, existing_id: 'T', status: 'active', team_text_hash: 'h', needs_confirmation: [{ kind: 'ratify', judgement_index: 0 }] }],
    });
    expect(out[0]).toMatchObject({ kind: 'matched', teamTextHash: 'h', needsConfirmation: [{ kind: 'ratify', judgement_index: 0 }] });
  });
  it('aligns untagged snapshots by position only when the counts agree and nothing else was reported', () => {
    expect(readOutcomes(2, { snapshots: [{ id: 'A' }, { id: 'B' }] }).map((o) => o.kind)).toEqual(['created', 'created']);
    expect(readOutcomes(3, { snapshots: [{ id: 'A' }, { id: 'B' }] }).map((o) => o.kind)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(readOutcomes(2, { snapshots: [{ id: 'A' }], skipped: [{ index: 1, reason: 'r', existing_id: 'E' }] }).map((o) => o.kind)).toEqual(['unknown', 'skipped']);
  });
  it('an empty answer is all unknown, and an empty request is no outcomes', () => {
    expect(readOutcomes(2, {}).map((o) => o.kind)).toEqual(['unknown', 'unknown']);
    expect(readOutcomes(0, {})).toEqual([]);
  });
  it('believes `created` only with a request_index AND is_new true; anything less is uncertain (an older gateway)', () => {
    const sure = readOutcomes(1, { snapshots: [{ id: 'A', request_index: 0, is_new: true }] })[0]!;
    expect(sure).toMatchObject({ kind: 'created', uncertain: false });
    expect(readOutcomes(1, { snapshots: [{ id: 'A', request_index: 0 }] })[0]).toMatchObject({ kind: 'created', uncertain: true });
    expect(readOutcomes(1, { snapshots: [{ id: 'A', is_new: true }] })[0]).toMatchObject({ kind: 'created', uncertain: true });
    expect(readOutcomes(1, { snapshots: [{ id: 'A' }] })[0]).toMatchObject({ kind: 'created', uncertain: true });
  });
});
