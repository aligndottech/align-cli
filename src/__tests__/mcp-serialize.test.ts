import { describe, expect, it } from 'vitest';
import { serializeMcpResult } from '../commands/mcp.js';

describe('serializeMcpResult', () => {
  it('preserves the fields an agent needs', () => {
    const out = serializeMcpResult({ decisions: [{ id: 'd1', title: 'Use Postgres', platform: 'git', score: 0.8 }] });
    const parsed = JSON.parse(out);
    expect(parsed.decisions[0]).toEqual({ id: 'd1', title: 'Use Postgres', platform: 'git', score: 0.8 });
  });

  it('omits heavy internal fields (embedding, decision_json, raw_text) anywhere in the tree', () => {
    const out = serializeMcpResult({
      snapshots: [{
        id: 'd1',
        title: 'X',
        raw_text: 'a very long source dump '.repeat(500),
        decision_json: { huge: 'object' },
        embedding: new Array(384).fill(0.1),
      }],
    });
    const parsed = JSON.parse(out);
    expect(parsed.snapshots[0].id).toBe('d1');
    expect(parsed.snapshots[0].title).toBe('X');
    expect(parsed.snapshots[0]).not.toHaveProperty('raw_text');
    expect(parsed.snapshots[0]).not.toHaveProperty('decision_json');
    expect(parsed.snapshots[0]).not.toHaveProperty('embedding');
  });

  it('serializes compactly (no pretty-print whitespace)', () => {
    const out = serializeMcpResult({ a: 1, b: { c: 2 } });
    expect(out).toBe('{"a":1,"b":{"c":2}}');
    expect(out).not.toContain('\n');
  });
});

// ALI-2039: every tool result leaves through serializeMcpResult, so it is the one place an align:// identity that
// is not a place can be stopped before a model prints it as a link.
describe('serializeMcpResult and sources that are not places', () => {
  it('never lets an align:// source reach the model, whichever tool result it came in', () => {
    const check = serializeMcpResult({
      status: 'conflicting',
      relevant_decisions: [{ id: 'd-1', url: 'align://demo/pagewell-pay/engineering/retries-service-owns-retries', decision_url: 'https://app.test/decisions/d-1' }],
      conflicts: [{ decision_id: 'd-1', url: 'align://demo/pagewell-pay/engineering/retries-service-owns-retries' }],
    });
    const ask = serializeMcpResult({ results: [{ id: 'd-2', source_url: 'align://starter-template/general/x', decision_url: 'https://app.test/decisions/d-2' }] });
    expect(check).not.toContain('align://');
    expect(ask).not.toContain('align://');
    expect(JSON.parse(check).relevant_decisions[0].decision_url).toBe('https://app.test/decisions/d-1');
    expect(JSON.parse(ask).results[0].decision_url).toBe('https://app.test/decisions/d-2');
  });

  it('reads the model claim before decision_json is omitted, so an unverified source keeps what was claimed', () => {
    const out = JSON.parse(
      serializeMcpResult({ results: [{ id: 'd-1', source_url: 'align://claimed/9f2c', decision_json: { claimed_source: 'the planning doc' } }] })
    );
    expect(out.results[0]).toMatchObject({ source_unverified: true, claimed_source: 'the planning doc' });
    expect(out.results[0]).not.toHaveProperty('decision_json');
    expect(out.results[0]).not.toHaveProperty('source_url');
  });

  it('still serialises a Date as its ISO string', () => {
    const out = JSON.parse(serializeMcpResult({ results: [{ id: 'd-1', created_at: new Date('2026-01-01T00:00:00.000Z') }] }));
    expect(out.results[0].created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('still sends a real source url', () => {
    const out = JSON.parse(serializeMcpResult({ results: [{ id: 'd-1', source_url: 'https://github.com/o/r/pull/7' }] }));
    expect(out.results[0].source_url).toBe('https://github.com/o/r/pull/7');
  });
});
