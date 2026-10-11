/**
 * Where `align invite` sends the admin: Settings > Team invites in the web app.
 *
 * The gateway accepts POST /admin/invites only from an interactive org-admin login and refuses an
 * api_token, on purpose: an agent's token must not add team members. So the CLI creates nothing;
 * it works out the web app and points at the page.
 *
 * The web app, in order: a team destination's address saved at join time; else the gateway's own
 * `app_url` when it is a plain https origin (http only for localhost); else the guess from the
 * gateway address (the hosted app for prod). The page carries no secret, so a gateway that
 * answers badly or not at all only means the guess is used.
 */
import type { EnvironmentConfig } from './config.js';
import { assertTransport } from './destination-trust.js';
import { resolveAppUrl } from './env-resolver.js';

export function inviteSettingsUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/settings?tab=invites`;
}

export async function resolveInviteAppUrl(env: EnvironmentConfig, gatewayAppUrl: () => Promise<string | null>): Promise<string> {
  if (env.kind === 'team' && env.appUrl) return env.appUrl.replace(/\/+$/, '');
  if (env.authToken) {
    try {
      const named = await gatewayAppUrl();
      if (named !== null) return assertTransport(named);
    } catch {
      // No answer, or one that is not a plain origin: use the guess below.
    }
  }
  return resolveAppUrl(env);
}
