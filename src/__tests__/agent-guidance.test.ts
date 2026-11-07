import { describe, expect, it } from 'vitest';
import { ASK_ONCE_GUIDANCE } from '../lib/agent/agent-guidance.js';

// Each rule is its own claim, so each gets its own assertion, and each phrase is checked to
// appear exactly once: an assertion that matched a second copy elsewhere could not fail.
const once = (phrase: string) => {
  expect(ASK_ONCE_GUIDANCE.split(phrase).length - 1, phrase).toBe(1);
};

describe('the guidance both engines carry', () => {
  it('asks once and does not re-derive from code', () => {
    once('Ask the decision graph once per question');
    once('Do not repeat align_ask with new wording');
  });
  it('reads every relation field, not only the follow-up list', () => {
    for (const field of ['status', 'later_on_topic', 'successor', 'conflicts_with']) expect(ASK_ONCE_GUIDANCE).toMatch(new RegExp(`\\b${field}\\b`));
    once('say plainly when two decisions disagree');
  });
  it('chases a missing follow-up instead of saying it did not see it', () => {
    once('read that decision with an available tool before answering');
  });
  it('leads with one sentence and caps each decision at one line', () => {
    once('Start with a one-sentence answer');
    once('at most one short line per decision');
  });
  it('links every decision cited, preferring decision_url, and never a bare code', () => {
    once('named by its cite value');
    once('[cite](decision_url)');
    once('source_url when there is no decision_url');
    once('say there is no link');
    once('Never present one URL as the other');
    once('never cite a bare ticket code');
  });
});
