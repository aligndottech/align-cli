import { describe, expect, it, vi } from 'vitest';
import { type GateClient, type GateDeps, gateEdit } from '../lib/agent/edit-gate.js';
import type { ToolAsk } from '../lib/agent/types.js';

// The decision the edit reverses, and an unrelated control. Distinct ids and titles, so a gate
// that returned the wrong one cannot pass (tdd.md: two sources must hold different values).
const REVERSED = { id: 'd-7089', title: 'Error handler keeps only status codes 400-599', summary: 'Codes below 400 fall back to 500.', similarity: 0.82, url: 'https://github.com/fastify/fastify/pull/7089' };
const NEARBY = { id: 'd-601', title: 'Do not allow a status code lower than 400', summary: 'Since 2018.', similarity: 0.71 };

const editAsk = (over: Partial<ToolAsk['edit']> = {}): ToolAsk => ({
  id: 't1', tool: 'Edit', kind: 'edit',
  edit: { file_path: 'lib/error-status.js', old_string: 'if (code < 400) code = 500', new_string: 'if (code < 100) code = 500', ...over },
});
const writeAsk = (content: string): ToolAsk => ({ id: 't2', tool: 'Write', kind: 'edit', edit: { file_path: 'lib/error-status.js', content } });

type Related = typeof REVERSED | typeof NEARBY;
function client(opts: { related?: Related[]; verdict?: 'conflicting' | 'aligned' | 'no-context' | 'unknown' | 'hang'; throws?: boolean; slow?: boolean } = {}): GateClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    checkAlignment: vi.fn(async (_text: string, _ctx: string, o: { depth: string }) => {
      calls.push(o.depth);
      if (opts.throws) throw new Error('db locked');
      if (opts.slow && o.depth === 'related') await new Promise((r) => setTimeout(r, 200));
      if (o.depth === 'related') return { status: 'retrieved', relevant_decisions: opts.related ?? [] } as never;
      if (opts.verdict === 'hang') return new Promise(() => {}) as never;
      if (opts.verdict === 'conflicting') {
        return { status: 'conflicting', relevant_decisions: opts.related ?? [], conflicts: [{ decision_id: REVERSED.id, title: REVERSED.title, reason: 'Reverses the 400-599 rule', severity: 'critical', url: REVERSED.url }] } as never;
      }
      return { status: opts.verdict ?? 'aligned', relevant_decisions: opts.related ?? [] } as never;
    }),
  };
}
const deps = (c: GateClient, over: Partial<GateDeps> = {}): GateDeps => ({
  client: c, cwd: '/repo', canAdjudicate: () => false, blame: async () => [], retrievalMs: 100, adjudicateMs: 100, ...over,
});

describe('gateEdit: an edit that rewrites lines a decision wrote, with no model to adjudicate', () => {
  it('asks the human, naming the decision blame found (Edit)', async () => {
    const out = await gateEdit(editAsk(), deps(client(), { blame: async () => [{ id: REVERSED.id, title: REVERSED.title }] }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
    expect(out.cards.map((c) => [c.id, c.via])).toEqual([[REVERSED.id, 'blame']]);
  });
  it('asks for a Write that replaces the whole file too', async () => {
    const out = await gateEdit(writeAsk('module.exports = (c) => c'), deps(client(), { blame: async () => [{ id: NEARBY.id, title: NEARBY.title }] }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
    expect(out.cards[0]?.title).toBe(NEARBY.title);
  });
});

describe('gateEdit: retrieval hits only, no adjudicator', () => {
  it('allows, carrying the card', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [NEARBY] })));
    expect(out).toEqual({ kind: 'allow', cards: [{ id: NEARBY.id, title: NEARBY.title, why: NEARBY.summary, url: undefined, via: 'retrieval' }] });
  });
  it('keeps every hit, in retrieval order, with its link', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [REVERSED, NEARBY] })));
    expect(out.kind).toBe('allow');
    expect(out.cards.map((c) => [c.id, c.url])).toEqual([[REVERSED.id, REVERSED.url], [NEARBY.id, undefined]]);
  });
});

