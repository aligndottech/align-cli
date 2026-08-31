import open from 'open';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { CLI_CALLBACK_PORTS, waitForCallback } from './cli-oauth.js';
import { exchangePkceCode, SECRET_FREE_CONNECTORS } from './secret-free-oauth.js';
import { buildAuthorizeUrl, createPkcePair } from './pkce.js';
import { pollForDeviceToken, requestDeviceCode } from './device-flow.js';
import { chooseGithubVariant } from './github-choice.js';

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
  // GitHub is the one connector with two secret-free paths, and choosing between
  // them is a decision only the user can make: the read-only App may not be
  // installable on their org, and the alternative is write-capable. See ALI-98's
  // 2026-08-31 amendment.
  if (connectorId === 'github') {
    const variant = await chooseGithubVariant({
      'github-app': process.env['ALIGN_GITHUB_APP_PUBLIC_CLIENT_ID'],
      'github-oauth': process.env['ALIGN_GITHUB_OAUTH_PUBLIC_CLIENT_ID'],
    });
    if (!variant) return null;
    const clientId = process.env[variant.clientIdEnv];
    if (!clientId) return null;
    try {
      return await runDeviceFlow(connectorId, variant.deviceCodeUrl, variant.tokenUrl, clientId, variant.scope);
    } catch (err) {
      p.log.warn(`  ${connectorId}: sign-in failed (${(err as Error).message}). Falling back to a token paste.`);
      return null;
    }
  }

  const cfg = SECRET_FREE_CONNECTORS[connectorId];
  if (!cfg) return null;

  // Public client ids ship in the binary; they are not secrets and appear in every
  // authorize URL. Absent means this build was not configured for it, which is a
  // normal state, not an error - fall through to the paste quietly.
  const clientId = process.env[cfg.clientIdEnv];
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
  if (result.ok) { spin.stop(`${id} connected`); return result.accessToken; }
  spin.stop(`${id} not connected (${result.reason})`);
  return null;
}

async function runPkceFlow(
  id: string, authorizeUrl: string, tokenUrl: string, clientId: string,
  scope: string, extra?: Record<string, string>,
): Promise<string | null> {
  const { verifier, challenge } = createPkcePair();

  // waitForCallback binds the port and mints its own nonce, reporting both through
  // onBound - so the authorize URL can only be built once binding has happened. It
  // also tries several ports, so the redirect_uri is not knowable in advance.
  let redirectUri = '';
  const spin = p.spinner();

  const callback = waitForCallback({
    ports: [...CLI_CALLBACK_PORTS],
    timeoutMs: 5 * 60 * 1000,
    onBound: async (port, nonce) => {
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const url = buildAuthorizeUrl({
        authorizeUrl, clientId, redirectUri, scope,
        // Reuse the server's nonce as `state`: a stray request to the loopback port
        // then cannot be mistaken for this flow's response.
        state: nonce, challenge,
        ...(extra ? { extra } : {}),
      });
      p.log.info(chalk.dim(`  Opening ${id} in your browser to approve read-only access...`));
      await open(url).catch(() => {
        p.log.info(chalk.dim(`  If nothing opened, visit:\n    ${url}`));
      });
      spin.start(`Waiting for ${id} approval...`);
    },
  });

  const cb = await callback;
  const code = (cb.data as { code?: string })?.code;
  if (!code) { spin.stop(`${id} not connected`); return null; }

  const exchanged = await exchangePkceCode({ tokenUrl, clientId, code, verifier, redirectUri });
  if (exchanged.ok) { spin.stop(`${id} connected`); return exchanged.accessToken; }
  spin.stop(`${id} not connected (${exchanged.reason})`);
  return null;
}
