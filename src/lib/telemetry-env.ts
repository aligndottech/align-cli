/**
 * ALI-954: the two environment variables that turn ALL telemetry off - both tiers, the
 * default-on beacons included. Its own module so the consent prompt (telemetry-consent.ts)
 * can ask the same question without importing the emitter, which setup.test.ts mocks down to
 * one function.
 *
 * The two read in opposite directions, each erring toward sending nothing:
 * - `ALIGN_TELEMETRY` (ours, ALI-618): set and not recognisably ON means OFF. Enumerating the
 *   falsy words instead guesses at what a user will type, and every miss is a live send by
 *   someone who believes they opted out.
 * - `DO_NOT_TRACK` (consoledonottrack.com, the cross-tool convention): set and not
 *   recognisably OFF means "do not track". The convention says `1`; a user who exports `true`
 *   means the same thing, and `DO_NOT_TRACK=0` is the one spelling that means nothing.
 * Both trimmed, because a trailing newline comes free from a `.env` file or a here-doc.
 */
export type TelemetryEnvSwitch = 'DO_NOT_TRACK' | 'ALIGN_TELEMETRY';

const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/** The variable that disables telemetry, or undefined when neither does. */
export function telemetryDisabledByEnv(): TelemetryEnvSwitch | undefined {
  const dnt = process.env['DO_NOT_TRACK']?.trim().toLowerCase();
  if (dnt !== undefined && dnt !== '' && !OFF_VALUES.has(dnt)) return 'DO_NOT_TRACK';
  const ours = process.env['ALIGN_TELEMETRY']?.trim().toLowerCase();
  if (ours !== undefined && ours !== '' && !ON_VALUES.has(ours)) return 'ALIGN_TELEMETRY';
  return undefined;
}
