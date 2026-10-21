const DAY_MS = 86_400_000;

/**
 * One line about when the login token expires, or null when there is nothing to say.
 * null, absent and unparseable all print nothing: an older gateway does not send the field,
 * and "absent" must never read as "never expires" or as an error.
 * `now` is injected so the caller (and the tests) own the clock.
 */
export function formatLoginExpiry(expiresAt: string | null | undefined, now: Date): string | null {
  if (!expiresAt) return null;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;
  const date = expiry.toISOString().slice(0, 10);
  const msLeft = expiry.getTime() - now.getTime();
  if (msLeft <= 0) return `Login expired: ${date}. Run: align login`;
  const days = Math.floor(msLeft / DAY_MS);
  if (days === 0) return `Login expires: ${date} (today)`;
  return `Login expires: ${date} (in ${days} ${days === 1 ? 'day' : 'days'})`;
}
