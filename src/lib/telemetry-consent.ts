import * as p from '@clack/prompts';

/**
 * Narrow interface rather than the whole config store, so this module (and its tests) does not
 * carry every unrelated accessor `createConfigStore()` exposes.
 */
export interface TelemetryConsentStore {
  getTelemetryConsent(): 'granted' | 'declined' | undefined;
  setTelemetryConsent(value: 'granted' | 'declined'): void;
}

/**
 * ALI-618 D3: the one-time local-mode consent prompt, shown from `runLocalSetup()`.
 *
 * Never asks twice - a decision already on disk (granted OR declined) is left alone. Never
 * prompts without a TTY on both streams: a piped `setup --local` run hangs on a prompt it
 * cannot answer, and a closed stdin crashes clack's raw-mode init AFTER the real setup work has
 * already succeeded (the align-cli#118 lesson, `setup-local-non-tty.test.ts`). A non-interactive
 * run leaves consent UNSET rather than implicitly declined - a scripted first run may be a CI
 * smoke test, not a real user's choice, and it can still be asked on a later interactive run.
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

  const answer = await p.confirm({
    message:
      'Help improve Align? Send an anonymous count of which commands you run - no code, no ' +
      'decisions, no file names, ever. You can change this any time with `align telemetry off`.',
    initialValue: false,
  });

  config.setTelemetryConsent(!p.isCancel(answer) && answer ? 'granted' : 'declined');
}
