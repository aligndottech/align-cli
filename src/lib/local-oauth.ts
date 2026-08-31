import open from 'open';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { waitForLoopbackRedirect } from './loopback-redirect.js';
import { exchangePkceCode, SECRET_FREE_CONNECTORS } from './secret-free-oauth.js';
import { buildAuthorizeUrl, createPkcePair } from './pkce.js';
import { pollForDeviceToken, requestDeviceCode } from './device-flow.js';
import { checkGithubAppInstallation } from './github-install-check.js';
import { resolveClientId } from './public-client-ids.js';

/**
 * Connector sign-in for TRUE LOCAL mode, with no hosted call and no client secret.
 *
 * The whole point of ALI-778. Local mode's one promise is that nothing leaves the
 * machine, and today's connector OAuth breaks it by routing through the gateway to
 * borrow a client_secret. Device flow (GitHub) and PKCE (GitLab, Linear, Zoom) need
 * no secret, so the CLI can run the flow itself.
 *
 * Returns null when the connector has no secret-free flow, when it is unconfigured,
 * or when the user declines - every one of which must fall back to the paste rather
 * than fail, because a broken sign-in that blocks setup is worse than a paste.
 */
export async function trySecretFreeOAuth(connectorId: string): Promise<string | null> {
  const cfg = SECRET_FREE_CONNECTORS[connectorId];
  if (!cfg) return null;

  // Public client ids are committed in public-client-ids.ts - they are not secrets
  // and appear in every authorize URL - with the env var kept as an override for a
  // self-managed instance. Null means we cannot ship one for this connector yet, and
  // `pendingConnectors()` records why; fall through to the paste quietly.
  //
  // This used to read process.env directly while a comment claimed the ids shipped in
  // the binary. Nothing set those variables, so the whole secret-free path was dead
  // for every user and the comment was the only thing saying otherwise.
  const clientId = resolveClientId(connectorId);
  if (!clientId) return null;

  try {
    return cfg.kind === 'device'
      ? await runDeviceFlow(connectorId, cfg.deviceCodeUrl!, cfg.tokenUrl, clientId, cfg.scope)
      : await runPkceFlow(connectorId, cfg.authorizeUrl!, cfg.tokenUrl, clientId, cfg.scope, cfg.extra);
  } catch (err) {
    p.log.warn(`  ${connectorId}: sign-in failed (${(err as Error).message}). Falling back to a token paste.`);
    return null;
  }
}

async function runDeviceFlow(
  id: string, deviceCodeUrl: string, tokenUrl: string, clientId: string, scope: string,
): Promise<string | null> {
  const code = await requestDeviceCode({ deviceCodeUrl, clientId, scope });

  // Print the code BEFORE opening a browser. If the open fails, or there is no
  // browser at all (SSH, container), the user can still finish by hand - which is
  // the main reason device flow suits a terminal.
  p.log.info(
    `  Enter this code at ${chalk.bold(code.verificationUri)}\n` +
    `    ${chalk.bold(code.userCode)}`,
  );
  await open(code.verificationUri).catch(() => {});

  const spin = p.spinner();
  spin.start(`Waiting for you to approve ${id}...`);
  const result = await pollForDeviceToken({
    tokenUrl, clientId, deviceCode: code.deviceCode,
    intervalMs: code.intervalMs, expiresAt: code.expiresAt,
  });
  if (!result.ok) { spin.stop(`${id} not connected (${result.reason})`); return null; }
  spin.stop(`${id} connected`);

  // Authorizing the App and INSTALLING it are separate grants, and installing on an
  // organisation belongs to its owner. So a token here can legitimately see nothing,
  // and the user finds out much later as an import that returns no decisions.
  if (id === 'github') await reportGithubInstallation(result.accessToken);
  return result.accessToken;
}

async function reportGithubInstallation(token: string): Promise<void> {
  const check = await checkGithubAppInstallation(token);
  if (check.errored || check.installed) {
    if (!check.errored && check.accounts.length) {
      p.log.info(chalk.dim(`  Reading from: ${check.accounts.join(', ')}`));
    }
    return;
  }

  // No default slug. A guessed one builds a plausible URL that 404s, which is worse
  // than no link: the user follows it, lands on a GitHub error, and cannot tell
  // whether the app or their org is at fault. 'align-personal' was invented here and
  // matches nothing in the org.
  const slug = process.env.ALIGN_GITHUB_APP_SLUG;
  const where = slug
    ? `  Install it (read-only) here:\n    ${chalk.bold(`https://github.com/apps/${slug}/installations/new`)}`
    : `  Install the Align GitHub App (read-only) on the account that owns your repos.\n` +
      `  Your existing installations: ${chalk.bold('https://github.com/settings/installations')}`;

  p.log.warn(
    `  Signed in, but the Align GitHub App is not installed on any account yet,\n` +
    `  so it can read no repositories.\n\n` +
    `${where}\n\n` +
    `  On a personal account that takes one click. On an organisation, GitHub sends\n` +
    `  a request to an owner - your setup finishes either way, and imports start\n` +
    `  working once it is approved.`,
  );
}

async function runPkceFlow(
  id: string, authorizeUrl: string, tokenUrl: string, clientId: string,
  scope: string, extra?: Record<string, string>,
): Promise<string | null> {
  const { verifier, challenge } = createPkcePair();
  const spin = p.spinner();

  // waitForLoopbackRedirect, NOT waitForCallback. The latter serves the hosted
  // gateway's browser page, which POSTs JSON carrying a cli_nonce; it answers 405 to
  // the plain GET a provider actually sends and never reads the query string. Wiring
  // PKCE to it meant the browser hit a 405 and the flow sat until its five-minute
  // timeout - unreachable until now only because no client id was ever configured.
  //
  // It also mints and CHECKS the state itself. The previous code passed a nonce as
  // `state` and nothing read it back, while a comment claimed a stray request "cannot
  // be mistaken for this flow's response".
  let redirectUri = '';
  const redirect = waitForLoopbackRedirect({
    timeoutMs: 5 * 60 * 1000,
    onBound: async (port, state) => {
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const url = buildAuthorizeUrl({
        authorizeUrl, clientId, redirectUri, scope, state, challenge,
        ...(extra ? { extra } : {}),
      });
      p.log.info(chalk.dim(`  Opening ${id} in your browser to approve read-only access...`));
      await open(url).catch(() => {
        p.log.info(chalk.dim(`  If nothing opened, visit:\n    ${url}`));
      });
      spin.start(`Waiting for ${id} approval...`);
    },
  });

  let code: string;
  try {
    ({ code } = await redirect);
  } catch (err) {
    // Includes the provider's own reason on an error redirect, which is far more
    // useful than the timeout the old path always produced.
    spin.stop(`${id} not connected (${(err as Error).message})`);
    return null;
  }

  const exchanged = await exchangePkceCode({ tokenUrl, clientId, code, verifier, redirectUri });
  if (exchanged.ok) { spin.stop(`${id} connected`); return exchanged.accessToken; }
  spin.stop(`${id} not connected (${exchanged.reason})`);
  return null;
}
