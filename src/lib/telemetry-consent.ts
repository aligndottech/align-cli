import * as p from '@clack/prompts';
import { telemetryDisabledByEnv } from './telemetry-env.js';

/**
 * Narrow interface rather than the whole config store, so this module (and its tests) does not
 * carry every unrelated accessor `createConfigStore()` exposes.
 */
export interface TelemetryConsentStore {
  getTelemetryConsent(): 'granted' | 'declined' | 'off' | undefined;
  setTelemetryConsent(value: 'granted' | 'declined' | 'off'): void;
}

/**
 * ALI-618 D3: the one-time local-mode consent prompt, shown from `runLocalSetup()`.
 *
 * Never asks twice - a decision already on disk (granted, declined, or `align telemetry off`)
 * is left alone. Never prompts without a TTY on both streams: a piped `setup --local` run
 * hangs on a prompt it cannot answer, and a closed stdin crashes clack's raw-mode init AFTER
 * the real setup work has already succeeded (the align-cli#118 lesson,
 * `setup-local-non-tty.test.ts`). A non-interactive run leaves consent UNSET rather than
 * implicitly declined - a scripted first run may be a CI smoke test, not a real user's choice,
 * and it can still be asked on a later interactive run.
 *
 * ALI-954: an env var that already turns everything off (`DO_NOT_TRACK=1`, `ALIGN_TELEMETRY=0`)
 * skips the question with a one-line note - asking would imply the answer matters - and
 * leaves the decision unset for the same reason as the non-interactive case.
 *
 * The question is about USAGE (which commands you run). The two anonymous counts the docs
 * describe (install, setup completed) are not what is being asked about here and send either
 * way; `align telemetry off` is what stops those (docs/telemetry.md).
 *
 * Default is No: anything other than an explicit yes - the default answer, or Ctrl-C - leaves
 * telemetry off (D3).
 */
export async function maybeRequestTelemetryConsent(
  config: TelemetryConsentStore,
  interactive: boolean,
): Promise<void> {
  if (config.getTelemetryConsent() !== undefined) return;
  if (!interactive) return;

  const envSwitch = telemetryDisabledByEnv();
  if (envSwitch !== undefined) {
    p.log.info(`Telemetry is off (${envSwitch} is set), so nothing is sent and you won't be asked.`);
    return;
  }

  const answer = await p.confirm({
    message:
      'Help improve Align? Send an anonymous count of which commands you run - no code, no ' +
      'decisions, no file names, ever. You can change this any time with `align telemetry off`.',
    initialValue: false,
  });

  config.setTelemetryConsent(!p.isCancel(answer) && answer ? 'granted' : 'declined');
}
