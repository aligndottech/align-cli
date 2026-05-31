import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import open from 'open';
import { execa } from 'execa';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { type PersonalImportItem, runPersonalImport } from '../lib/personal-import.js';
import { detectEditors, writeMcpConfig } from '../lib/mcp-setup.js';
import { isGitRepo } from '../lib/git.js';
import { initLocalMode } from '../lib/local-mode.js';
import { loginInteractive } from '../lib/login-flow.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { CLI_CALLBACK_PORTS, waitForCallback } from '../lib/cli-oauth.js';
import { AuthExpiredError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

// Connector OAuth scope tier, used to order the multiselect so a solo dev hits
// the frictionless personal-account connectors first:
//  - 'personal':  connect your own account, no admin (GitHub, GitLab, Linear, Notion, Zoom)
//  - 'site':      Atlassian 3LO - per-user consent, scoped to sites you belong to (Jira, Confluence)
//  - 'workspace': needs a workspace/org admin install (Slack, Teams)
type ConnectorTier = 'personal' | 'site' | 'workspace';
const TIER_ORDER: Record<ConnectorTier, number> = { personal: 0, site: 1, workspace: 2 };

interface SetupSource {
  id: string;
  label: string;
  description: string;
  tier?: ConnectorTier;
  oauthKey?: string;  // If set, uses browser OAuth flow via /oauth/cli-start/:key
  // When set, the connector uses OAuth (oauthKey) only if the named field is left
  // blank (the SaaS default host); a non-blank value (a self-managed host) falls
  // back to the token-paste path. GitLab: gitlab.com → OAuth, self-managed → PAT.
  hostGatedOAuth?: { field: string };
  tokenLabel?: string;
  tokenHint?: string;
  tokenUrl?: string | ((tokens: Record<string, string>) => string);  // If set, auto-opens this URL in the browser before prompting for the token
  extraFields?: Array<{ key: string; label: string; hint?: string; secret?: boolean }>;
  fetch: (tokens: Record<string, string>) => Promise<PersonalImportItem[]>;
}

function buildSources(gitAvailable: boolean): SetupSource[] {
  const sources: SetupSource[] = [];

  if (gitAvailable) {
    sources.push({
      id: 'git',
      label: 'Git',
      description: 'Commit history from this repo - no token needed',
      fetch: async () => {
        const { fetchGitItems } = await import('../lib/fetchers/git.js');
        return fetchGitItems({ limit: 500 });
      },
    });
  }

  sources.push(
    {
      id: 'github',
      label: 'GitHub',
      description: 'Your PRs and issues',
      tier: 'personal',
      oauthKey: 'github-personal',
      // Token-paste metadata is used only by local mode (cloud uses oauthKey/OAuth).
      tokenLabel: 'Personal access token',
      tokenHint: 'Use a fine-grained token, read-only: Contents, Issues, Pull requests = Read',
      tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
      fetch: async (t) => {
        const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
        return fetchGitHubItems({ token: t['token']!, limit: 100 });
      },
    },
    {
      id: 'jira',
      label: 'Jira',
      description: 'Your issues',
      tier: 'site',
      // Personal/CLI tier is read-only (no write:jira-work). The team/org
      // comment bot keeps write via the `jira` key. See ALI-94.
      oauthKey: 'jira-personal',
      // Local-mode token paste (read-only Atlassian API token + email + site).
      tokenLabel: 'API token',
      tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian account email' },
        { key: 'domain', label: 'Atlassian domain (yourorg.atlassian.net)' },
      ],
      fetch: async (t) => {
        const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
        return fetchJiraItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], limit: 100 });
      },
    },
    {
      id: 'confluence',
      label: 'Confluence',
      description: 'Your pages and documentation',
      tier: 'site',
      // Read-only personal/CLI tier. See ALI-94.
      oauthKey: 'confluence-personal',
      // Local-mode token paste (read-only Atlassian API token + email + site).
      tokenLabel: 'API token',
      tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian account email' },
        { key: 'domain', label: 'Atlassian domain (yourorg.atlassian.net)' },
      ],
      fetch: async (t) => {
        const { fetchConfluenceItems } = await import('../lib/fetchers/confluence.js');
        return fetchConfluenceItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], limit: 50 });
      },
    },
    {
      id: 'slack',
      label: 'Slack',
      description: 'Decision threads from your channels - may need workspace admin [experimental]',
      tier: 'workspace',
      // Read-only personal/CLI tier (no chat:write). The team/org bot keeps
      // chat:write via the `slack` key. See ALI-94.
      oauthKey: 'slack-personal',
      // Local-mode token paste: a Slack user token (xoxp-) with read scopes only.
      tokenLabel: 'User token (xoxp-...)',
      tokenHint: 'User token with read scopes only: channels:read, channels:history, groups:read, groups:history',
      tokenUrl: 'https://api.slack.com/apps',
      fetch: async (t) => {
        const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
        return fetchSlackItems({ token: t['token']!, limit: 50, daysBack: 90 });
      },
    },
    {
      id: 'teams',
      label: 'Microsoft Teams',
      description: 'Channel messages and decisions - may need org/workspace admin consent',
      tier: 'workspace',
      oauthKey: 'teams',
      fetch: async (t) => {
        const { fetchTeamsItems } = await import('../lib/fetchers/teams.js');
        return fetchTeamsItems({ token: t['token']!, limit: 50 });
      },
    },
    {
      id: 'zoom',
      label: 'Zoom',
      description: 'Cloud recording transcripts from your meetings',
      tier: 'personal',
      oauthKey: 'zoom',
      fetch: async (t) => {
        const { fetchZoomItems } = await import('../lib/fetchers/zoom.js');
        return fetchZoomItems({ token: t['token']!, limit: 30 });
      },
    },
    {
      id: 'gitlab',
      label: 'GitLab',
      description: 'Your merge requests',
      tier: 'personal',
      // gitlab.com → read-only browser OAuth (scope read_api, ALI-102). A
      // self-managed host (custom domain) can't use the fixed gitlab.com OAuth
      // app, so it falls back to the read-only PAT path below.
      oauthKey: 'gitlab-personal',
      hostGatedOAuth: { field: 'domain' },
      tokenLabel: 'Personal access token',
      // Read-only tier: steer users to the read-only scope. `api` would grant
      // write; `read_api` is read-only and all Align's import needs. See ALI-98.
      tokenHint: 'Select ONLY "read_api" (not "api") so the token stays read-only',
      tokenUrl: (t) => {
        const base = t['domain'] ? `https://${t['domain']}` : 'https://gitlab.com';
        return `${base}/-/user_settings/personal_access_tokens`;
      },
      extraFields: [
        { key: 'domain', label: 'GitLab domain (leave blank for gitlab.com)' },
      ],
      fetch: async (t) => {
        const { fetchGitLabItems } = await import('../lib/fetchers/gitlab.js');
        return fetchGitLabItems({ token: t['token']!, domain: t['domain'] || undefined, limit: 100 });
      },
    },
    {
      id: 'linear',
      label: 'Linear',
      description: 'Your issues and project discussions',
      tier: 'personal',
      // Read-only personal/CLI tier via browser OAuth (scope `read`), replacing the
      // full-access API-key paste. Requires the Linear OAuth app + sealed creds. See ALI-101.
      oauthKey: 'linear-personal',
      // Local-mode token paste: a Linear personal API key (read-only graph).
      tokenLabel: 'Personal API key (lin_api_...)',
      tokenUrl: 'https://linear.app/settings/api',
      fetch: async (t) => {
        const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
        return fetchLinearItems({ token: t['token']!, limit: 100 });
      },
    },
    {
      id: 'notion',
      label: 'Notion',
      description: 'Your pages and databases',
      tier: 'personal',
      // Read-only personal/CLI tier via browser OAuth (public integration),
      // replacing the internal-integration-secret paste in cloud. Read-only is
      // governed by the integration's capabilities (Read content), not scopes.
      // Requires the Notion OAuth app + sealed creds. See ALI-104.
      oauthKey: 'notion-personal',
      // Local-mode token paste: a read-only internal integration secret.
      tokenLabel: 'Integration secret (secret_...)',
      // Read-only tier: Align only reads. Notion integration capabilities are set
      // at creation - keep it to "Read content" (no insert/update). See ALI-98.
      tokenHint: 'Create an integration with ONLY "Read content" capability (no insert/update), then copy its Internal Integration Secret',
      tokenUrl: 'https://www.notion.so/my-integrations',
      fetch: async (t) => {
        const { fetchNotionItems } = await import('../lib/fetchers/notion.js');
        return fetchNotionItems({ token: t['token']!, limit: 50 });
      },
    },
  );

  return sources;
}

