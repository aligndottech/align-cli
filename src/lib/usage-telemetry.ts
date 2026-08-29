import { ALIGN_HOSTED_GATEWAY_URL, type EnvironmentConfig, type TelemetryConsent } from './config.js';
import pkg from '../../package.json' with { type: 'json' };

/**
 * ALI-403: emit one `cli.command` event per invocation so cloud CLI activation and weekly
 * retention are countable.
 *
 * Cloud mode is opt-out: a cloud user is already on an authenticated connection to our
 * gateway, so an event about a call already being made is not a new phone-home. Local-embedded
 * mode (ALI-618) is opt-in instead: `--local` users have no account and no tenant, so there is
 * nothing to authenticate an event against, and nothing is sent until the user explicitly
 * consents (see `config.ts`'s `getTelemetryConsent`, set by the one-time prompt in
 * `commands/setup.ts`). Both modes send only a command name, never arguments or content.
 *
 * `ALIGN_TELEMETRY=0` (or `false` / `no` / `off`) is the single global off switch and wins in
 * both modes, over a granted local consent included (ALI-618 D3b - one consent model, not two).
 */
export const TELEMETRY_TIMEOUT_MS = 2_000;

/**
 * Set and not recognisably ON means OFF. Enumerating the falsy words instead - `0|false|no|off` -
 * guesses at what a user will type, and every guess that misses is a live send by someone who
 * believes they opted out: `disabled` and `n` both sent. Trimmed, because a trailing space or
 * newline comes free from a `.env` file or a here-doc. Unset is ON, which is the documented
 * cloud default and the only value this cannot see.
 */
const OPT_IN_VALUES = new Set(['1', 'true', 'yes', 'on']);

function telemetryOptedOut(): boolean {
  const raw = process.env['ALIGN_TELEMETRY'];
  if (raw === undefined || raw.trim() === '') return false;
  return !OPT_IN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * POST with a hard timeout, and never throw - telemetry must never fail or delay a command. A
 * blackholing proxy hangs rather than rejecting, so a bare `fetch` would freeze the CLI after
 * its real work is done. The timer both aborts the request and wins the race, so we stop
 * waiting even if the transport ignores the signal. Shared by the cloud and local-embedded send
 * paths below, which were two copies of this exact race before extraction (fresh-context review).
 */
async function postWithTimeout(url: string, init: NonNullable<Parameters<typeof fetch>[1]>): Promise<void> {
  const controller = new AbortController();
  let giveUp: () => void = () => {};
  const abandoned = new Promise<void>((resolve) => {
    giveUp = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    giveUp();
  }, TELEMETRY_TIMEOUT_MS);

  try {
    await Promise.race([fetch(url, { ...init, signal: controller.signal }), abandoned]);
  } catch {
    // Telemetry must never fail a command - see "resolves when the gateway rejects" and
    // "gives up rather than hanging" in usage-telemetry.test.ts / usage-telemetry-anonymous.test.ts.
  } finally {
    clearTimeout(timer);
  }
}

export interface TelemetryStatus {
  enabled: boolean;
  reason: string;
}

/**
 * ALI-618 D3b: what `align telemetry status` prints. Takes the consent decision as a plain
 * argument rather than reading `config.ts` itself, so the two consent MODELS stay visibly
 * distinct in one function a reader can hold in their head - cloud's opt-out default and
 * local's stored opt-in decision - with `ALIGN_TELEMETRY=0` as the one thing that overrides
 * both, checked first.
 */
export function getTelemetryStatus(
  env: EnvironmentConfig,
  localConsent: TelemetryConsent | undefined,
): TelemetryStatus {
  if (telemetryOptedOut()) {
    return { enabled: false, reason: 'off: ALIGN_TELEMETRY is set to an opt-out value' };
  }
  if (env.mode === 'local-embedded') {
    if (localConsent === 'granted') {
      return { enabled: true, reason: 'on: local mode, you opted in when asked' };
    }
    if (localConsent === 'declined') {
      return { enabled: false, reason: 'off: local mode, you declined when asked' };
    }
    return { enabled: false, reason: 'off: local mode, you have not been asked yet' };
  }
  return { enabled: true, reason: 'on: cloud mode, opt-out default' };
}

export async function recordCommandUsage(env: EnvironmentConfig, command: string): Promise<void> {
  if (telemetryOptedOut()) return;
  // `align local ...` is the explicitly-offline path. Its caller may still hold a cloud token
  // (the hook may resolve an env other than the one the command used), so the token check below
  // is not enough on its own.
  if (command === 'local' || command.startsWith('local ')) return;
  // The mode is the consent boundary (PR #77: cloud is opt-out; ALI-618: local is opt-in via a
  // stored consent decision, never a phone-home by default). It has to gate on its own because
  // a token can be in scope without cloud consent: ALIGN_TOKEN exported into the shell, or a
  // logged-in default env resolved by the caller.
  if (env.mode === 'local-embedded') {
    await recordAnonymousCommandUsage(command);
    return;
  }
  if (!env.authToken || !env.tenantId) return;

  await postWithTimeout(`${env.gatewayUrl}/telemetry/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.authToken}`,
      'x-tenant-id': env.tenantId,
    },
    body: JSON.stringify({
      eventName: 'cli.command',
      category: 'engagement',
      platform: 'cli',
      properties: { command },
    }),
  });
}

