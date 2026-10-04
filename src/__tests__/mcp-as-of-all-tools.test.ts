import { describe, expect, it, vi } from 'vitest';
import { dispatchTool } from '../commands/mcp.js';
import type { EnvironmentConfig } from '../lib/config.js';
import {
  DECISION_RATIONALE_TOOL,
  DECISION_TIMELINE_TOOL,
  shapeTopicTimeline,
  TOPIC_TIMELINE_TOOL,
} from '../lib/mcp-timeline-tools.js';

// ALI-1411: before this, only align_ask, align_search and align_get_related_decisions honoured
// the as-of cutoff. Every other read tool answered from the whole graph, so a frozen benchmark
// run could cite a decision captured after its cutoff (v7 Jira rep 3 cited ALI-391 that way).
//
// Every tool below gets a PAIR: the cutoff is applied, and with no cutoff the call and the
// result are exactly what they were. The second half is what keeps this a benchmark fix rather
// than a behaviour change for every user.

const CUTOFF = '2026-08-11T00:00:00.000Z';
const BEFORE = '2026-08-01T00:00:00.000Z';
const AFTER = '2026-09-01T00:00:00.000Z';

const cloud: EnvironmentConfig = { gatewayUrl: '', authToken: null, tenantId: null, mode: 'auth' };

/** A client whose getDecision answers from a fixed id -> created_at table. */
function fakeClient(createdAt: Record<string, string | undefined> = {}) {
  return {
    searchDecisions: vi.fn().mockResolvedValue({ results: [], count: 0, strategy: 'semantic' }),
    checkAlignment: vi.fn(),
    checkDrift: vi.fn().mockResolvedValue({ drifted: false, score: 0.9 }),
    getImpact: vi.fn(),
    getConflicts: vi.fn(),
    getTopicTimeline: vi.fn(),
    getDecisionTimeline: vi.fn(),
    getDecision: vi.fn(async (id: string) => {
      if (!(id in createdAt)) throw new Error(`no decision ${id}`);
      const ts = createdAt[id];
      return { id, title: `T-${id}`, summary: `S-${id}`, platform: 'jira', ...(ts ? { created_at: ts } : {}) };
    }),
  };
}
type Client = Parameters<typeof dispatchTool>[2];
const cast = (c: ReturnType<typeof fakeClient>) => c as unknown as Client;

