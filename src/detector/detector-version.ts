/**
 * Which local relationship detector runs: `ALIGN_DETECTOR`, `v0` (default) or `v1`.
 *
 * v1 is the shared detector (one call per check over every candidate, the hosted base prompt,
 * the `incompatible` verdict resolved deterministically). v0 is the pairwise classifier the CLI
 * shipped first. v1 is the default on a hosted route (where it matches the paid product) and v0 on a local
 * route (small local models lose recall on v1). ALIGN_DETECTOR and a saved choice override both. The Phase A
 * confirmatory run met its rule on claude-haiku-4-5 only, and it lowers recall on llama3.2, so
 * the default was reverted to v0 (scores in docs/local-mode.md). An unknown value is an error,
 * never a fallback: a typo must not silently run the default.
 */
export const DETECTOR_VERSIONS = ['v0', 'v1'] as const;
export type DetectorVersion = (typeof DETECTOR_VERSIONS)[number];

export function resolveDetectorVersion(
  env: Record<string, string | undefined> = process.env,
  saved?: string,
  route?: 'hosted' | 'local',
): DetectorVersion {
  const raw = env['ALIGN_DETECTOR'];
  if (raw === undefined || raw.trim() === '') {
    // The saved choice (`align config detector`) applies when the env var is unset. It is validated
    // here too, so a hand-edited value fails loudly instead of quietly running the default.
    if (saved === undefined) return route === 'hosted' ? 'v1' : 'v0';
    if ((DETECTOR_VERSIONS as readonly string[]).includes(saved)) return saved as DetectorVersion;
    throw new Error(`detector "${saved}" in the saved config is not a detector version. Allowed: ${DETECTOR_VERSIONS.join(', ')}. Fix it with: align config detector v0`);
  }
  const value = raw.trim();
  if ((DETECTOR_VERSIONS as readonly string[]).includes(value)) return value as DetectorVersion;
  throw new Error(`ALIGN_DETECTOR="${raw}" is not a detector version. Allowed: ${DETECTOR_VERSIONS.join(', ')} (unset means v0).`);
}

/** Where the active detector comes from, for `align config detector` and `align status`. */
export function detectorSource(
  env: Record<string, string | undefined>,
  saved: string | undefined,
  route?: 'hosted' | 'local',
): string {
  if (env['ALIGN_DETECTOR']?.trim()) return 'ALIGN_DETECTOR';
  if (saved !== undefined) return 'saved with align config detector';
  return route === undefined ? 'default' : `default for a ${route} model`;
}
