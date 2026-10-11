/**
 * Which local relationship detector runs: `ALIGN_DETECTOR`, `v0` (default) or `v1`.
 *
 * v0 is the pairwise classifier the CLI has always shipped. v1 is the shared detector (one call
 * per check over every candidate, the hosted base prompt, the `incompatible` verdict resolved
 * deterministically). The default stays v0 until the Phase A benchmark's preregistered rule says
 * otherwise. An unknown value is an error, never a fallback: a typo must not silently run v0.
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