describe('align_check_alignment under an as-of cutoff', () => {
  const conflicting = () => ({
    status: 'conflicting',
    confidence: 0.9,
    check_event_id: 'evt-1',
    relevant_decisions: [
      { id: 'old', title: 'Old', summary: 's', similarity: 0.8 },
      { id: 'new', title: 'New ALI-391', summary: 's', similarity: 0.9 },
    ],
    conflicts: [{ decision_id: 'new', title: 'New ALI-391', reason: 'r', severity: 'warning' }],
    message: 'Conflicts with New ALI-391',
  });

  it('drops a decision created after the cutoff, and a conflict that rested only on it', async () => {
    const c = fakeClient({ old: BEFORE, new: AFTER });
    c.checkAlignment.mockResolvedValue(conflicting());

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['relevant_decisions'] as Array<{ id: string }>).map((d) => d.id)).toEqual(['old']);
    expect(out['conflicts']).toEqual([]);
    // The verdict was reached against a decision the as-of graph does not contain, so it is
    // void: what survives is retrieval, which is exactly what 'retrieved' means.
    expect(out['status']).toBe('retrieved');
    expect('check_event_id' in out).toBe(false);
    // The gateway's message named the post-cutoff decision; it must not reach the agent.
    expect(JSON.stringify(out)).not.toContain('ALI-391');
  });

  it('keeps a conflict against a decision that predates the cutoff', async () => {
    const c = fakeClient({ old: BEFORE, new: AFTER });
    c.checkAlignment.mockResolvedValue({
      ...conflicting(),
      conflicts: [{ decision_id: 'old', title: 'Old', reason: 'r', severity: 'warning' }],
    });

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect(out['status']).toBe('conflicting');
    expect((out['conflicts'] as Array<{ decision_id: string }>).map((d) => d.decision_id)).toEqual(['old']);
    expect(out['check_event_id']).toBe('evt-1');
  });

  it('becomes no-context when every related decision postdates the cutoff', async () => {
    const c = fakeClient({ new: AFTER });
    c.checkAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.7,
      relevant_decisions: [{ id: 'new', title: 'New', summary: 's', similarity: 0.9 }],
      conflicts: [],
      message: 'Aligned with New',
    });

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect(out['status']).toBe('no-context');
    expect(out['relevant_decisions']).toEqual([]);
  });

  it('fails closed on a decision with no created_at: an unknown age cannot be shown as-of', async () => {
    const c = fakeClient({ old: BEFORE, undated: undefined });
    c.checkAlignment.mockResolvedValue({
      status: 'aligned',
      confidence: 0.7,
      relevant_decisions: [
        { id: 'old', title: 'Old', summary: 's', similarity: 0.8 },
        { id: 'undated', title: 'Undated', summary: 's', similarity: 0.8 },
      ],
      message: 'm',
    });

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['relevant_decisions'] as Array<{ id: string }>).map((d) => d.id)).toEqual(['old']);
  });

  it('rebuilds an unknown result\'s message so it does not count a dropped decision', async () => {
    const c = fakeClient({ old: BEFORE, new: AFTER });
    c.checkAlignment.mockResolvedValue({
      status: 'unknown',
      reason: 'no_llm_key',
      confidence: 0,
      check_event_id: 'evt-u',
      relevant_decisions: [
        { id: 'old', title: 'Old', summary: 's', similarity: 0.8 },
        { id: 'new', title: 'New', summary: 's', similarity: 0.9 },
      ],
      conflicts: [],
      // The local client's wording, counted over the whole graph.
      message: 'Could not check 2 related decision(s) - the relationship classifier did not run.',
    });

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect(out['status']).toBe('unknown');
    expect(String(out['message'])).toContain('Could not check 1 related decision(s)');
    expect(String(out['message'])).toContain('NOT a pass');
    expect('check_event_id' in out).toBe(false);
    expect(out['confidence']).toBe(0);
  });

  it('recomputes confidence from the surviving decisions, not the dropped one', async () => {
    const c = fakeClient({ old: BEFORE, new: AFTER });
    c.checkAlignment.mockResolvedValue(conflicting());

    const out = (await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    // 0.9 was the gateway's figure and the post-cutoff decision's similarity; 0.8 is old's.
    expect(out['confidence']).toBe(0.8);
  });

  it('without a cutoff the result is returned untouched and nothing extra is fetched', async () => {
    const c = fakeClient({ old: BEFORE, new: AFTER });
    const raw = conflicting();
    c.checkAlignment.mockResolvedValue(raw);

    const out = await dispatchTool('align_check_alignment', { diff: 'd' }, cast(c), cloud);

    expect(out).toBe(raw);
    expect(c.getDecision).not.toHaveBeenCalled();
  });
});

// ALI-1420: a frozen run must never write. align_check_drift records a drift_check row on the
// gateway, so under a cutoff it is refused like align_capture - even for a decision that
// predates the cutoff, which ALI-1411 used to run.
describe('align_check_drift under an as-of cutoff', () => {
  it('is refused outright, for a pre-cutoff decision too, without running the check', async () => {
    const c = fakeClient({ old: BEFORE });
    await expect(
      dispatchTool('align_check_drift', { decision_id: 'old', content: 'x' }, cast(c), cloud, CUTOFF),
    ).rejects.toThrow(/frozen.*never writes|writes to the graph/i);
    expect(c.checkDrift).not.toHaveBeenCalled();
    expect(c.getDecision).not.toHaveBeenCalled();
  });

  it('without a cutoff it does not look the decision up', async () => {
    const c = fakeClient({});
    await dispatchTool('align_check_drift', { decision_id: 'new', content: 'x' }, cast(c), cloud);
    expect(c.getDecision).not.toHaveBeenCalled();
    expect(c.checkDrift).toHaveBeenCalledWith('new', 'x', undefined);
  });
});