// ---------------------------------------------------------------------------
// Token collection helper
// ---------------------------------------------------------------------------

async function collectTokens(
  source: SetupSource,
  seed: Record<string, string> = {},
): Promise<Record<string, string> | null> {
  // `seed` pre-populates already-known fields (e.g. a self-managed host gathered
  // up front) so tokenUrl() resolves against the right host.
  const tokens: Record<string, string> = { ...seed };

  // Extra fields first (email, domain for Jira/Confluence)
  for (const field of source.extraFields ?? []) {
    // defaultValue '' so a blank submit renders empty, not the literal "undefined".
    const val = await p.text({ message: `  ${field.label}:`, defaultValue: '' });
    if (p.isCancel(val)) return null;
    tokens[field.key] = (val ?? '') as string;
  }

  // Main token
  if (source.tokenLabel) {
    if (source.tokenUrl) {
      const url = typeof source.tokenUrl === 'function' ? source.tokenUrl(tokens) : source.tokenUrl;
      p.log.info(chalk.dim(`  Opening ${source.label} in browser...`));
      await open(url).catch(() => {});
    }
    if (source.tokenHint) {
      p.log.info(chalk.dim(`  ${source.tokenHint}`));
    }
    const token = await p.password({ message: `  ${source.tokenLabel}:` });
    if (p.isCancel(token)) return null;
    tokens['token'] = token as string;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// OAuth browser flow helper for connectors
// ---------------------------------------------------------------------------

async function collectTokensViaOAuth(
  source: SetupSource,
  client: ReturnType<typeof createGatewayClient>,
  config: ReturnType<typeof createConfigStore>,
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
  spinner.start(`Opening browser for ${source.label} OAuth...`);

  let authUrl = '';
  const callbackPromise = waitForCallback({
    ports: CLI_CALLBACK_PORTS,
    timeoutMs: 120_000,
    onBound: async (port, nonce) => {
      try {
        const result = await client.startCliOAuth(key, port, nonce);
        authUrl = result.authUrl;
        await open(authUrl).catch(() => {});
        spinner.stop(`Browser opened for ${source.label}. If nothing happened, visit:\n  ${chalk.bold(authUrl)}`);
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
    p.log.info(chalk.dim(`  Also connected ${siblingConnector} (shared Atlassian app - no second sign-in needed)`));
  }

  const cloudId = credentials?.['site_id'] as string | undefined;
  const siteBase = credentials?.['base'] as string | undefined;
  return { token: accessToken, ...(cloudId ? { cloudId } : {}), ...(siteBase ? { siteBase } : {}) };
}

// Persist a connector's OAuth token plus Atlassian cloudId/site base so future
// runs (and `align import`) can reuse the credentials without re-auth.
function persistConnectorCreds(
  config: ReturnType<typeof createConfigStore>,
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
// Command registration
// ---------------------------------------------------------------------------

// Local-embedded onboarding (opt-in via --local): no account, no cloud, no OAuth.
// Initializes the local graph, wires editor MCP configs to --env local, and
// seeds the graph from git history - all on the user's machine. This is the
// privacy/offline escape hatch; the default solo experience is a personal
// cloud tenant (see the cloud path below).
async function runLocalSetup(): Promise<void> {
  const { dbPath } = await initLocalMode({ quiet: false });
  p.log.success('Local graph ready - no account needed, your data stays on this machine.');

  const config = createConfigStore();
  const localEnv = config.getEnvironment('local');
  const localClient = createGatewayClient(localEnv);

  if (await isGitRepo()) {
    console.log('');
    p.log.info(chalk.dim('First import downloads a small local embedding model (~90MB), one time.'));
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const items = await gitSource.fetch({});
      if (items.length) {
        gitSpinner.stop(`Found ${items.length} commits worth importing`);
        await runPersonalImport(items, localClient, {
          label: 'Git',
          approve: true,
          appUrl: resolveAppUrl(localEnv),
        });
      } else {
        gitSpinner.stop('No decisions found in git history');
      }
    } catch {
      gitSpinner.stop('Git import skipped');
    }
  }

  // Connectors: OAuth can't run offline (needs the hosted callback), so local mode
  // connects via manual read-only token paste. Only sources with a tokenLabel are
  // pasteable (Teams/Zoom have no personal token → excluded). See ALI-103.
  const localConnectors = buildSources(false)
    .filter((s) => s.id !== 'git' && s.tokenLabel)
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
  console.log('');
  const selected = await p.multiselect({
    message: 'Connect more sources with a read-only token? (skip to finish)',
    options: localConnectors.map((s) => ({ value: s.id, label: s.label, hint: s.description })),
    required: false,
  });
  if (!p.isCancel(selected)) {
    for (const id of selected as string[]) {
      const source = localConnectors.find((s) => s.id === id);
      if (!source) continue;
      console.log('');
      p.log.step(chalk.bold(source.label));
      const tokens = await collectTokens(source);
      if (!tokens) continue;
      const spinner = p.spinner();
      spinner.start(`Fetching from ${source.label}...`);
      try {
        const items = await source.fetch(tokens);
        spinner.stop(`Found ${items.length} items`);
        if (items.length) {
          await runPersonalImport(items, localClient, {
            label: source.label,
            approve: true,
            appUrl: resolveAppUrl(localEnv),
          });
        }
      } catch (e) {
        spinner.stop(`Skipped ${source.label} - ${(e as Error).message}`);
      }
    }
  }

  p.outro(
    `${chalk.green('You are set up in local mode.')}\n` +
    `  Graph: ${chalk.dim(dbPath)}\n` +
    `  Ask your agent: ${chalk.bold('"What decisions exist in this codebase?"')}\n` +
    `  ${chalk.dim('align local status')} shows stats; ${chalk.dim('align local reset')} wipes it.`,
  );
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Guided onboarding: connect your tools and configure MCP in one command')
    .option('--env <env>', 'Environment')
    .option('--approve', 'Skip confirmation prompts (for scripted use)')
    .option('--local', 'Set up local-only mode (no account, no cloud)')
    .option('--reset', 'Clear cached OAuth tokens and re-authenticate all connectors')
    .action(async (opts: { env?: EnvName; approve?: boolean; local?: boolean; reset?: boolean }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro(chalk.bgMagenta.white(' align setup '));

      // ---- Step 0: Cloud (default) vs local (--local) ----
      // Solo defaults to a personal CLOUD tenant: telemetry, the real cloud
      // relationship classifier, backup, and a clean upgrade path to a team
      // (reuses the personal->org join flow). --local is the opt-in offline
      // escape hatch; --approve runs the cloud path non-interactively.
      let mode: 'cloud' | 'local';
      if (opts.local) {
        mode = 'local';
      } else if (opts.approve) {
        mode = 'cloud';
      } else {
        const choice = await p.select({
          message: 'How are you using Align?',
          options: [
            { value: 'cloud', label: 'Cloud (recommended) - your personal decision graph', hint: 'syncs, backed up, upgradeable to a team' },
            { value: 'local', label: 'Local only - private, offline, no account', hint: 'stays on this machine (--local)' },
          ],
          initialValue: 'cloud',
        });
        if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
        mode = choice as 'cloud' | 'local';
      }

      if (mode === 'local') {
        await runLocalSetup();
        return;
      }

      await runCloudSetup({ opts, config, env, client, envName });
    });
}

// Cloud (personal-tenant) onboarding: verify login, wire MCP, seed from git,
// then offer personal-scoped connectors. A personal-email login lands on an
// isolated personal tenant server-side; connectors auto-bind to it.
async function runCloudSetup(ctx: {
  opts: { approve?: boolean; reset?: boolean };
  config: ReturnType<typeof createConfigStore>;
  env: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  client: ReturnType<typeof createGatewayClient>;
  envName: EnvName;
}): Promise<void> {
  const { opts, config, env, envName } = ctx;
  let client = ctx.client;

  // ---- Step 1: Auth check (inline login when interactive + unauthenticated) ----
  const authSpinner = p.spinner();
  authSpinner.start('Checking authentication...');
  try {
    const me = await client.whoami();
    authSpinner.stop(`Logged in as ${me.user.email} (${me.tenant?.name ?? envName})`);
  } catch {
    authSpinner.stop('Not authenticated');

    // Scripted runs (--approve) must not block on a browser; fail fast.
    if (opts.approve) {
      p.log.warn(`Run ${chalk.bold('align login')} first, then re-run ${chalk.bold('align setup')}.`);
      process.exit(1);
    }

    const wantLogin = await p.confirm({ message: 'Log in to Align now? (your personal cloud graph)' });
    if (!p.isCancel(wantLogin) && wantLogin) {
      const ok = await loginInteractive(env, envName, config);
      if (!ok) {
        p.log.warn(`Login did not complete. Run ${chalk.bold('align login')} and re-run ${chalk.bold('align setup')}.`);
        process.exit(1);
      }
      // Re-create the client so it carries the freshly stored token.
      client = createGatewayClient(config.getEnvironment(envName));
    } else {
      // Declined cloud login: offer the local escape hatch instead of failing.
      const wantLocal = await p.confirm({ message: 'Set up local-only mode instead? (no account, stays on this machine)' });
      if (!p.isCancel(wantLocal) && wantLocal) {
        await runLocalSetup();
        return;
      }
      p.log.warn(`Run ${chalk.bold('align login')} when ready, then ${chalk.bold('align setup')}.`);
      process.exit(1);
    }
  }

  // ---- Step 2: PATH check ----
  try {
    await execa('which', ['align']);
  } catch {
    p.log.warn(
      `The ${chalk.bold('align')} command is not on your PATH. ` +
      `Editor MCP configs won't work until you run: ${chalk.bold('npm install -g @aligndottech/cli')}`,
    );
  }

  // ---- Step 3: MCP editor config (before import - this is the payoff) ----
  console.log('');
  const editors = detectEditors();
  if (editors.length > 0) {
    p.log.info(`Detected ${editors.length} editor${editors.length === 1 ? '' : 's'}: ${editors.map(e => e.name).join(', ')}`);
    let selectedEditors: string[] = editors.map(e => e.name);
    if (editors.length > 1) {
      const sel = await p.multiselect({
        message: 'Which editors to configure?',
        options: editors.map(e => ({ value: e.name, label: e.name })),
      });
      if (!p.isCancel(sel)) selectedEditors = sel as string[];
    }
    for (const name of selectedEditors) {
      const target = editors.find(e => e.name === name)!;
      try {
        writeMcpConfig(target, envName === 'prod' ? undefined : envName);
        p.log.success(`${name}: align MCP connected`);
      } catch (err) {
        p.log.warn(`${name}: ${(err as Error).message}`);
      }
    }
  } else {
    p.log.info(`No editors detected. Run ${chalk.bold('align mcp --setup')} after installing Claude Code or Cursor.`);
  }

  // ---- Step 4: Git auto-import (zero-auth baseline graph seed) ----
  let totalDecisions = 0;
  const sourcesImported: string[] = [];
  const gitAvailable = await isGitRepo();

  if (gitAvailable) {
    console.log('');
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const items = await gitSource.fetch({});
      // Stop the scan spinner before runPersonalImport - it starts its own
      // progress spinner, and two animated spinners on one line flicker.
      if (items.length) {
        gitSpinner.stop(`Found ${items.length} commits worth importing`);
        const ingested = await runPersonalImport(items, client, {
          label: 'Git',
          approve: true,
          appUrl: resolveAppUrl(env),
        });
        totalDecisions += ingested;
        if (ingested > 0) sourcesImported.push('Git');
      } else {
        gitSpinner.stop('No decisions found in git history');
      }
    } catch {
      gitSpinner.stop('Git import skipped');
    }
  }

  // ---- Step 5: First-query prompt ----
  if (editors.length > 0) {
    console.log('');
    p.log.info(chalk.dim('Your agent is connected. Try asking:'));
    p.log.info(chalk.bold('  "What decisions exist in this codebase?"'));
  }

  // ---- Step 6: Optional connectors ----
  // Order by OAuth scope tier so frictionless personal-account connectors come
  // first, then Atlassian (site-scoped), then workspace-admin (Slack/Teams).
  console.log('');
  const connectorSources = buildSources(false)
    .filter(s => s.id !== 'git')
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
  const selectedIds = await p.multiselect({
    message: 'Connect more sources for richer context? (skip to finish)',
    options: connectorSources.map(s => ({ value: s.id, label: s.label, hint: s.description })),
    required: false,
  });
  if (p.isCancel(selectedIds)) { p.cancel('Cancelled.'); process.exit(0); }
  const selectedSources = connectorSources.filter(s => (selectedIds as string[]).includes(s.id));

  // ---- Step 7a: Collect all credentials up front (consents back-to-back) ----
  // Interactive auth (browser OAuth, token paste) can only happen one at a
  // time, so we gather every connector's creds first instead of interleaving
  // a slow fetch+import between each sign-in.
  const readyConnectors: Array<{ source: SetupSource; tokens: Record<string, string> }> = [];
  // OAuth keys connected during this run, so an Atlassian sibling (Jira <->
  // Confluence, one shared app + token) reuses the token instead of opening a
  // second browser - even under --reset.
  const connectedThisRun = new Set<string>();
  for (const source of selectedSources) {
    console.log('');
    p.log.step(chalk.bold(source.label));

    let tokens: Record<string, string> = {};
    if (source.oauthKey && source.hostGatedOAuth) {
      // Host-gated: blank host field → OAuth (SaaS default); a self-managed host
      // → token-paste fallback (the fixed OAuth app can't serve arbitrary hosts).
      const gate = source.hostGatedOAuth.field;
      const gateLabel = source.extraFields?.find((f) => f.key === gate)?.label ?? gate;
      const host = await p.text({ message: `  ${gateLabel}:`, placeholder: 'gitlab.com', defaultValue: '' });
      if (p.isCancel(host)) { p.cancel('Cancelled.'); process.exit(0); }
      // p.text returns undefined on a blank submit (not ''), so coerce before trim.
      const hostValue = (typeof host === 'string' ? host : '').trim();
      if (hostValue) {
        // self-managed → PAT. Seed the host so tokenUrl() targets it, and drop the
        // gate field from extraFields so we don't re-ask it.
        const patSource = { ...source, extraFields: source.extraFields?.filter((f) => f.key !== gate) };
        const collected = await collectTokens(patSource, { [gate]: hostValue });
        if (!collected) { p.cancel('Cancelled.'); process.exit(0); }
        tokens = collected;
      } else {
        const collected = await collectTokensViaOAuth(source, client, config, envName, opts.reset ?? false, connectedThisRun);
        if (!collected) {
          p.log.warn(`Skipping ${source.label} - no token obtained.`);
          continue;
        }
        tokens = collected;
      }
    } else if (source.oauthKey) {
      const collected = await collectTokensViaOAuth(source, client, config, envName, opts.reset ?? false, connectedThisRun);
      if (!collected) {
        p.log.warn(`Skipping ${source.label} - no token obtained.`);
        continue;
      }
      tokens = collected;
    } else if (source.tokenLabel || (source.extraFields?.length ?? 0) > 0) {
      const collected = await collectTokens(source);
      if (!collected) { p.cancel('Cancelled.'); process.exit(0); }
      tokens = collected;
    }
    readyConnectors.push({ source, tokens });
  }

  // ---- Step 7b: Fetch every connector concurrently (independent network I/O),
  // then import each result sequentially so per-connector output stays readable.
  // Imports are already internally batch-parallel (see runPersonalImport). Auth
  // (7a) stays sequential because interactive browser/paste must be one at a time. ----
  type FetchResult =
    | { source: SetupSource; items: PersonalImportItem[] }
    | { source: SetupSource; authExpired: true }
    | { source: SetupSource; error: Error };

  const n = readyConnectors.length;
  const fetchSpinner = p.spinner();
  fetchSpinner.start(`Fetching from ${n} source${n === 1 ? '' : 's'}...`);

  // Each task catches its own errors so one slow or failing connector never
  // blocks the others. AuthExpiredError is flagged for interactive re-auth below.
  const fetched = await Promise.all(
    readyConnectors.map(async ({ source, tokens }): Promise<FetchResult> => {
      try {
        return { source, items: await source.fetch(tokens) };
      } catch (err) {
        if (err instanceof AuthExpiredError && source.oauthKey) {
          return { source, authExpired: true };
        }
        return { source, error: err as Error };
      }
    }),
  );
  fetchSpinner.stop(`Fetched ${n} source${n === 1 ? '' : 's'}`);

  // Import in the original (tier-sorted) order. Resolve any expired-token
  // connectors interactively here - rare, since 7a just minted fresh tokens.
  for (const result of fetched) {
    const source = result.source;
    let items: PersonalImportItem[] | null = null;

    if ('items' in result) {
      items = result.items;
    } else if ('authExpired' in result) {
      const reauth = await p.confirm({ message: `${source.label} token expired. Reconnect now?` });
      if (p.isCancel(reauth) || !reauth) {
        p.log.warn(`Skipping ${source.label}. Run ${chalk.bold('align setup')} to reconnect.`);
        continue;
      }
      const fresh = await collectTokensViaOAuth(source, client, config, envName, true);
      if (!fresh) {
        p.log.warn(`Skipping ${source.label} - re-auth cancelled or failed.`);
        continue;
      }
      const retrySpinner = p.spinner();
      retrySpinner.start(`Retrying ${source.label}...`);
      try {
        items = await source.fetch(fresh);
        retrySpinner.stop(`Found ${items.length} items`);
      } catch (retryErr) {
        retrySpinner.stop(`Still failed: ${(retryErr as Error).message}`);
        continue;
      }
    } else {
      p.log.warn(`Skipped ${source.label} - ${result.error.message}`);
      p.log.warn(`You can run ${chalk.bold(`align import ${source.id}`)} later to retry.`);
      continue;
    }

    if (!items.length) {
      p.log.warn(`No items found in ${source.label}.`);
      continue;
    }

    const ingested = await runPersonalImport(items, client, {
      label: source.label,
      approve: true,
      appUrl: resolveAppUrl(env),
    });

    totalDecisions += ingested;
    if (ingested > 0) sourcesImported.push(source.label);
  }

  // ---- Outro ----
  const decisionsLine = totalDecisions > 0
    ? `  ${totalDecisions} decisions in your graph`
    : `  No decisions yet - run ${chalk.bold('align import')} to load your history`;
  const sourceLine = sourcesImported.length > 0
    ? `\n  Sources: ${sourcesImported.join(', ')}`
    : '';

  const outroText = [
    chalk.bold('Setup complete.\n'),
    decisionsLine,
    sourceLine,
    `\n\n  Run: ${chalk.bold('align ask "any question about your codebase"')}`,
    chalk.dim('\n\n  Want your whole team on a shared decision graph?'),
    chalk.dim('\n  Upgrade by accepting a team invite - your decisions come with you'),
    chalk.dim('\n  (you reconnect your connectors once in the team workspace).'),
    chalk.dim('\n  https://app.align.tech/pricing'),
  ].join('');
  p.outro(outroText);
}
