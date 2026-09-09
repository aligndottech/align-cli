import type { EnvironmentConfig } from './config.js';
import { recordFunnelStage } from './usage-telemetry.js';

/**
 * ALI-949: the setup wizard's two funnel stages, carried through `runSetup` so bare
 * `align` and `align setup` share one emitter (both run runSetup's body).
 *
 * `started` BUFFERS rather than sends. When a mode branch begins nothing may be sendable
 * on a fresh install: cloud has no token until login, and local mode asks for consent
 * mid-wizard (ALI-794 puts the found-decisions moment before any question, and that order
 * is not negotiable here). So the wizard offers the current env at each checkpoint - the
 * top of the local value phase, after consent, the top of cloud setup, after login - and
 * this object sends at the first offer the emitter reports as sent. Sendability is
 * recordFunnelStage's decision, not repeated here.
 *
 * "Once" is per IDENTITY, not per run. A local-mode ping is keyed on the machine's
 * installId; a cloud ping on the tenant. Nothing joins the two, so a fresh-install user who
 * consents locally and then chooses "sync to the cloud" would otherwise leave
 * `setup_started` under one identity and `setup_completed` under the other (fresh-context
 * review on #279). A later checkpoint on the OTHER transport therefore sends again under
 * its own identity; the same transport never repeats.
 *
 * What that means for the funnel: in local mode `setup_started` says "started, and got as
 * far as consenting" rather than "typed the command". A user who declines consent is never
 * counted at any stage, which is the consent model, not a gap.
 *
 * Offers are serialised through one promise chain because call sites fire them without
 * awaiting (`void funnel.started(env)` - a slow gateway must not delay the wizard), so two
 * offers can overlap; the second waits for the first's verdict before deciding to send.
 * `completed` queues behind the started chain too (Copilot on #279): a started send still
 * in flight when the wizard finishes must not be overtaken, or the install's two events
 * reach the gateway out of order. By the outro the started send has long settled, so this
 * costs nothing in practice and is the ordering guarantee when it has not.
 */
export interface SetupFunnel {
  started(env: EnvironmentConfig): Promise<void>;
  completed(env: EnvironmentConfig): Promise<void>;
}

/** Which identity a ping for this env lands under - see recordFunnelStage's two branches. */
type Transport = 'anonymous' | 'cloud';
const transportOf = (env: EnvironmentConfig): Transport => (env.mode === 'local-embedded' ? 'anonymous' : 'cloud');

export function createSetupFunnel(): SetupFunnel {
  // The transports setup_started has been sent on so far.
  let startedChain: Promise<ReadonlySet<Transport>> = Promise.resolve(new Set());
  let completedChain: Promise<boolean> = Promise.resolve(false);
  return {
    async started(env) {
      startedChain = startedChain.then(async (sentOn) => {
        const transport = transportOf(env);
        if (sentOn.has(transport)) return sentOn;
        const sent = await recordFunnelStage(env, 'setup_started', 'setup');
        return sent ? new Set([...sentOn, transport]) : sentOn;
      });
      await startedChain;
    },
    async completed(env) {
      // Capture the previous link BEFORE reassigning, or the new chain waits on itself.
      const previous = completedChain;
      completedChain = startedChain
        .then(() => previous)
        .then((sent) => (sent ? true : recordFunnelStage(env, 'setup_completed', 'setup')));
      await completedChain;
    },
  };
}