describe('align_get_impact under an as-of cutoff', () => {
  const cloudImpact = () => ({
    decision: { id: 'root', title: 'Root', created_at: BEFORE },
    impact: {
      count: 3,
      summary: '3 decision(s) depend on this',
      decisions: [
        { id: 'a', created_at: BEFORE, depth: 1, path: ['root', 'a'] },
        { id: 'b', created_at: AFTER, depth: 1, path: ['root', 'b'] },
        // Predates the cutoff, but was reached only THROUGH b, which did not exist yet.
        { id: 'c', created_at: BEFORE, depth: 2, path: ['root', 'b', 'c'] },
      ],
    },
    dependencies: {
      count: 1,
      summary: 'Built on 1 other decision(s)',
      decisions: [{ id: 'd', created_at: AFTER, depth: 1, path: ['root', 'd'] }],
    },
  });

  it('refuses a root decision created after the cutoff', async () => {
    const c = fakeClient({ root: AFTER });
    c.getImpact.mockResolvedValue(cloudImpact());
    await expect(
      dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud, CUTOFF),
    ).rejects.toThrow(`No decision root in the graph as of ${CUTOFF}`);
  });

  it('drops post-cutoff rows, prunes what was reached through them, and recounts', async () => {
    const c = fakeClient({ root: BEFORE });
    c.getImpact.mockResolvedValue(cloudImpact());

    const out = (await dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud, CUTOFF)) as {
      impact: { count: number; summary: string; decisions: Array<{ id: string }> };
      dependencies: { count: number; summary: string; decisions: unknown[] };
    };

    expect(out.impact.decisions.map((d) => d.id)).toEqual(['a']);
    expect(out.impact.count).toBe(1);
    expect(out.impact.summary).toBe('1 decision(s) depend on this');
    expect(out.dependencies.decisions).toEqual([]);
    expect(out.dependencies.count).toBe(0);
    expect(out.dependencies.summary).toBe('No upstream dependencies');
  });

  it('filters the local shape by the edge AND both endpoints', async () => {
    const c = fakeClient({ root: BEFORE, x: BEFORE, y: AFTER });
    c.getImpact.mockResolvedValue({
      upstream: [
        { id: 'l1', sourceId: 'x', targetId: 'root', relation: 'relates', confidence: 1, createdAt: '2026-08-02 10:00:00' },
        // Both endpoints predate the cutoff, the edge itself does not.
        { id: 'l2', sourceId: 'x', targetId: 'root', relation: 'relates', confidence: 1, createdAt: '2026-08-20 10:00:00' },
      ],
      downstream: [
        // The edge predates the cutoff (a backdated row), the other endpoint does not.
        { id: 'l3', sourceId: 'root', targetId: 'y', relation: 'relates', confidence: 1, createdAt: '2026-08-02 10:00:00' },
      ],
    });

    const out = (await dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud, CUTOFF)) as {
      upstream: Array<{ id: string }>;
      downstream: unknown[];
    };

    expect(out.upstream.map((l) => l.id)).toEqual(['l1']);
    expect(out.downstream).toEqual([]);
  });

  it('refuses a response shape it cannot filter rather than passing it through', async () => {
    const c = fakeClient({ root: BEFORE });
    c.getImpact.mockResolvedValue({ something: 'else' });
    await expect(
      dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud, CUTOFF),
    ).rejects.toThrow(/as-of cutoff/);
  });

  it('without a cutoff the result is untouched and the root is not looked up', async () => {
    const c = fakeClient({});
    const raw = cloudImpact();
    c.getImpact.mockResolvedValue(raw);
    const out = await dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud);
    expect(out).toBe(raw);
    expect(c.getDecision).not.toHaveBeenCalled();
    expect(c.getImpact).toHaveBeenCalledWith('root');
  });
});

