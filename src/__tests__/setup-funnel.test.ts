/**
 * ALI-949: the two setup funnel stages, `setup_started` and `setup_completed`, had no
 * emitter anywhere in src/ - the PostHog funnel read setup_completed = 0 for launch week
 * while two installs completed the wizard. This is the object `runSetup` carries through
 * the wizard so both entry points (bare `align`, `align setup`) share one implementation.
 *
 * The wrinkle it exists for: in local mode the consent question is asked MID-wizard (ALI-794
 * puts value before questions), so at the moment the wizard starts nothing can be sent.
 * `started()` therefore BUFFERS - it may be offered the env at every checkpoint (wizard
 * start, after consent, after login) and sends exactly once, at the first checkpoint where
 * the emitter reports a send. recordFunnelStage owns sendability; this object owns "once".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

const recordFunnelStage = vi.hoisted(() => vi.fn());
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { createSetupFunnel } from '../lib/setup-funnel.js';

const unsendable: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' };
const sendable: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't1', mode: 'auth' };
const localEnv: EnvironmentConfig = { gatewayUrl: 'http://localhost:8080', authToken: null, tenantId: null, mode: 'local-embedded' };

function stageCalls(stage: string): unknown[][] {
  return recordFunnelStage.mock.calls.filter((c) => c[1] === stage);
}

describe('createSetupFunnel', () => {
  beforeEach(() => {
    recordFunnelStage.mockReset();
    // The emitter reports whether it SENT (true) - a token-less cloud env or an
    // unconsented local env returns false, which is what the buffering keys on.
    recordFunnelStage.mockImplementation(async (env: EnvironmentConfig) =>
      env.mode === 'local-embedded' ? env.tenantId === 'consented' : Boolean(env.authToken && env.tenantId));
  });

  it('setup_started: offered an unsendable env at wizard start, sends at the next sendable checkpoint', async () => {
    const funnel = createSetupFunnel();

    await funnel.started(unsendable);
    expect(stageCalls('setup_started')).toHaveLength(1); // attempted, and reported unsent
    await funnel.started(sendable);

    const calls = stageCalls('setup_started');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([sendable, 'setup_started', 'setup']);
  });

  it('setup_started: once sent, later checkpoints do not send again', async () => {
    const funnel = createSetupFunnel();

    await funnel.started(sendable);
    await funnel.started(sendable);
    await funnel.started({ ...localEnv, tenantId: 'consented' });

    expect(stageCalls('setup_started')).toHaveLength(1);
  });

  // Local-mode consent is granted mid-wizard: the first offer (cloud default, no token)
  // cannot send, the second (local env, consent just granted) can. Second example of the
  // buffering rule, on the path the ticket is about.
  it('setup_started: local mode sends once consent exists, with the local env', async () => {
    const funnel = createSetupFunnel();

    await funnel.started(unsendable);
    await funnel.started({ ...localEnv, tenantId: 'consented' });

    const calls = stageCalls('setup_started');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toMatchObject({ mode: 'local-embedded' });
  });

  // The checkpoints fire without being awaited at the call sites (`void funnel.started(env)`,
  // so a slow gateway never delays the wizard), which means two offers can be in flight at
  // once. They must still resolve to ONE send: the second waits for the first's verdict.
  it('setup_started: two overlapping offers still send exactly once', async () => {
    const funnel = createSetupFunnel();

    const first = funnel.started(sendable);
    const second = funnel.started(sendable);
    await Promise.all([first, second]);

    expect(stageCalls('setup_started')).toHaveLength(1);
  });

  it('setup_completed: sends once with the env the wizard finished in', async () => {
    const funnel = createSetupFunnel();

    await funnel.completed(sendable);

    expect(stageCalls('setup_completed')).toEqual([[sendable, 'setup_completed', 'setup']]);
  });

  it('setup_completed: a second call in the same run does not send again', async () => {
    const funnel = createSetupFunnel();

    await funnel.completed(sendable);
    await funnel.completed(sendable);

    expect(stageCalls('setup_completed')).toHaveLength(1);
  });

  it('the two stages are independent: completing never counts as starting', async () => {
    const funnel = createSetupFunnel();

    await funnel.completed(sendable);

    expect(stageCalls('setup_started')).toHaveLength(0);
  });
});
