import { telemetryDisabledByEnv } from './telemetry-env.js';
import { inCi } from './telemetry-ci.js';
import type { TelemetryConsent } from './config.js';

/**
 * Narrow interface rather than the whole config store, so this module (and its tests) does not
 * carry every unrelated accessor `createConfigStore()` exposes.
 */
export interface TelemetryNoticeStore {
  getTelemetryConsent(): TelemetryConsent | undefined;
  getTelemetryNoticeShownAt(): string | undefined;
  markTelemetryNoticeShown(): void;
}

/**
 * C6: the disclosure. Local-mode telemetry is opt-out, and this notice is what makes it so: it
 * prints once, to stderr, before anything is sent, and nothing that depends on it sends until
 * it has printed (usage-telemetry.ts's localTierAllows). The founder-approved wording - change
 * it only with the privacy page (align.tech/privacy#cli) and docs/telemetry.md in the same PR.
 */
export const TELEMETRY_NOTICE =
  'Align sends anonymous usage counts: which commands and coding agent you use,\n' +
  'which tools you connect and how many items, the CLI version, and your OS.\n' +
  'Never code, decision text, or file, repo or org names.\n' +
  'Turn it off: align telemetry off (or DO_NOT_TRACK=1). Details: align.tech/privacy#cli';

export interface NoticeContext {
  /** The invocation's command path ("ask", "telemetry off", "align" for the bare command). */
  command: string;
  /** Running as an agent hook (`check --hook` / `--advisory`): nobody is reading stderr. */
  hook: boolean;
  /** A cloud login token is in hand: cloud mode has its own, authenticated events. */
  cloudSignedIn: boolean;
}

const isSet = (v: string | undefined): boolean => v !== undefined && v !== '';

/**
 * Shows the notice and marks it shown, or does neither. Skipped, and NOT marked, wherever
 * nobody is reading it or it would be moot: no terminal on stdin and stderr, CI, an agent hook, `align mcp` (an agent's stdio
 * server), a run inside a launched agent (ALIGN_WRAPPED), `align telemetry ...` (the off switch
 * must not be raced by what it switches off), an env switch that already turns everything off,
 * and any stored decision (granted, declined or off - that user was already asked or chose).
 * Because it is not marked, nothing that waits on it sends from those runs either.
 *
 * Returns whether it printed. Never throws: a broken config store costs the notice, which means
 * nothing sends - the safe direction.
 */
export function maybeShowTelemetryNotice(
  config: TelemetryNoticeStore,
  ctx: NoticeContext,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): boolean {
  try {
    const top = ctx.command.split(' ')[0];
    if (top === 'mcp' || top === 'telemetry') return false;
    if (ctx.hook || ctx.cloudSignedIn) return false;
    if (isSet(process.env['ALIGN_WRAPPED'])) return false;
    if (telemetryDisabledByEnv() !== undefined || inCi()) return false;
    if (config.getTelemetryConsent() !== undefined) return false;
    if (config.getTelemetryNoticeShownAt() !== undefined) return false;
    // The real control (review of e794c6e, P0): the notice is the disclosure every local send
    // waits on, so it counts only when a person can read it. A person at a terminal has both
    // stdin and stderr on it. Anything else - stderr to /dev/null, a pipe, a hook runner, cron,
    // systemd, `docker build`, an agent's Bash tool - prints nothing and marks nothing, so
    // nothing sends until a real terminal run shows it.
    if (!process.stderr.isTTY || !process.stdin.isTTY) return false;
    write(`${TELEMETRY_NOTICE}\n\n`);
    config.markTelemetryNoticeShown();
    return true;
  } catch {
    return false;
  }
}