describe('align_get_conflicts under an as-of cutoff', () => {
  const link = (id: string, created: string, fromCreated: string, toCreated: string) => ({
    id,
    relation: 'conflicts_with',
    created_at: created,
    from_decision: { id: `${id}-f`, title: `F-${id}`, created_at: fromCreated },
    to_decision: { id: `${id}-t`, title: `T-${id}`, created_at: toCreated },
  });

  it('asks the gateway for links created before the cutoff', async () => {
    const c = fakeClient();
    c.getConflicts.mockResolvedValue({ links: [], conflict_count: 0 });
    await dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF);
    expect(c.getConflicts).toHaveBeenCalledWith({ createdBefore: CUTOFF });
  });

  it('drops a link whose endpoint postdates the cutoff and never reports the whole-graph total', async () => {
    const c = fakeClient();
    c.getConflicts.mockResolvedValue({
      links: [link('keep', BEFORE, BEFORE, BEFORE), link('drop', BEFORE, BEFORE, AFTER)],
      // total_count is computed WITHOUT the cursor, so it counts post-cutoff links too.
      pagination: { has_more: false, next_cursor: null, total_count: 40, conflicts_count: 30 },
      conflict_count: 40,
      showing: 2,
      message: 'Showing the first 2 of 40 conflict links.',
    });

    const out = (await dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['links'] as Array<{ id: string }>).map((l) => l.id)).toEqual(['keep']);
    expect(out['conflict_count']).toBe(1);
    expect(out['pagination']).toEqual({ has_more: false });
    expect('showing' in out).toBe(false);
    expect('message' in out).toBe(false);
  });

  it('says the set is partial when more pre-cutoff links exist past the page', async () => {
    const c = fakeClient();
    c.getConflicts.mockResolvedValue({
      links: [link('keep', BEFORE, BEFORE, BEFORE)],
      pagination: { has_more: true, next_cursor: '2026-09-02T00:00:00Z|dropped-link-id', total_count: 400 },
      conflict_count: 400,
    });

    const out = (await dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    // The cursor encodes the last RAW row, which can be a link this filter removed.
    expect(out['pagination']).toEqual({ has_more: true });
    expect(JSON.stringify(out)).not.toContain('dropped-link-id');
    expect(out['conflict_count']).toBe(1);
    expect(out['showing']).toBe(1);
    expect(String(out['message'])).toContain('more exist');
    expect(JSON.stringify(out)).not.toContain('400');
  });

  it('filters the local link shape by its own createdAt and both endpoints', async () => {
    const c = fakeClient({ a: BEFORE, b: BEFORE, z: AFTER });
    c.getConflicts.mockResolvedValue({
      links: [
        { id: 'l1', sourceId: 'a', targetId: 'b', relation: 'conflicts_with', confidence: 1, createdAt: '2026-08-02 00:00:00' },
        { id: 'l2', sourceId: 'a', targetId: 'b', relation: 'conflicts_with', confidence: 1, createdAt: '2026-08-12 00:00:00' },
        { id: 'l3', sourceId: 'a', targetId: 'z', relation: 'contradicts', confidence: 1, createdAt: '2026-08-02 00:00:00' },
      ],
      conflict_count: 3,
    });

    const out = (await dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['links'] as Array<{ id: string }>).map((l) => l.id)).toEqual(['l1']);
    expect(out['conflict_count']).toBe(1);
  });

  it('drops a local link whose endpoint no longer exists instead of failing the whole call', async () => {
    const c = fakeClient({ a: BEFORE, b: BEFORE });
    c.getDecision.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new Error('No decision gone in your local graph. `align decisions list` shows what is there.');
      return { id, created_at: BEFORE };
    });
    c.getConflicts.mockResolvedValue({
      links: [
        { id: 'l1', sourceId: 'a', targetId: 'b', relation: 'conflicts_with', confidence: 1, createdAt: '2026-08-02 00:00:00' },
        { id: 'l2', sourceId: 'a', targetId: 'gone', relation: 'conflicts_with', confidence: 1, createdAt: '2026-08-02 00:00:00' },
      ],
      conflict_count: 2,
    });

    const out = (await dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['links'] as Array<{ id: string }>).map((l) => l.id)).toEqual(['l1']);
  });

  it('still fails on a lookup error that is not a missing decision', async () => {
    const c = fakeClient();
    c.getDecision.mockRejectedValue(new Error('ECONNRESET'));
    c.getConflicts.mockResolvedValue({
      links: [{ id: 'l1', sourceId: 'a', targetId: 'b', relation: 'conflicts_with', confidence: 1, createdAt: '2026-08-02 00:00:00' }],
      conflict_count: 1,
    });

    await expect(dispatchTool('align_get_conflicts', {}, cast(c), cloud, CUTOFF)).rejects.toThrow('ECONNRESET');
  });

  it('without a cutoff the call has no argument and the result is untouched', async () => {
    const c = fakeClient();
    const raw = { links: [link('x', AFTER, AFTER, AFTER)], conflict_count: 1 };
    c.getConflicts.mockResolvedValue(raw);
    const out = await dispatchTool('align_get_conflicts', {}, cast(c), cloud);
    expect(c.getConflicts).toHaveBeenCalledWith();
    expect(out).toBe(raw);
  });
});

