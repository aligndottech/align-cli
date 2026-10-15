/**
 * ALI-1648: deterministic starter rules, evaluated INSIDE the pre-edit hook window.
 *
 * A ratified rule whose matcher has one right answer (a validated email address, a card
 * number that passes Luhn, a known credential format) needs no model call, so it can stop an
 * agent's first attempt rather than only a retry. Everything here is pure and local.
 *
 * Two separate questions, kept apart on purpose:
 *  - detectDeterministicHits: does this text carry the thing. No network, no tenant.
 *  - ratifiedDeterministicRules: did a person accept the rule that governs it. A hit with no
 *    ratified rule is never a deny - nothing governs until a human says "enforce this".
 *
 * Semantic parts of a rule (a name in free text, a pasted contract) are NOT matched here and
 * are never described as exact. Those wait for the pre-commit full check.
 */

export type StarterRuleStatus = 'offered' | 'accepted' | 'skipped';

/** The GET /starter-rules element, as align-stack's starterRuleOffering.ts returns it. */
export interface StarterRuleOffer {
  id: string;
  version: number;
  statement: string;
  rationale: string;
  matchers: readonly string[];
  status: StarterRuleStatus;
  decisionId: string | null;
}

export interface DeterministicHit {
  ruleId: string;
  /** What kind of thing matched, for the message. Never the matched text itself. */
  kind: string;
}

const CUSTOMER_DATA = 'customer-data-in-tickets';
const SECRETS = 'no-plaintext-secrets';

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const RESERVED_DOMAIN = /(^|\.)(example\.(com|org|net)|localhost|invalid|test|example)$/i;
const AUTOMATED_LOCAL = /^(no-?reply|donotreply|do-not-reply)@/i;

const CARD = /\b(?:\d[ -]?){13,19}\b/g;

const SECRET_FORMATS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasRealEmail(text: string): boolean {
  for (const m of text.matchAll(EMAIL)) {
    if (AUTOMATED_LOCAL.test(m[0])) continue;
    if (RESERVED_DOMAIN.test(m[1] ?? '')) continue;
    return true;
  }
  return false;
}

function hasLuhnCard(text: string): boolean {
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

export function detectDeterministicHits(text: string): DeterministicHit[] {
  const hits: DeterministicHit[] = [];
  if (hasRealEmail(text)) hits.push({ ruleId: CUSTOMER_DATA, kind: 'an email address' });
  else if (hasLuhnCard(text)) hits.push({ ruleId: CUSTOMER_DATA, kind: 'a card number' });
  const secret = SECRET_FORMATS.find((f) => f.re.test(text));
  if (secret) hits.push({ ruleId: SECRETS, kind: secret.kind });
  return hits;
}

/**
 * The tenant's accepted rules that declare a deterministic matcher, by id. Anything else in
 * the response (offered, skipped, semantic-only, malformed) yields no entry: an unreadable
 * answer must read as "nothing is ratified", never as a deny.
 */
export function ratifiedDeterministicRules(response: unknown): Map<string, StarterRuleOffer> {
  const out = new Map<string, StarterRuleOffer>();
  const list = (response as { templates?: unknown } | null)?.templates ?? response;
  if (!Array.isArray(list)) return out;
  for (const r of list as StarterRuleOffer[]) {
    if (r && r.status === 'accepted' && Array.isArray(r.matchers) && r.matchers.includes('deterministic')) {
      out.set(r.id, r);
    }
  }
  return out;
}

/** The reason text a deny carries: names the rule and what matched, never the matched value. */
export function ruleDenyReason(hits: Array<{ rule: StarterRuleOffer; kind: string }>): string {
  const lines = hits.map((h) => `- ${h.rule.statement} (this edit contains ${h.kind})`);
  return [
    'Blocked by a rule your team ratified in Align:',
    ...lines,
    'Remove it from the change and try again, or confirm with the user before proceeding.',
  ].join('\n');
}
