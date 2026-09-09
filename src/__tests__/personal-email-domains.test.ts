/**
 * ALI-938: isPersonalEmailDomain, the client-side mirror of align-stack's
 * provisioning.ts classifier. `align invite` uses this to decide whether the caller
 * has a company graph to invite anyone into.
 *
 * Test List:
 * 1. a known personal provider (gmail.com) -> true
 * 2. a company domain -> false
 * 3. case-insensitive on the domain
 * 4. malformed input (no @, trailing @) -> false, not a throw
 */
import { describe, expect, it } from 'vitest';
import { isPersonalEmailDomain } from '../lib/personal-email-domains.js';

describe('isPersonalEmailDomain', () => {
  it('is true for a known personal provider', () => {
    expect(isPersonalEmailDomain('dev@gmail.com')).toBe(true);
  });

  it('is true for a second personal provider (triangulates the set, not one hardcoded string)', () => {
    expect(isPersonalEmailDomain('dev@icloud.com')).toBe(true);
  });

  it('is false for a company domain', () => {
    expect(isPersonalEmailDomain('tom@align.tech')).toBe(false);
  });

  it('matches the domain case-insensitively', () => {
    expect(isPersonalEmailDomain('Dev@GMAIL.COM')).toBe(true);
  });

  it('is false, not a throw, for an address with no @', () => {
    expect(isPersonalEmailDomain('not-an-email')).toBe(false);
  });

  it('is false, not a throw, for an address with a trailing @ and no domain', () => {
    expect(isPersonalEmailDomain('dev@')).toBe(false);
  });
});