describe('align_get_topic_timeline under an as-of cutoff', () => {
  const raw = () => ({
    topic: 'auth',
    count: 3,
    superseded_count: 1,
    platforms: ['jira', 'slack'],
    spans_platforms: true,
    retrieval: { lexical: true, semantic: true },
    activity: [{ month: '2026-09', count: 1 }],
    chain_ids: ['a', 'b', 'c'],
    disagreements: [{ relation: 'supersedes', from: { id: 'c' }, to: { id: 'a' } }],
    why: [{ id: 'a', rationale: 'ra' }, { id: 'c', rationale: 'rc ALI-391' }],
    still_open: [{ id: 'c', questions: ['q'] }],
    decisions: [
      { id: 'a', title: 'A', platform: 'jira', status: 'superseded', created_at: BEFORE },
      { id: 'b', title: 'B', platform: 'jira', status: 'active', created_at: BEFORE },
      { id: 'c', title: 'C ALI-391', platform: 'slack', status: 'active', created_at: AFTER },
    ],
  });

  it('removes post-cutoff rows and everything that refers to them, and recounts', async () => {
    const c = fakeClient();
    c.getTopicTimeline.mockResolvedValue(raw());

    const out = (await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect((out['decisions'] as Array<{ id: string }>).map((d) => d.id)).toEqual(['a', 'b']);
    expect(out['count']).toBe(2);
    expect(out['superseded_count']).toBe(1);
    expect(out['platforms']).toEqual(['jira']);
    expect(out['spans_platforms']).toBe(false);
    expect(out['disagreements']).toEqual([]);
    expect(out['still_open']).toEqual([]);
    expect((out['why'] as Array<{ id: string }>).map((w) => w.id)).toEqual(['a']);
    // Month buckets cannot be re-derived honestly from the rows, so they are dropped rather
    // than left counting a decision that is not there.
    expect('activity' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('ALI-391');
  });

  it('filters disagreements even when the gateway sends no chain_ids', async () => {
    const c = fakeClient();
    const r = raw() as Record<string, unknown>;
    delete r['chain_ids'];
    c.getTopicTimeline.mockResolvedValue(r);

    const out = (await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    expect(out['disagreements']).toEqual([]);
    expect((out['decisions'] as Array<{ id: string }>).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('narrates the survivors when every chain member postdates the cutoff', async () => {
    const c = fakeClient();
    c.getTopicTimeline.mockResolvedValue({ ...raw(), chain_ids: ['c'] });

    const out = (await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;

    // An emptied chain would narrate nothing; with it omitted the shaper narrates every row.
    expect((out['decisions'] as Array<{ id: string }>).map((d) => d.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(out)).not.toContain('ALI-391');
  });

  it('without a cutoff the shaped output is exactly what it was', async () => {
    const c = fakeClient();
    c.getTopicTimeline.mockResolvedValue(raw());
    const out = await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth' }, cast(c), cloud);
    expect(out).toEqual(shapeTopicTimeline(raw(), 'auth'));
  });
});

describe('align_get_decision_rationale under an as-of cutoff', () => {
  it('refuses a decision created after the cutoff', async () => {
    const c = fakeClient({ new: AFTER });
    await expect(
      dispatchTool(DECISION_RATIONALE_TOOL, { decision_id: 'new' }, cast(c), cloud, CUTOFF),
    ).rejects.toThrow(`No decision new in the graph as of ${CUTOFF}`);
  });

  it('answers for a decision that predates the cutoff', async () => {
    const c = fakeClient({ old: BEFORE });
    const out = (await dispatchTool(DECISION_RATIONALE_TOOL, { decision_id: 'old' }, cast(c), cloud, CUTOFF)) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('T-old');
  });

  it('without a cutoff a post-cutoff decision is still served', async () => {
    const c = fakeClient({ new: AFTER });
    const out = (await dispatchTool(DECISION_RATIONALE_TOOL, { decision_id: 'new' }, cast(c), cloud)) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('T-new');
  });
});

describe('align_get_decision_timeline under an as-of cutoff', () => {
  const history = () => ({
    decision_id: 'old',
    title: 'Old',
    status: 'active',
    event_count: 2,
    events: [
      { id: 'e1', type: 'created', occurred_at: BEFORE },
      { id: 'e2', type: 'superseded', occurred_at: AFTER },
    ],
  });

  it('refuses a decision created after the cutoff', async () => {
    const c = fakeClient({ new: AFTER });
    c.getDecisionTimeline.mockResolvedValue(history());
    await expect(
      dispatchTool(DECISION_TIMELINE_TOOL, { decision_id: 'new' }, cast(c), cloud, CUTOFF),
    ).rejects.toThrow(`No decision new in the graph as of ${CUTOFF}`);
  });

  it('drops events that happened after the cutoff and recounts', async () => {
    const c = fakeClient({ old: BEFORE });
    c.getDecisionTimeline.mockResolvedValue(history());
    const out = (await dispatchTool(DECISION_TIMELINE_TOOL, { decision_id: 'old' }, cast(c), cloud, CUTOFF)) as {
      events: Array<{ id: string }>;
      event_count: number;
    };
    expect(out.events.map((e) => e.id)).toEqual(['e1']);
    expect(out.event_count).toBe(1);
  });

  it('without a cutoff the history is untouched and the decision is not looked up', async () => {
    const c = fakeClient({});
    const raw = history();
    c.getDecisionTimeline.mockResolvedValue(raw);
    const out = await dispatchTool(DECISION_TIMELINE_TOOL, { decision_id: 'old' }, cast(c), cloud);
    expect(out).toBe(raw);
    expect(c.getDecision).not.toHaveBeenCalled();
  });
});

// ALI-1420: the gateway now bounds three of these reads itself, so the cutoff is SENT, not only
// applied afterwards. The client-side filters stay as a backstop for a gateway that predates the
// parameter (it ignores an unknown field), which is the fail-closed direction.
describe('the cutoff reaches the gateway (ALI-1420)', () => {
  it('align_check_alignment sends createdBefore; without a cutoff the call is exactly as before', async () => {
    const c = fakeClient({});
    c.checkAlignment.mockResolvedValue({ status: 'no-context', relevant_decisions: [] });
    await dispatchTool('align_check_alignment', { diff: 'd', context: 'ctx' }, cast(c), cloud, CUTOFF);
    expect(c.checkAlignment).toHaveBeenCalledWith('d', 'ctx', { createdBefore: CUTOFF });

    const c2 = fakeClient({});
    c2.checkAlignment.mockResolvedValue({ status: 'no-context', relevant_decisions: [] });
    await dispatchTool('align_check_alignment', { diff: 'd', context: 'ctx' }, cast(c2), cloud);
    expect(c2.checkAlignment).toHaveBeenCalledWith('d', 'ctx');
  });

  it('align_get_topic_timeline sends createdBefore; without a cutoff the call is exactly as before', async () => {
    const empty = { topic: 'auth', count: 0, decisions: [], retrieval: { lexical: true, semantic: true } };
    const c = fakeClient({});
    c.getTopicTimeline.mockResolvedValue(empty);
    await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth', limit: 7 }, cast(c), cloud, CUTOFF);
    expect(c.getTopicTimeline).toHaveBeenCalledWith('auth', 7, CUTOFF);

    const c2 = fakeClient({});
    c2.getTopicTimeline.mockResolvedValue(empty);
    await dispatchTool(TOPIC_TIMELINE_TOOL, { topic: 'auth', limit: 7 }, cast(c2), cloud);
    expect(c2.getTopicTimeline).toHaveBeenCalledWith('auth', 7);
  });

  it('align_get_impact sends createdBefore (the no-cutoff call is pinned above as getImpact("root"))', async () => {
    const c = fakeClient({ root: BEFORE });
    c.getImpact.mockResolvedValue({ decision: { id: 'root' }, impact: { decisions: [] }, dependencies: { decisions: [] } });
    await dispatchTool('align_get_impact', { decision_id: 'root' }, cast(c), cloud, CUTOFF);
    expect(c.getImpact).toHaveBeenCalledWith('root', CUTOFF);
  });
});

// ALI-1420: a frozen run must never write. Every tool annotated as a write is refused under a
// cutoff, derived from the annotations tools/list publishes rather than a hand-kept list.
describe('write tools under an as-of cutoff (ALI-1420)', () => {
  const captureClient = () => ({ ...fakeClient({}), captureDecision: vi.fn().mockResolvedValue({ id: 'x' }) });

  it('align_capture is refused and nothing is captured', async () => {
    const c = captureClient();
    await expect(
      dispatchTool('align_capture', { input: 'https://github.com/a/b/pull/1' }, c as unknown as Client, cloud, CUTOFF),
    ).rejects.toThrow(/frozen.*never writes|writes to the graph/i);
    expect(c.captureDecision).not.toHaveBeenCalled();
  });

  it('the refusal names the cutoff and the way out', async () => {
    const c = captureClient();
    await expect(
      dispatchTool('align_capture', { input: 'https://github.com/a/b/pull/1' }, c as unknown as Client, cloud, CUTOFF),
    ).rejects.toThrow(new RegExp(`${CUTOFF.replace(/[.]/g, '\\.')}.*--created-before`));
  });

  it('without a cutoff align_capture still captures (the control)', async () => {
    const c = captureClient();
    await dispatchTool('align_capture', { input: 'https://github.com/a/b/pull/1' }, c as unknown as Client, cloud);
    expect(c.captureDecision).toHaveBeenCalledWith('https://github.com/a/b/pull/1', 'github');
  });

  it('read tools are not refused (ask runs under a cutoff)', async () => {
    const c = fakeClient({});
    await dispatchTool('align_ask', { question: 'q' }, cast(c), cloud, CUTOFF);
    expect(c.searchDecisions).toHaveBeenCalledWith('q', 8, CUTOFF);
  });
});
