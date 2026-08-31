/**
 * The public OAuth client ids the CLI ships with, and what is stopping the ones
 * it does not.
 *
 * A public client id is NOT a secret. It appears in every authorize URL and in the
 * device-code request; RFC 8252 and RFC 8628 both assume a distributed client
 * carries one. So it is committed here rather than injected at build time.
 *
 * This file exists because ALI-778 shipped without it. `SECRET_FREE_CONNECTORS`
 * declared four connectors, the code read `process.env[cfg.clientIdEnv]`, and no
 * build step, workflow or user ever set those variables - so device flow and PKCE
 * were unreachable for every user while the comment above them said the ids "ship
 * in the binary". The map below cannot make that mistake quietly: an unshipped id
 * is `null` WITH A REASON, a parity test pins it against the connector list, and
 * `pendingConnectors()` lets the CLI say which ones are not live yet.
 */

export interface PublicClientId {
  /** The committed id, or null when we cannot ship one yet. */
  value: string | null;
  /** Why it is null. Required whenever value is null. */
  pending?: string;
  /**
   * GitHub only: the App's slug, for the installation link.
   *
   * It lives here rather than in an env var because it is a public fact about our own
   * app, exactly like the client id beside it, and the two are only ever correct
   * together. #196 removed a GUESSED default ('align-personal') that built a 404
   * install link; an unset env var was the honest stand-in until the app existed.
   */
  slug?: string;
}

/**
 * Verified 2026-08-31 against the org's app listing, the gateway's sealed secrets
 * and each provider's own docs - not inferred from the connector list.
 *
 * ALI-778 recorded "the Align (Personal) apps exist and have been tested", which is
 * true of the HOSTED flow and does not answer this question. A confidential client
 * registered for a secret-bearing exchange is not automatically usable for one
 * without a secret, so each row below needs its own answer.
 */
export const PUBLIC_CLIENT_IDS: Record<string, PublicClientId> = {
  // Align CLI, App id 4783216, owned by @aligndottech. Verified 2026-08-31 against
  // GitHub rather than taken on trust: POST /login/device/code returned a real
  // device_code, so Device Flow is genuinely enabled (it is opt-in per app and off by
  // default, which is the setting that fails silently); GET /apps/align-cli reports
  // contents=read, issues=read, metadata=read, pull_requests=read and no events, which
  // is where the read-only guarantee actually lives - a GitHub App IGNORES the OAuth
  // scope field, so no CLI-side test can see it.
  github: {
    value: 'Iv23liYLBYF1E7nAQS7D',
    slug: 'align-cli',
  },
  gitlab: {
    value: null,
    pending:
      'GITLAB_PERSONAL_CLIENT_ID is sealed for the hosted flow, where the app is a ' +
      'CONFIDENTIAL client. PKCE needs a public one, and unticking Confidential on ' +
      'the existing app would break personal cloud, so this likely needs a second app.',
  },
  linear: {
    value: null,
    pending:
      'LINEAR_PERSONAL_CLIENT_ID is sealed for the hosted flow. Linear documents PKCE ' +
      'at the protocol level but not whether a confidential registration accepts it, ' +
      'so the existing app has to be tried before its id is shipped here.',
  },
  zoom: {
    value: null,
    pending:
      'there is no Zoom personal app at all - the gateway has ZOOM_CLIENT_ID (the ' +
      'shared team app) and no ZOOM_PERSONAL_CLIENT_ID in any chart or sealed secret. ' +
      "Zoom's docs require a SEPARATE public client id with no secret regardless.",
  },
};

/**
 * Env var that overrides the baked id, for self-managed instances.
 *
 * Derived with no exceptions on purpose. GitHub briefly used a different shape
 * (ALIGN_GITHUB_APP_PUBLIC_CLIENT_ID), which cost nothing to drop because no
 * published build has ever carried either name - confirmed against the 0.26.3
 * tarball - so no user can have one set. A rule with an exception list drifts; a
 * derivation cannot.
 */
export function overrideVarFor(connectorId: string): string {
  return `ALIGN_${connectorId.toUpperCase()}_PUBLIC_CLIENT_ID`;
}

/**
 * The client id to use, or null when the connector cannot run a secret-free flow.
 *
 * The override wins because a self-managed GitLab runs its own OAuth app, for which
 * our shipped id is simply wrong. An EMPTY override is ignored rather than honoured:
 * `FOO= align setup` would otherwise build an authorize URL with `client_id=`, which
 * fails at the provider with an error naming nothing useful.
 */
export function resolveClientId(
  connectorId: string,
  env: Record<string, string | undefined> = process.env,
  ids: Record<string, PublicClientId> = PUBLIC_CLIENT_IDS,
): string | null {
  const entry = ids[connectorId];
  if (!entry) return null;
  const override = env[overrideVarFor(connectorId)];
  if (override) return override;
  return entry.value;
}

/** Every connector declaring a secret-free flow that cannot yet run one, and why. */
export function pendingConnectors(): { id: string; reason: string }[] {
  return Object.entries(PUBLIC_CLIENT_IDS)
    .filter(([, e]) => e.value === null)
    .map(([id, e]) => ({ id, reason: e.pending ?? 'no reason recorded' }));
}

/**
 * Where to install the GitHub App, or null when we do not know.
 *
 * Null is a real answer, not a gap. #196 removed a guessed slug that built a
 * plausible 404: the user follows it, lands on a GitHub error, and cannot tell whether
 * the app is broken or their org blocked it. No link beats a wrong one.
 */
export function githubInstallUrl(
  env: Record<string, string | undefined> = process.env,
  ids: Record<string, PublicClientId> = PUBLIC_CLIENT_IDS,
): string | null {
  const slug = env.ALIGN_GITHUB_APP_SLUG || ids.github?.slug;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}
