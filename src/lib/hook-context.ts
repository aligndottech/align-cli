/**
 * ALI-835: whether this process is running as an agent's hook.
 *
 * A funnel stage means "a person got this far". A hook does not: it runs on the agent's clock,
 * many times in a session, with nobody watching. A ping from there measures an editing loop and
 * lands in the same column as a human milestone, so the two become indistinguishable in the
 * scoreboard - which is worse than not measuring, because the number still looks like a number.
 *
 * Deliberately an explicit mark rather than sniffing the environment. The alternatives were
 * both worse:
 *
 *   - Reading stdin to see whether a hook payload is there consumes the payload the command is
 *     about to parse, and blocks when no hook is piping anything.
 *   - Guessing from an env var means enumerating what every host agent happens to set, and each
 *     miss is a live ping from a context that promised not to send one. That is the
 *     hand-enumeration failure latent-vs-deterministic.md names: a too-narrow list returns "no
 *     match", which is indistinguishable from "not a hook".
 *
 * So the hook entry points say so themselves, once, and this module is the single reader. A new
 * hook surface that forgets to call `markHookContext` sends pings it should not - which is a
 * miss in the same direction as the env-var guess, but a visible one: it is a missing call at a
 * named entry point rather than a missing string in a list nobody can enumerate.
 */
let hookContext = false;

/** Called by every entry point that is running as an agent hook, before any work. */
export function markHookContext(): void {
  hookContext = true;
}

export function inHookContext(): boolean {
  return hookContext;
}

/** Test-only reset. Module state outlives a test file otherwise, so one case that marks the
 *  context would silently mark every case after it. */
export function resetHookContextForTests(): void {
  hookContext = false;
}