describe('gateEdit: nothing related', () => {
  it('allows with no cards', async () => {
    expect(await gateEdit(editAsk(), deps(client()))).toEqual({ kind: 'allow', cards: [] });
  });
  // A deletion has no new text to search with, but it removes old lines, and blame reads those.
  it('asks on a deletion of lines a decision wrote (empty new text)', async () => {
    const out = await gateEdit(editAsk({ new_string: '' }), deps(client({ related: [NEARBY] }), { blame: async () => [{ id: REVERSED.id, title: REVERSED.title }] }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
    expect(out.cards.map((c) => c.id)).toEqual([REVERSED.id]);
  });
  it('allows a deletion of undecided lines without a retrieval call', async () => {
    const c = client({ related: [REVERSED] });
    expect(await gateEdit(editAsk({ new_string: '' }), deps(c))).toEqual({ kind: 'allow', cards: [] });
    expect(c.calls).toEqual([]);
  });
});

describe('gateEdit: an edit the gate cannot read', () => {
  it('asks rather than allowing an edit with no file path (an engine shape the gate does not know)', async () => {
    const c = client({ related: [REVERSED] });
    const ask: ToolAsk = { id: 'n1', tool: 'NotebookEdit', kind: 'edit', edit: {} };
    expect(await gateEdit(ask, deps(c))).toEqual({ kind: 'ask', reason: 'unchecked', cards: [] });
    expect(c.calls).toEqual([]);
  });
});

describe('gateEdit: with a model to adjudicate', () => {
  it('asks on a conflicting verdict, with the verdict reason as the why', async () => {
    const c = client({ related: [REVERSED], verdict: 'conflicting' });
    const out = await gateEdit(editAsk(), deps(c, { canAdjudicate: () => true }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'conflict' });
    expect(out.cards).toEqual([{ id: REVERSED.id, title: REVERSED.title, why: 'Reverses the 400-599 rule', url: REVERSED.url, via: 'verdict' }]);
    expect(c.calls).toEqual(['related', 'full']);
  });
  it('allows on an aligned verdict, still showing what it checked against', async () => {
    const c = client({ related: [NEARBY], verdict: 'aligned' });
    const out = await gateEdit(editAsk(), deps(c, { canAdjudicate: () => true }));
    expect(out.kind).toBe('allow');
    expect(out.cards.map((x) => x.id)).toEqual([NEARBY.id]);
  });
  it('does not adjudicate when retrieval and blame found nothing', async () => {
    const c = client({ verdict: 'conflicting' });
    await gateEdit(editAsk(), deps(c, { canAdjudicate: () => true }));
    expect(c.calls).toEqual(['related']);
  });
});

describe('gateEdit: the adjudicator cannot answer', () => {
  it('falls back to the no-model rules on unknown: retrieval-only allows', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [NEARBY], verdict: 'unknown' }), { canAdjudicate: () => true }));
    expect(out).toMatchObject({ kind: 'allow' });
    expect(out.cards.map((c) => c.via)).toEqual(['retrieval']);
  });
  it('falls back on a verdict that never arrives: a blame hit still asks', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [NEARBY], verdict: 'hang' }), {
      canAdjudicate: () => true, blame: async () => [{ id: REVERSED.id, title: REVERSED.title }],
    }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
    expect(out.cards.map((c) => c.id)).toEqual([REVERSED.id, NEARBY.id]);
  });
});

