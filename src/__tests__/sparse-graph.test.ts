import { describe, expect, it } from 'vitest';
import { LOCAL_SHARE_THRESHOLD } from '../lib/value-rollup.js';
import { isSparseGraph, SPARSE_GRAPH_THRESHOLD, sparseGraphHint } from '../lib/sparse-graph.js';

describe('sparseGraphHint', () => {
  it('uses the same size the CLI already calls worth sharing', () => {
    expect(SPARSE_GRAPH_THRESHOLD).toBe(LOCAL_SHARE_THRESHOLD);
  });

  it('says the graph is empty at zero and names the real import commands', () => {
    const text = (sparseGraphHint(0) ?? []).join('\n');
    expect(text).toContain('Your graph is empty');
    expect(text).toContain('align connect github');
    expect(text).toContain('align connect docs');
  });

  it('states the count when the graph is thin, singular and plural', () => {
    expect((sparseGraphHint(1) ?? []).join('\n')).toContain('Your graph has 1 decision.');
    expect((sparseGraphHint(3) ?? []).join('\n')).toContain('Your graph has 3 decisions.');
  });

  it('is silent at the threshold and above, and sparse one below it', () => {
    expect(sparseGraphHint(SPARSE_GRAPH_THRESHOLD)).toBeUndefined();
    expect(sparseGraphHint(SPARSE_GRAPH_THRESHOLD + 20)).toBeUndefined();
    expect(isSparseGraph(SPARSE_GRAPH_THRESHOLD - 1)).toBe(true);
    expect(sparseGraphHint(SPARSE_GRAPH_THRESHOLD - 1)).toBeDefined();
  });

  it('never invents a command and carries no em-dash', () => {
    const text = (sparseGraphHint(0) ?? []).join('\n');
    const commands = [...text.matchAll(/align [a-z]+(?: [a-z]+)?/g)].map((m) => m[0].trim());
    for (const c of commands) expect(['align connect', 'align connect github', 'align connect docs']).toContain(c);
    expect(text).not.toContain('—');
  });
});
