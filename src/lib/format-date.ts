/**
 * Human-friendly timestamps for CLI output (ALI-118): relative for recent
 * decisions ("today", "3 days ago") so recency is obvious at a glance, absolute
 * ("30 May 2026") once it's older. `now` is injectable for deterministic tests.
 */
export function formatWhen(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';

  const abs = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); // "30 May 2026"
  const diffMs = now - t;
  if (diffMs < 0) return abs; // future-dated: just show the date

  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return abs;
}