/**
 * ALI-618: the local-embedded sibling of the cloud send above. No Authorization, no tenant -
 * there is neither. Gated on a machine-local consent decision instead of a token, and the
 * payload carries exactly three fields (install id, command name, CLI version) so there is
 * nothing here for the gateway's strict schema to reject and nothing beyond what the consent
 * prompt promises. See usage-telemetry-anonymous.test.ts.
 *
 * Targets `ALIGN_HOSTED_GATEWAY_URL`, never a `gatewayUrl` off the env - local-embedded mode
 * makes no HTTP call for its own work (an embedded local DB client, see gateway-client.ts), so
 * the `local` env's `gatewayUrl` is a vestigial `demo`-mode default nothing real listens on.
 * A fresh-context review caught this: the original version sent every local ping to
 * `http://localhost:8080`, silently discarded, for every user who had not separately stood up
 * a local dev gateway.
 */
async function recordAnonymousCommandUsage(command: string): Promise<void> {
  const { createConfigStore } = await import('./config.js');
  const config = createConfigStore();
  if (config.getTelemetryConsent() !== 'granted') return;

  const installId = config.getInstallId();
  const topLevelCommand = command.split(' ')[0] ?? command;
  const target = process.env['ALIGN_GATEWAY_URL'] || ALIGN_HOSTED_GATEWAY_URL;

  await postWithTimeout(`${target}/telemetry/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installId, command: topLevelCommand, cliVersion: pkg.version }),
  });
}

/**
 * The `--env` the user actually typed, including one Commander handed to a parent.
 *
 * `align import git --env local` leaves the subcommand's own `opts()` empty, because `--env`
 * is declared on both and Commander resolves that in the parent's favour (align-cli#79, which
 * fixed the same read for the import commands via subcommandOpts). Reading `.opts()` here
 * would send a local command's event to the cloud default - this slice's own bug, one layer up.
 */
export function envFlagOf(cmd: { optsWithGlobals(): Record<string, unknown> }): string | undefined {
  const opts = cmd.optsWithGlobals();
  const value = opts['env'];
  if (typeof value === 'string') return value;
  // `align setup --local` is how a user ENTERS local mode, and it is not spelled `--env local`,
  // so reading only `env` reported the one command whose whole purpose is going private. Checked
  // after `env` so an explicitly typed cloud env still wins.
  if (opts['local'] === true) return 'local';
  return undefined;
}

/**
 * Resolve the env the command actually addressed, then report against THAT.
 *
 * The postAction hook used to hand over `getEnvironment(getDefaultEnv())`, and
 * `align setup --local` deliberately leaves the default env alone (local-mode.ts), so a
 * machine that had ever run `align login` reported every `ask --env local` to the cloud -
 * the one thing PR #77 said local mode does not do. Only the three-member `local` command
 * group was excluded, and no local user types `align local ask`.
 *
 * `preferLocalEmbedded` IS now passed (ALI-618) - this paragraph used to say it was
 * deliberately withheld, on the reasoning that the flag/ALIGN_ENV the user explicitly chose is
 * what a CLOUD consent decision may rest on. That reasoning never covered local telemetry: the
 * redirect only ever fires when the cloud env has no token, which is exactly the case
 * recordCommandUsage's cloud branch already drops on its own (`if (!env.authToken || ...)
 * return`) - so passing it here cannot cause an extra cloud send, only let a genuinely
 * never-logged-in user's BARE command reach the local-embedded branch at all. Without it, that
 * exact audience - "never met Tom" - resolved to the tokenless cloud default on every bare
 * command and recordCommandUsage silently dropped it: neither cloud nor local ever counted
 * them, which defeated the whole point of adding local telemetry. A fresh-context review
 * caught this too. Fixed in `usage-telemetry-invocation-local-only.test.ts`.
 *
 * `setup` is suppressed once local-embedded is configured. The interactive "Local only" choice
 * sets no flag, and the default env stays cloud on purpose, so the only evidence the session was
 * local is what the run left behind - and a `setup` that ends with the machine in local mode is
 * a local session. It costs one activation count on a once-per-machine command, in the direction
 * that cannot leak.
 */
export async function recordInvocationUsage(
  envFlag: string | undefined,
  command: string,
): Promise<void> {
  const { createConfigStore } = await import('./config.js');
  const { resolveEnv } = await import('./resolve-env.js');
  const config = createConfigStore();
  if (command === 'setup' && config.getEnvironment('local').mode === 'local-embedded') return;
  await recordCommandUsage(config.getEnvironment(resolveEnv(envFlag, { preferLocalEmbedded: true })), command);
}
