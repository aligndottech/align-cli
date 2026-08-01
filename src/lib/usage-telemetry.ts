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
 * Set `ALIGN_TELEMETRY=0` to opt out entirely.
 */
export const TELEMETRY_TIMEOUT_MS = 2_000;

export async function recordCommandUsage(env: EnvironmentConfig, command: string): Promise<void> {
  if (process.env['ALIGN_TELEMETRY'] === '0') return;
  // `align local ...` is the explicitly-offline path. Its caller may still hold a cloud token
  // (the hook resolves the DEFAULT env, not the one the command used), so the token check below
  // is not enough on its own.
  if (command === 'local' || command.startsWith('local ')) return;
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
