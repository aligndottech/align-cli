/**
 * Which local relationship detector runs: `ALIGN_DETECTOR`, `v1` (default) or `v0`.
 *
 * v1 is the shared detector (one call per check over every candidate, the hosted base prompt,
 * the `incompatible` verdict resolved deterministically). v0 is the pairwise classifier the CLI
 * shipped first, still selectable with ALIGN_DETECTOR=v0. v1 became the default when the Phase A
 * confirmatory run (arm A4, the CLI's own v1 request) met the preregistered rule on
 * claude-haiku-4-5; the scores are in docs/local-mode.md. An unknown value is an error, never a
 * fallback: a typo must not silently run the default.
 */
export const DETECTOR_VERSIONS = ['v0', 'v1'] as const;
export type DetectorVersion = (typeof DETECTOR_VERSIONS)[number];

export function resolveDetectorVersion(env: Record<string, string | undefined> = process.env): DetectorVersion {
  const raw = env['ALIGN_DETECTOR'];
  if (raw === undefined || raw.trim() === '') return 'v1';
  const value = raw.trim();
  if ((DETECTOR_VERSIONS as readonly string[]).includes(value)) return value as DetectorVersion;
  throw new Error(`ALIGN_DETECTOR="${raw}" is not a detector version. Allowed: ${DETECTOR_VERSIONS.join(', ')} (unset means v1).`);
}
