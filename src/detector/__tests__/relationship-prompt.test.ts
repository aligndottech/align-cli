import { describe, expect, it } from 'vitest';
import template from '../relationship-prompt.v1.json' with { type: 'json' };
import { buildV1SystemPrompt, buildV1UserPrompt, v1MaxTokens } from '../relationship-prompt.js';

const subject = { title: 'Cap the worker pool at 12', summary: 'Pool max is 12 workers.', decidedAt: '2026-03-04T10:00:00Z', platform: 'github' };
const cand = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Candidate ${i}`, summary: `Summary ${i}.`, similarity: 0.8, platform: 'slack', decidedAt: null, status: null, ...extra,
});

describe('v1 system prompt', () => {
  it('carries all three shared sections byte for byte', () => {
    const prompt = buildV1SystemPrompt();
    expect(template.sections.rules).toContain('AGREEMENT CHECK');
    for (const section of Object.values(template.sections)) expect(prompt).toContain(section);
  });

  it('does not carry the hosted-only sections', () => {
    const prompt = buildV1SystemPrompt();
    expect(prompt).not.toContain('SIBLING');
    expect(prompt).not.toContain('missing_evidence');
    expect(prompt).not.toContain('ambiguity');
  });
});

describe('v1 user prompt', () => {
  it('lists every candidate, numbered, with title, summary, platform, similarity', () => {
    const prompt = buildV1UserPrompt(subject, [cand(1), cand(2), cand(3)], 100_000, 2048);
    for (const i of [1, 2, 3]) {
      expect(prompt).toContain(`${i}. Candidate ${i} (similarity: 0.80) [Platform: slack]`);
      expect(prompt).toContain(`   Summary ${i}.`);
    }
    expect(prompt).toContain('NEW DECISION:\nTitle: Cap the worker pool at 12\nSummary: Pool max is 12 workers.\nPlatform: github\nDecided: 2026-03-04\n');
  });

  it('renders decided_at and RETIRED in the fact bracket only when known', () => {
    const prompt = buildV1UserPrompt(subject, [cand(1, { decidedAt: '2026-01-02T00:00:00Z' }), cand(2, { status: 'superseded' }), cand(3)], 100_000, 2048);
    expect(prompt).toContain('1. Candidate 1 (similarity: 0.80) [Platform: slack] [decided 2026-01-02]\n');
    expect(prompt).toContain('2. Candidate 2 (similarity: 0.80) [Platform: slack] [RETIRED]\n');
    expect(prompt).toContain('3. Candidate 3 (similarity: 0.80) [Platform: slack]\n');
  });

  it('never renders a By line: the local graph stores no author', () => {
    const prompt = buildV1UserPrompt(subject, [cand(1)], 100_000, 2048);
    expect(prompt).not.toMatch(/\bBy: |\bby /);
  });

  it('omits Decided when the new decision has no date (a proposed change)', () => {
    const prompt = buildV1UserPrompt({ ...subject, decidedAt: null }, [cand(1)], 100_000, 2048);
    expect(prompt).not.toContain('Decided:');
  });

  it('cuts summaries to fit the window, never titles', () => {
    const long = 'x'.repeat(50_000);
    const prompt = buildV1UserPrompt({ ...subject, summary: long }, [cand(1, { summary: long }), cand(2, { summary: long })], 4_000, 2048);
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain('1. Candidate 1');
    expect(prompt).toContain('2. Candidate 2');
  });
});

describe('v1 max_tokens = max(n * 512, 2048), capped at 8192', () => {
  it('floor holds below 4 candidates', () => {
    expect(v1MaxTokens(1)).toBe(2048);
    expect(v1MaxTokens(4)).toBe(2048);
  });
  it('scales above the floor', () => {
    expect(v1MaxTokens(5)).toBe(2560);
    expect(v1MaxTokens(16)).toBe(8192);
  });
  it('caps at 8192', () => {
    expect(v1MaxTokens(17)).toBe(8192);
    expect(v1MaxTokens(100)).toBe(8192);
  });
});
