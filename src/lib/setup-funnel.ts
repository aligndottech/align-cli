import type { EnvironmentConfig } from './config.js';
import { recordFunnelStage } from './usage-telemetry.js';

/**
 * ALI-949: the setup wizard's two funnel stages, carried through `runSetup` so bare
 * `align` and `align setup` share one emitter (both run runSetup's body).
 *
 * `started` BUFFERS rather than sends. At wizard start nothing can be sent on a fresh
 * install: cloud has no token until login, and local mode asks for consent mid-wizard
 * (ALI-794 puts the found-decisions moment before any question, and that order is not
 * negotiable here). So the wizard offers the current env at each checkpoint - start,
 * after consent, after login - and this object sends exactly once, at the first offer the
 * emitter reports as sent. Sendability is recordFunnelStage's decision, not repeated here.
 *
 * What that means for the funnel: in local mode `setup_started` says "started, and got as
 * far as consenting" rather than "typed the command". A user who declines consent is never
 * counted at any stage, which is the consent model, not a gap. `setup_completed` is only
 * ever offered once, at the outro, so it needs no buffering; the once-guard on it is a
 * belt for a future second outro.
 *
 * Offers are serialised through one promise chain because call sites fire them without
 * awaiting (`void funnel.started(env)` - a slow gateway must not delay the wizard), so two
 * offers can overlap; the second waits for the first's verdict before deciding to send.
 */
export interface SetupFunnel {
  started(env: EnvironmentConfig): Promise<void>;
  completed(env: EnvironmentConfig): Promise<void>;
}

export function createSetupFunnel(): SetupFunnel {
  let startedChain: Promise<boolean> = Promise.resolve(false);
  let completedChain: Promise<boolean> = Promise.resolve(false);
  const offer = (chain: Promise<boolean>, env: EnvironmentConfig, stage: 'setup_started' | 'setup_completed') =>
    chain.then((sent) => (sent ? true : recordFunnelStage(env, stage, 'setup')));
  return {
    async started(env) {
      startedChain = offer(startedChain, env, 'setup_started');
      await startedChain;
    },
    async completed(env) {
      completedChain = offer(completedChain, env, 'setup_completed');
      await completedChain;
    },
  };
}