describe('gateEdit: what a card says', () => {
  // A git-imported summary is the whole commit body (measured on fastify: author, date, files
  // changed, URL). A card is read mid-task, and the stop message is read by the model.
  it('keeps the why to the first line of the summary', async () => {
    const long = { ...NEARBY, summary: 'Now allowing only numbers in range between 100 and 600\n\n* adds provided status code\n\nFiles changed:\nlib/errors.js' };
    const out = await gateEdit(editAsk(), deps(client({ related: [long] })));
    expect(out.cards[0]?.why).toBe('Now allowing only numbers in range between 100 and 600');
  });
  it('cuts a long first line at 160 characters', async () => {
    const long = { ...NEARBY, summary: `${'word '.repeat(60)}end` };
    const out = await gateEdit(editAsk(), deps(client({ related: [long] })));
    expect(out.cards[0]?.why?.length).toBeLessThanOrEqual(160);
    expect(out.cards[0]?.why?.endsWith('...')).toBe(true);
  });
});

describe('gateEdit: the same decision found twice', () => {
  it('shows a decision once, as the blame card, when retrieval also finds it', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [REVERSED, NEARBY] }), { blame: async () => [{ id: REVERSED.id, title: REVERSED.title }] }));
    expect(out.cards.map((c) => [c.id, c.via])).toEqual([[REVERSED.id, 'blame'], [NEARBY.id, 'retrieval']]);
  });
});

// A model verdict never clears a blame hit. Measured on the fastify #7089 run (6 Nov): with
// adjudication on, the model judged the edit that widened the 400-599 clamp "not a conflict", the
// gate allowed it and the file changed; on the next edit it called a conflict against the wrong
// decision. That the edit rewrites lines a decision wrote is a fact from git; the verdict is a
// guess about a fragment. So the person always sees a blame hit.
describe('gateEdit: a model verdict cannot clear a blame hit', () => {
  it('still asks when the model judged the blamed decision unrelated (no-context)', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [], verdict: 'no-context' }), {
      canAdjudicate: () => true, blame: async () => [{ id: REVERSED.id, title: REVERSED.title }],
    }));
    expect(out).toEqual({ kind: 'ask', reason: 'rewrites-decided-lines', cards: [{ id: REVERSED.id, title: REVERSED.title, via: 'blame' }] });
  });
  it('still asks when the model judged the edit aligned', async () => {
    const out = await gateEdit(editAsk(), deps(client({ related: [NEARBY], verdict: 'aligned' }), {
      canAdjudicate: () => true, blame: async () => [{ id: REVERSED.id, title: REVERSED.title }],
    }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
    expect(out.cards.map((c) => c.id)).toEqual([REVERSED.id, NEARBY.id]);
  });
  it('does not spend a model call on a blame hit, since no verdict can change the answer', async () => {
    const c = client({ related: [NEARBY], verdict: 'aligned' });
    await gateEdit(editAsk(), deps(c, { canAdjudicate: () => true, blame: async () => [{ id: REVERSED.id, title: REVERSED.title }] }));
    expect(c.calls).toEqual(['related']);
  });
  it('still asks on a blame hit when adjudication throws', async () => {
    const c = client({ related: [], verdict: 'aligned' });
    const real = c.checkAlignment;
    c.checkAlignment = vi.fn(async (t: string, x: string, o: { depth: 'related' | 'full' }) => {
      if (o.depth === 'full') throw new Error('provider 529');
      return real(t, x, o);
    });
    const out = await gateEdit(editAsk(), deps(c, { canAdjudicate: () => true, blame: async () => [{ id: REVERSED.id, title: REVERSED.title }] }));
    expect(out).toMatchObject({ kind: 'ask', reason: 'rewrites-decided-lines' });
  });
});

describe('gateEdit: the check itself fails', () => {
  it('allows and says it did not check when retrieval throws', async () => {
    expect(await gateEdit(editAsk(), deps(client({ throws: true })))).toEqual({ kind: 'allow', cards: [], note: 'not-checked' });
  });
  it('allows and says it did not check when retrieval is too slow', async () => {
    expect(await gateEdit(editAsk(), deps(client({ slow: true, related: [NEARBY] }), { retrievalMs: 20 }))).toEqual({ kind: 'allow', cards: [], note: 'not-checked' });
  });
});
