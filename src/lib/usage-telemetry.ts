import type { EnvironmentConfig } from './config.js';

/**
 * ALI-403: emit one `cli.command` event per invocation so cloud CLI activation and weekly
 * retention are countable.
 *
 * Cloud mode only. A cloud user is already on an authenticated connection to our gateway, so
 * an event about a call already being made is not a new phone-home. `--local` users never
 * contact us and have no tenant, so counting them needs an explicit consent flow and its own
 * storage (`telemetry_events.tenant_id` is `NOT NULL REFERENCES tenants(id)`).
 *
 * Set `ALIGN_TELEMETRY=0` (or `false` / `no` / `off`) to opt out entirely.
 */
export const TELEMETRY_TIMEOUT_MS = 2_000;

const OPT_OUT_VALUES = new Set(['0', 'false', 'no', 'off']);

export async function recordCommandUsage(env: EnvironmentConfig, command: string): Promise<void> {
  if (OPT_OUT_VALUES.has((process.env['ALIGN_TELEMETRY'] ?? '').toLowerCase())) return;
  // `align local ...` is the explicitly-offline path. Its caller may still hold a cloud token
  // (the hook may resolve an env other than the one the command used), so the token check below
  // is not enough on its own.
  if (command === 'local' || command.startsWith('local ')) return;
  // The mode is the consent boundary (PR #77: cloud is opt-out, local is no-phone-home). It has
  // to gate on its own because a token can be in scope without cloud consent: ALIGN_TOKEN
  // exported into the shell, or a logged-in default env resolved by the caller.
  if (env.mode === 'local-embedded') return;
  if (!env.authToken || !env.tenantId) return;

  // A blackholing proxy hangs rather than rejecting, so a bare await would freeze the CLI after
  // its real work is done. The timer both aborts the request and wins the race, so we stop
  // waiting even if the transport ignores the signal.
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
    await Promise.race([
      fetch(`${env.gatewayUrl}/telemetry/ingest`, {
        method: 'POST',
        signal: controller.signal,
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
      }),
      abandoned,
    ]);
  } catch {
    // Telemetry must never fail a command. Swallowing here is driven by a test, not defensive
    // habit - see "resolves when the gateway rejects" in usage-telemetry.test.ts.
  } finally {
    clearTimeout(timer);
  }
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
  const value = cmd.optsWithGlobals()['env'];
  return typeof value === 'string' ? value : undefined;
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
 * `preferLocalEmbedded` is deliberately NOT passed: it is a routing preference for the
 * read commands, and asking for it here would be a second opinion on where the command
 * went. The flag and ALIGN_ENV are what the user chose explicitly, and those are what a
 * consent decision may rest on.
 */
export async function recordInvocationUsage(
  envFlag: string | undefined,
  command: string,
): Promise<void> {
  const { createConfigStore } = await import('./config.js');
  const { resolveEnv } = await import('./resolve-env.js');
  const config = createConfigStore();
  await recordCommandUsage(config.getEnvironment(resolveEnv(envFlag)), command);
}
