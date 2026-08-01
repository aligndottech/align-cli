/**
 * ALI-403: one `cli.command` event per invocation, so cloud CLI activation and weekly
 * retention are countable before the end-Oct checkpoint.
 *
 * Cloud mode only, by design. A cloud user is already talking to our gateway on an
 * authenticated connection, so an event about a call already being made is not a new
 * phone-home. A `--local` user never contacts us at all and has no tenant, so counting
 * them needs an explicit consent flow - a separate slice, not this one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { recordCommandUsage, TELEMETRY_TIMEOUT_MS } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const cloudEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'jwt-token',
  tenantId: 'tenant-123',
  mode: 'auth',
};

const localEnv: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: null,
  tenantId: null,
  mode: 'local-embedded',
};

/** Body of the single fetch call, asserted non-empty so a missed call cannot pass vacuously. */
function sentBody(): Record<string, unknown> {
  const args = mockFetch.mock.calls[0];
  if (!args) throw new Error('fetch was not called');
  const init = args[1] as { body?: string } | undefined;
  if (!init?.body) throw new Error('fetch was called without a body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('recordCommandUsage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    // The precondition is "not opted out". State it - do not inherit it from the shell.
    vi.stubEnv('ALIGN_TELEMETRY', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('posts one cli.command event naming the command, in cloud mode', async () => {
    await recordCommandUsage(cloudEnv, 'import');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.align.tech/telemetry/ingest');
    expect(sentBody()).toMatchObject({
      eventName: 'cli.command',
      category: 'engagement',
      platform: 'cli',
      properties: { command: 'import' },
    });
  });

  // Second example for the same rule: pins that the command name is read, not hardcoded.
  it('names a different command correctly', async () => {
    await recordCommandUsage(cloudEnv, 'check');

    expect(sentBody()).toMatchObject({ properties: { command: 'check' } });
  });

  it('sends nothing in local mode, where there is no tenant and no consent', async () => {
    await recordCommandUsage(localEnv, 'import');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Found by an end-to-end smoke, not by the unit tests above: the postAction hook resolves the
  // DEFAULT env, so a user who is logged in for cloud AND runs `align local ...` has a cloud
  // token in hand. Sending then would phone home about a command whose whole point is that it
  // does not leave the machine.
  it('sends nothing for an `align local` command even when a cloud token is stored', async () => {
    await recordCommandUsage(cloudEnv, 'local ask');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Second example for the same rule: it is the `local` group that is excluded, not one command.
  it('sends nothing for any other local subcommand either', async () => {
    await recordCommandUsage(cloudEnv, 'local import');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The boundary: a command merely *starting with* the letters "local" is not the local group.
  it('still sends for a command whose name only begins with "local"', async () => {
    await recordCommandUsage(cloudEnv, 'localize');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when ALIGN_TELEMETRY=0, even in cloud mode', async () => {
    vi.stubEnv('ALIGN_TELEMETRY', '0');

    await recordCommandUsage(cloudEnv, 'import');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves when the gateway rejects, so telemetry can never fail a command', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(recordCommandUsage(cloudEnv, 'import')).resolves.toBeUndefined();
  });

  // A blackholing proxy or captive portal does not reject, it hangs. Awaiting that would make
  // `align import` appear to freeze after it has already finished its real work.
  it('gives up rather than hanging the CLI when the gateway never answers', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementationOnce(() => new Promise(() => {}));

      const pending = recordCommandUsage(cloudEnv, 'import');
      await vi.advanceTimersByTimeAsync(TELEMETRY_TIMEOUT_MS);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
