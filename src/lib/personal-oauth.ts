// The Align Personal OAuth flow, shared by `align setup` and `align import <src> --personal`
// (ALI-388). Lifted verbatim from setup.ts so both entry points use one implementation: the
// gateway's /oauth/cli-start/:key begins the flow, the browser lands credentials on the
// localhost listener (cli-oauth.ts), and tokens persist in the local config under the
// connector's oauth key - the gateway's CLI branch never writes them server-side.
import * as p from '@clack/prompts';
import chalk from 'chalk';
import open from 'open';
import type { createConfigStore, EnvName } from './config.js';
import type { createGatewayClient } from './gateway-client.js';
import { CLI_CALLBACK_PORTS, waitForCallback } from './cli-oauth.js';

type ConfigStore = ReturnType<typeof createConfigStore>;
type GatewayClient = ReturnType<typeof createGatewayClient>;

/** The subset of a setup source the OAuth flow needs; setup's SetupSource is assignable. */
export interface OAuthSource {
  oauthKey?: string;
  label: string;
}

// Jira and Confluence share one Atlassian OAuth app: one consent connects both, so a
// user connecting "Jira" isn't surprised that Confluence is connected too.
const ATLASSIAN_OAUTH_KEYS = new Set(['jira-personal', 'confluence-personal']);
export function isAtlassianOAuth(source: OAuthSource): boolean {
  return !!source.oauthKey && ATLASSIAN_OAUTH_KEYS.has(source.oauthKey);
}
export function oauthFlowLabel(source: OAuthSource): string {
  return isAtlassianOAuth(source) ? 'Atlassian (Jira & Confluence)' : source.label;
}
function connectorDisplayName(connectorKey: string): string {
  if (connectorKey.startsWith('confluence')) return 'Confluence';
  if (connectorKey.startsWith('jira')) return 'Jira';
  return connectorKey;
}

export async function collectTokensViaOAuth(
  source: OAuthSource,
  client: GatewayClient,
  config: ConfigStore,
  envName: EnvName,
  reset = false,
  connectedThisRun?: Set<string>,
): Promise<Record<string, string> | null> {
  const key = source.oauthKey!;

  const readCachedTokens = (): Record<string, string> | null => {
    const cached = config.getConnectorToken(envName, key);
    if (!cached) return null;
    const cachedCloudId = config.getConnectorCloudId(envName, key);
    const cachedSiteBase = config.getConnectorSiteBase(envName, key);
    return {
      token: cached,
      ...(cachedCloudId ? { cloudId: cachedCloudId } : {}),
      ...(cachedSiteBase ? { siteBase: cachedSiteBase } : {}),
    };
  };

  // Connected earlier in THIS run (the Atlassian sibling: Jira and Confluence
  // share one OAuth app + token, so one consent connects both). Reuse it even
  // under --reset, which is meant to ignore STALE tokens from prior runs, not
  // ones just obtained moments ago this run.
  if (connectedThisRun?.has(key)) {
    const reused = readCachedTokens();
    if (reused) {
      p.log.info(chalk.dim(`  ${source.label}: already connected via a shared sign-in this run`));
      return reused;
    }
  }

  if (!reset) {
    const cached = readCachedTokens();
    if (cached) {
      p.log.info(chalk.dim(`  ${source.label}: using cached OAuth token (run align setup --reset to re-auth)`));
      return cached;
    }
  }

  const spinner = p.spinner();
  spinner.start(`Opening browser for ${oauthFlowLabel(source)} OAuth...`);

  let authUrl = '';
  const callbackPromise = waitForCallback({
    ports: CLI_CALLBACK_PORTS,
    timeoutMs: 120_000,
    onBound: async (port, nonce) => {
      try {
        const result = await client.startCliOAuth(key, port, nonce);
        authUrl = result.authUrl;
        await open(authUrl).catch(() => {});
        spinner.stop(`Browser opened for ${oauthFlowLabel(source)}. If nothing happened, visit:\n  ${chalk.bold(authUrl)}`);
        p.log.info('Waiting for you to approve in the browser (2 min timeout)...');
      } catch (e) {
        spinner.stop(`Could not start OAuth for ${source.label}: ${(e as Error).message}`);
      }
    },
  });

  let result: { data: Record<string, unknown>; port: number };
  try {
    result = await callbackPromise;
  } catch (e) {
    p.log.warn(`${source.label} OAuth timed out or failed: ${(e as Error).message}`);
    return null;
  }

  const credentials = result.data['credentials'] as Record<string, unknown> | undefined;
  const accessToken = credentials?.['access_token'] as string | undefined;

  if (!accessToken) {
    p.log.warn(`${source.label} OAuth did not return an access token.`);
    return null;
  }

  // accessToken being truthy guarantees credentials is defined
  persistConnectorCreds(config, envName, key, credentials as Record<string, unknown>);
  connectedThisRun?.add(key);

  // Atlassian: Jira and Confluence share one OAuth app, so a single consent
  // returns the sibling's credentials too. Persist them AND mark the sibling
  // connected this run so its own iteration reuses the token and skips a second
  // browser flow (even under --reset).
  const siblingConnector = result.data['siblingConnector'] as string | undefined;
  const siblingCreds = result.data['siblingCredentials'] as Record<string, unknown> | undefined;
  if (siblingConnector && siblingCreds?.['access_token']) {
    persistConnectorCreds(config, envName, siblingConnector, siblingCreds);
    connectedThisRun?.add(siblingConnector);
    p.log.info(chalk.dim(`  Also connected ${connectorDisplayName(siblingConnector)} (shared Atlassian app - no second sign-in needed)`));
  }

  const cloudId = credentials?.['site_id'] as string | undefined;
  const siteBase = credentials?.['base'] as string | undefined;
  return { token: accessToken, ...(cloudId ? { cloudId } : {}), ...(siteBase ? { siteBase } : {}) };
}

