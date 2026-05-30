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
