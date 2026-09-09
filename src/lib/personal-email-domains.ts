/**
 * ALI-938: which email domains are individual accounts rather than a company's.
 *
 * `align invite` needs to know whether the CALLER's own tenant is a work-domain org
 * (has room for a team) or a personal, single-person tenant (nothing to invite anyone
 * into) - the same distinction align-stack's gateway makes at signup
 * (`services/gateway/src/billing/provisioning.ts`, `PERSONAL_EMAIL_DOMAINS` /
 * `isPersonalEmailDomain`). This is a client-side mirror of that list for UX purposes
 * only - `align invite`'s messaging reads better when it can say so up front, but the
 * gateway is the actual authority on tenant type (it is the one that decided at signup).
 * Keep the two lists in sync by hand; there is no shared package between the two repos
 * for a list this short.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es',
  'outlook.com', 'live.com', 'msn.com',
  'aol.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'protonmail.ch', 'proton.me',
  'fastmail.com', 'fastmail.fm',
  'hey.com',
  'zoho.com',
]);

/**
 * Whether an email's domain is a personal-account provider rather than a company's own
 * domain. Malformed input (no `@`, an empty domain) answers false rather than throwing -
 * this is a messaging hint, never a validator, so an unparseable address should not crash
 * the command that is about to reject it for other reasons anyway.
 */
export function isPersonalEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}
