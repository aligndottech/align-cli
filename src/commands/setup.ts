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
      tokenLabel: 'Personal access token',
      tokenHint: 'Tick "read_api" on the page that opens',
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
      // TODO(ALI-94): switch to `oauthKey: 'linear'` (read-only) once the Linear
      // OAuth app + LINEAR_CLIENT_ID/SECRET are configured per env. The gateway
      // already supports the `linear` OAuth case; until the app exists, keep the
      // API-key paste so this option keeps working.
      tokenLabel: 'Personal API key (lin_api_...)',
      tokenHint: 'Copy a Personal API key from the page that opens',
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
      tokenLabel: 'Integration secret (secret_...)',
      tokenHint: 'Create a new integration and copy the Internal Integration Secret from the page that opens',
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

async function collectTokens(source: SetupSource): Promise<Record<string, string> | null> {
  const tokens: Record<string, string> = {};

  // Extra fields first (email, domain for Jira/Confluence)
  for (const field of source.extraFields ?? []) {
    const val = await p.text({ message: `  ${field.label}:` });
    if (p.isCancel(val)) return null;
    tokens[field.key] = val as string;
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
): Promise<Record<string, string> | null> {
  const key = source.oauthKey!;

  if (!reset) {
    const cached = config.getConnectorToken(envName, key);
    if (cached) {
      p.log.info(chalk.dim(`  ${source.label}: using cached OAuth token (run align setup --reset to re-auth)`));
      const cachedCloudId = config.getConnectorCloudId(envName, key);
      const cachedSiteBase = config.getConnectorSiteBase(envName, key);
      return {
        token: cached,
        ...(cachedCloudId ? { cloudId: cachedCloudId } : {}),
        ...(cachedSiteBase ? { siteBase: cachedSiteBase } : {}),
      };
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

  // Atlassian: Jira and Confluence share one OAuth app, so a single consent
  // returns the sibling's credentials too. Persist them so the sibling
  // connector's own iteration finds a cached token and skips a second browser flow.
  const siblingConnector = result.data['siblingConnector'] as string | undefined;
  const siblingCreds = result.data['siblingCredentials'] as Record<string, unknown> | undefined;
  if (siblingConnector && siblingCreds?.['access_token']) {
    persistConnectorCreds(config, envName, siblingConnector, siblingCreds);
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
  for (const source of selectedSources) {
    console.log('');
    p.log.step(chalk.bold(source.label));

    let tokens: Record<string, string> = {};
    if (source.oauthKey) {
      const collected = await collectTokensViaOAuth(source, client, config, envName, opts.reset ?? false);
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

  // ---- Step 7b: Fetch + import each connector (sequential: each import has
  // its own progress spinner, and concurrent spinners clobber the terminal) ----
  for (const { source, tokens: collectedTokens } of readyConnectors) {
    let tokens = collectedTokens;
    const fetchSpinner = p.spinner();
    fetchSpinner.start(`Fetching from ${source.label}...`);
    let items: PersonalImportItem[] = [];
    try {
      items = await source.fetch(tokens);
      fetchSpinner.stop(`Found ${items.length} items`);
    } catch (err) {
      if (err instanceof AuthExpiredError && source.oauthKey) {
        fetchSpinner.stop(`${source.label} token expired.`);
        const reauth = await p.confirm({ message: `Reconnect ${source.label} now?` });
        if (!p.isCancel(reauth) && reauth) {
          const fresh = await collectTokensViaOAuth(source, client, config, envName, true);
          if (fresh) {
            try {
              fetchSpinner.start(`Retrying ${source.label}...`);
              items = await source.fetch(fresh);
              fetchSpinner.stop(`Found ${items.length} items`);
              tokens = fresh;
            } catch (retryErr) {
              fetchSpinner.stop(`Still failed: ${(retryErr as Error).message}`);
              continue;
            }
          } else {
            p.log.warn(`Skipping ${source.label} - re-auth cancelled or failed.`);
            continue;
          }
        } else {
          p.log.warn(`Skipping ${source.label}. Run ${chalk.bold('align setup')} to reconnect.`);
          continue;
        }
      } else {
        fetchSpinner.stop(`Skipped ${source.label} - ${(err as Error).message}`);
        p.log.warn(`You can run ${chalk.bold(`align import ${source.id}`)} later to retry.`);
        continue;
      }
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
