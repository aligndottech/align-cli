/**
 * Which local relationship detector runs: `ALIGN_DETECTOR`, `v0` (default) or `v1`.
 *
 * v1 is the shared detector (one call per check over every candidate, the hosted base prompt,
 * the `incompatible` verdict resolved deterministically). v0 is the pairwise classifier the CLI
 * shipped first, and it stays the default. v1 is opt-in with ALIGN_DETECTOR=v1. The Phase A
 * confirmatory run met its rule on claude-haiku-4-5 only, and it lowers recall on llama3.2, so
 * the default was reverted to v0 (scores in docs/local-mode.md). An unknown value is an error,
 * never a fallback: a typo must not silently run the default.
 */
export const DETECTOR_VERSIONS = ['v0', 'v1'] as const;
export type DetectorVersion = (typeof DETECTOR_VERSIONS)[number];

export function resolveDetectorVersion(env: Record<string, string | undefined> = process.env): DetectorVersion {
  const raw = env['ALIGN_DETECTOR'];
  if (raw === undefined || raw.trim() === '') return 'v0';
  const value = raw.trim();
  if ((DETECTOR_VERSIONS as readonly string[]).includes(value)) return value as DetectorVersion;
  throw new Error(`ALIGN_DETECTOR="${raw}" is not a detector version. Allowed: ${DETECTOR_VERSIONS.join(', ')} (unset means v0).`);
}
