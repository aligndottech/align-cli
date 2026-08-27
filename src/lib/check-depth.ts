/**
 * The one writer of the check-depth vocabulary (ALI-708).
 *
 * A leaf module on purpose: the option help, the CLI validation and BOTH gateway-client
 * signatures derive from this, and it lives outside gateway-client.js because tests mock
 * that module wholesale - a VALUE exported from it would have to be re-declared in every
 * mock (seven suites broke this way in review). Types are erased, so the clients import
 * the type from here without any mock noticing.
 *
 *   'related'    retrieval only - the editor hook's <=10s budget.
 *   'full'       the gateway default: adjudication behind its similarity cost gate.
 *   'exhaustive' adjudicate whatever was retrieved - for strict CI gates whose fail-on
 *                treats unknown as failure. Requires a gateway that knows the member.
 */
export const CHECK_DEPTHS = ['related', 'full', 'exhaustive'] as const;
export type CheckDepth = (typeof CHECK_DEPTHS)[number];