// Persist a connector's OAuth token plus Atlassian cloudId/site base so future
// runs (and `align import`) can reuse the credentials without re-auth.
export function persistConnectorCreds(
  config: ConfigStore,
  envName: EnvName,
  key: string,
  credentials: Record<string, unknown>,
): void {
  const accessToken = credentials['access_token'] as string | undefined;
  if (!accessToken) return;
  config.setConnectorToken(envName, key, accessToken);
  const cloudId = credentials['site_id'] as string | undefined;
  if (cloudId) config.setConnectorCloudId(envName, key, cloudId);
  const siteBase = credentials['base'] as string | undefined;
  if (siteBase) config.setConnectorSiteBase(envName, key, siteBase);
}

// ---------------------------------------------------------------------------
// `align import <src> --personal` (ALI-388)
// ---------------------------------------------------------------------------

/**
 * Import source id -> the gateway OAuth key for a personal (non-admin) connection.
 * Every key here must exist in the gateway's getOAuthConfig switch. Teams and Zoom have
 * no separate personal app; the CLI flow uses the org key and the gateway's CLI branch
 * keeps the credentials local either way.
 */
export const PERSONAL_OAUTH_KEYS: Record<string, string> = {
  github: 'github-personal',
  gitlab: 'gitlab-personal',
  linear: 'linear-personal',
  notion: 'notion-personal',
  slack: 'slack-personal',
  jira: 'jira-personal',
  confluence: 'confluence-personal',
  teams: 'teams',
  zoom: 'zoom',
};

export interface PersonalCreds {
  token: string;
  cloudId?: string;
  siteBase?: string;
}

/**
 * Resolve credentials for `align import <src> --personal`: the cached personal OAuth token
 * when one exists, otherwise the browser flow. Throws with a user-readable message when the
 * flow cannot run here - callers print it and exit rather than opening a doomed browser.
 */
export async function personalCredsForImport(
  sourceId: string,
  label: string,
  deps: {
    config: ConfigStore;
    envName: EnvName;
    env: { mode?: string; authToken?: string | null };
    client: GatewayClient;
  },
): Promise<PersonalCreds> {
  const oauthKey = PERSONAL_OAUTH_KEYS[sourceId];
  if (!oauthKey) {
    throw new Error(`--personal is not supported for ${sourceId}. Pass --token instead.`);
  }
  if (deps.env.mode === 'local-embedded') {
    throw new Error(
      '--personal needs a cloud environment: the OAuth flow starts at the Align gateway. Run `align login` and retry with --env prod (or preview), or keep using --token.'
    );
  }
  if (!deps.env.authToken) {
    throw new Error('--personal requires an Align login first: run `align login`, then retry.');
  }

  const tokens = await collectTokensViaOAuth({ oauthKey, label }, deps.client, deps.config, deps.envName);
  if (!tokens?.token) {
    throw new Error(`${label} OAuth did not complete. Retry, or pass --token instead.`);
  }
  return {
    token: tokens.token,
    ...(tokens.cloudId ? { cloudId: tokens.cloudId } : {}),
    ...(tokens.siteBase ? { siteBase: tokens.siteBase } : {}),
  };
}
