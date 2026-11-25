import { describe, expect, it } from 'vitest';
import { redactSecrets, secretMatches, secretsIn } from '../lib/share/secret-scan.js';

// The generic `label:value` rule matched Tailwind variant classes (`dark:bg-gray-900`, `sm:grid-cols-2`) and a `mailto:`
// address in a user's run: 9 redactions, all false. Every "kept" case sits next to a "still redacted" case on the other
// side of the same boundary. Fixtures that look like credentials are built by concatenation.
const fx = (...parts: string[]): string => parts.join('');
const kept = (text: string): void => {
  const r = redactSecrets(text);
  expect(r.text).toBe(text);
  expect(r.count).toBe(0);
  expect(secretsIn(text)).toEqual([]);
  expect(secretMatches(text)).toEqual([]);
};
const redacted = (text: string, raw: string): void => {
  const r = redactSecrets(text);
  expect(r.text).not.toContain(raw);
  expect(r.count).toBeGreaterThan(0);
  expect(secretsIn(text).length).toBeGreaterThan(0);
  expect(secretMatches(text).length).toBeGreaterThan(0);
};

describe('a Tailwind variant class is not a credential', () => {
  it.each([
    'class="dark:bg-gray-900"',
    'class="sm:grid-cols-2"',
    'class="md:text-lg lg:flex-row"',
    'className="hover:bg-blue-500 focus:ring-2"',
    'class="group-hover:opacity-100"',
    'class="dark:bg-[#1da1f2]"',
    'class="sm:translate-x-0"',
  ])('keeps %s', (t) => kept(t));

  it('still redacts a secret-shaped value under the same labels', () => {
    redacted(fx('dark:', '3f9c2a1e7b4d9a0c'), '3f9c2a1e7b4d9a0c'); // lowercase hex, no hyphen: not a class
    redacted(fx('sm:', 'Xk9dL2mQ7pRsT4vW'), 'Xk9dL2mQ7pRsT4vW'); // mixed case: not a class
    redacted(fx('hover:', 'S3cr3tP4ssw0rd'), 'S3cr3tP4ssw0rd');
    // Review findings: hyphenated lowercase values that are not utilities.
    redacted(fx('hover:', 'my-sec', 'ret-pass-1234'), 'ret-pass-1234'); // starts like a margin utility, holds a credential word
    redacted(fx('active:', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'); // a UUID
    redacted(fx('open:', 'correct-horse-battery-9'), 'correct-horse-battery-9'); // `open` is a config key, not a variant here
  });
});

describe('a mailto: address is not a credential', () => {
  it('keeps mailto:jane.doe1@example.com', () => kept('write to mailto:jane.doe1@example.com'));
  it('still redacts a mailto: label with a secret-shaped value that is not an address', () => {
    redacted(fx('mailto:', 'S3cr3tP4ssw0rd'), 'S3cr3tP4ssw0rd');
  });
});

describe('real secret shapes are still caught', () => {
  it('a label:value credential', () => redacted(fx('admin:', 'S3cr3tP4ssw0rd'), 'S3cr3tP4ssw0rd'));
  it('a GitHub token', () => redacted(`token ${fx('ghp_', 'x'.repeat(36))}`, 'x'.repeat(36)));
  it('a class and a credential in one text redacts only the credential', () => {
    const r = redactSecrets(fx('class="dark:bg-gray-900" and ', 'admin:', 'S3cr3tP4ssw0rd'));
    expect(r.text).toBe('class="dark:bg-gray-900" and <CREDENTIALS>');
    expect(r.count).toBe(1);
  });
});
