/**
 * ALI-1648: ratified deterministic rules stop an agent's FIRST attempt.
 *
 * The detector is pure and answers one question with one right answer: does this proposed
 * text carry a validated identifier or a known credential format. Whether that is a deny
 * is decided elsewhere, by whether the tenant ratified the matching starter rule.
 */
import { describe, expect, it } from 'vitest';
import { detectDeterministicHits, ratifiedDeterministicRules, type StarterRuleOffer } from '../lib/inline-rules.js';

const offer = (id: string, status: StarterRuleOffer['status'], matchers: string[] = ['deterministic', 'semantic']): StarterRuleOffer => ({
  id, version: 1, statement: `statement of ${id}`, rationale: 'r', matchers, status, decisionId: 'd-1',
});

describe('detectDeterministicHits', () => {
  it('finds a real-looking email address and names the customer-data rule', () => {
    const hits = detectDeterministicHits('{ "reporter": "jane.doe@acmecorp.io" }');
    expect(hits.map((h) => h.ruleId)).toEqual(['customer-data-in-tickets']);
  });
  it('finds a second, different email too (not one hard-coded address)', () => {
    expect(detectDeterministicHits('cc bob@customer.co.uk').map((h) => h.ruleId)).toEqual(['customer-data-in-tickets']);
  });
  it('ignores reserved example domains and noreply senders', () => {
    for (const t of ['a@example.com', 'a@example.org', 'a@x.test', 'a@localhost', 'noreply@acmecorp.io', 'a@foo.invalid']) {
      expect(detectDeterministicHits(t)).toEqual([]);
    }
  });
  it('finds a Luhn-valid card number, spaced or not, and ignores a failing one', () => {
    expect(detectDeterministicHits('card 4111 1111 1111 1111').map((h) => h.ruleId)).toEqual(['customer-data-in-tickets']);
    expect(detectDeterministicHits('card 5555555555554444').map((h) => h.ruleId)).toEqual(['customer-data-in-tickets']);
    expect(detectDeterministicHits('id 4111111111111112')).toEqual([]);
  });
  it('finds known credential formats and names the secrets rule', () => {
    const cases = [
      'key=AKIAJ3Q7ZK2MWB5TXN4P',
      `tok ghp_${'a'.repeat(36)}`,
      `sk-ant-api03-${'b'.repeat(40)}`,
      'xoxb-123456789012-abcdefghijkl',
      '-----BEGIN RSA PRIVATE KEY-----',
    ];
    for (const c of cases) expect(detectDeterministicHits(c).map((h) => h.ruleId)).toEqual(['no-plaintext-secrets']);
  });
  it('does not mistake common non-matches for customer data or secrets', () => {
    const clean = [
      'pad 0000000000000000', 'ts 1760000000000', 'id 1234-5678-9012-3456-7890', 'logo@2x.png',
      'Co-authored-by: Bot <1+bot@users.noreply.github.com>', 'key=AKIAIOSFODNN7EXAMPLE',
    ];
    for (const c of clean) expect(detectDeterministicHits(c)).toEqual([]);
  });
  it('a huge run of email characters with no @ stays fast', () => {
    const t0 = Date.now();
    detectDeterministicHits('a'.repeat(200_000));
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('plain prose and short tokens hit nothing', () => {
    expect(detectDeterministicHits('rename the ghp_ prefix constant; AKIA is a prefix')).toEqual([]);
  });
});

describe('ratifiedDeterministicRules', () => {
  it('keeps only accepted rules that declare a deterministic matcher', () => {
    const got = ratifiedDeterministicRules([
      offer('customer-data-in-tickets', 'accepted'),
      offer('no-plaintext-secrets', 'offered'),
      offer('confirm-scope-before-bulk-delete', 'accepted', ['semantic']),
      offer('x', 'skipped'),
    ]);
    expect([...got.keys()]).toEqual(['customer-data-in-tickets']);
  });
  it('a malformed response yields no rules (never a throw, never a deny)', () => {
    expect(ratifiedDeterministicRules(null as never).size).toBe(0);
    expect(ratifiedDeterministicRules({} as never).size).toBe(0);
  });
});
