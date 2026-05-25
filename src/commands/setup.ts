import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { type PersonalImportItem, runPersonalImport } from '../lib/personal-import.js';
import { detectEditors, writeMcpConfig } from '../lib/mcp-setup.js';
import { isGitRepo } from '../lib/git.js';
import { resolveAppUrl } from '../lib/env-resolver.js';

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

interface SetupSource {
  id: string;
  label: string;
  description: string;
  tokenLabel?: string;
  tokenHint?: string;
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
        return fetchGitItems({ limit: 100 });
      },
    });
  }

  sources.push(
    {
      id: 'github',
      label: 'GitHub',
      description: 'Your PRs and issues',
      tokenLabel: 'Personal access token (ghp_...)',
      tokenHint: 'github.com/settings/tokens/new - tick "repo" scope',
      fetch: async (t) => {
        const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
        return fetchGitHubItems({ token: t['token']!, limit: 100 });
      },
    },
    {
      id: 'jira',
      label: 'Jira',
      description: 'Your issues',
      tokenLabel: 'Atlassian API token',
      tokenHint: 'id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian email' },
        { key: 'domain', label: 'Jira domain (e.g. company.atlassian.net)' },
      ],
      fetch: async (t) => {
        const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
        return fetchJiraItems({ email: t['email']!, token: t['token']!, domain: t['domain']!, limit: 100 });
      },
    },
    {
      id: 'confluence',
      label: 'Confluence',
      description: 'Your pages and documentation',
      tokenLabel: 'Atlassian API token (same as Jira)',
      tokenHint: 'id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian email' },
        { key: 'domain', label: 'Confluence domain (e.g. company.atlassian.net)' },
      ],
      fetch: async (t) => {
        const { fetchConfluenceItems } = await import('../lib/fetchers/confluence.js');
        return fetchConfluenceItems({ email: t['email']!, token: t['token']!, domain: t['domain']!, limit: 50 });
      },
    },
    {
      id: 'slack',
      label: 'Slack',
      description: 'Decision threads from your channels [experimental]',
      tokenLabel: 'User OAuth token (xoxp-...)',
      tokenHint: 'api.slack.com/apps - OAuth & Permissions - User Token Scopes: channels:read, channels:history, groups:read, groups:history',
      fetch: async (t) => {
        const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
        return fetchSlackItems({ token: t['token']!, limit: 50, daysBack: 90 });
      },
    },
    {
      id: 'teams',
      label: 'Microsoft Teams',
      description: 'Channel messages and decisions from your teams',
      tokenLabel: 'Graph API delegated access token',
      tokenHint: 'Get a delegated token with ChannelMessage.Read.All scope - requires admin consent in most orgs',
      fetch: async (t) => {
        const { fetchTeamsItems } = await import('../lib/fetchers/teams.js');
        return fetchTeamsItems({ token: t['token']!, limit: 50 });
      },
    },
    {
      id: 'zoom',
      label: 'Zoom',
      description: 'Cloud recording transcripts from your meetings',
      tokenLabel: 'Zoom OAuth access token',
      tokenHint: 'marketplace.zoom.us/develop/apps - create OAuth app, authorize, copy access token',
      fetch: async (t) => {
        const { fetchZoomItems } = await import('../lib/fetchers/zoom.js');
        return fetchZoomItems({ token: t['token']!, limit: 30 });
      },
    },
    {
      id: 'gitlab',
      label: 'GitLab',
      description: 'Your merge requests',
      tokenLabel: 'Personal access token',
      tokenHint: 'gitlab.com/-/user_settings/personal_access_tokens - tick "read_api"',
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
      tokenLabel: 'Personal API key (lin_api_...)',
      tokenHint: 'linear.app/settings/api - Personal API keys',
      fetch: async (t) => {
        const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
        return fetchLinearItems({ token: t['token']!, limit: 100 });
      },
    },
    {
      id: 'notion',
      label: 'Notion',
      description: 'Your pages and databases',
      tokenLabel: 'Integration secret (secret_...)',
      tokenHint: 'notion.so/my-integrations - New integration - show Internal Integration Secret',
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
    if (source.tokenHint) {
      p.log.info(chalk.dim(`  Get your token: ${source.tokenHint}`));
    }
    const token = await p.password({ message: `  ${source.tokenLabel}:` });
    if (p.isCancel(token)) return null;
    tokens['token'] = token as string;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Guided onboarding: connect your tools and configure MCP in one command')
    .option('--env <env>', 'Environment')
    .option('--approve', 'Skip confirmation prompts (for scripted use)')
    .action(async (opts: { env?: EnvName; approve?: boolean }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      p.intro(chalk.bgMagenta.white(' align setup '));
      p.log.info('Building your decision graph from the tools your team already uses.');
      p.log.info('Takes about 10 minutes. Ctrl+C to cancel at any step.');
      console.log('');

      // ---- Step 1: Auth check ----
      const authSpinner = p.spinner();
      authSpinner.start('Checking authentication...');
      try {
        const me = await client.whoami();
        authSpinner.stop(`Logged in as ${me.user.email} (${me.tenant?.name ?? envName})`);
      } catch {
        authSpinner.stop('Not authenticated');
        p.log.warn(`Run ${chalk.bold('align login')} first, then re-run ${chalk.bold('align setup')}.`);
        process.exit(1);
      }

      // Snapshot pre-import link count so we can report the delta after imports
      let preImportLinkCount = 0;
      try {
        const existing = await client.listDecisionLinks();
        preImportLinkCount = existing.length;
      } catch {
        // Non-fatal - delta will just be the post-import total
      }

      // ---- Step 2: Source selection ----
      console.log('');
      const gitAvailable = await isGitRepo();
      const allSources = buildSources(gitAvailable);

      const sourceOptions = allSources.map(s => ({
        value: s.id,
        label: s.label,
        hint: s.description,
      }));

      const selectedIds = await p.multiselect({
        message: 'Which sources do you want to import? (space to select, enter to confirm)',
        options: sourceOptions,
        required: true,
        initialValues: gitAvailable ? ['git'] : [],
      });
      if (p.isCancel(selectedIds)) { p.cancel('Cancelled.'); process.exit(0); }

      const selectedSources = allSources.filter(s => (selectedIds as string[]).includes(s.id));

      // ---- Step 3: Token collection + import per source ----
      let totalDecisions = 0;
      const sourcesImported: string[] = [];

      for (const source of selectedSources) {
        console.log('');
        p.log.step(chalk.bold(source.label));

        // Collect tokens
        let tokens: Record<string, string> = {};
        if (source.tokenLabel || (source.extraFields?.length ?? 0) > 0) {
          const collected = await collectTokens(source);
          if (!collected) { p.cancel('Cancelled.'); process.exit(0); }
          tokens = collected;
        }

        // Fetch items
        const fetchSpinner = p.spinner();
        fetchSpinner.start(`Fetching from ${source.label}...`);
        let items: PersonalImportItem[] = [];
        try {
          items = await source.fetch(tokens);
          fetchSpinner.stop(`Found ${items.length} items`);
        } catch (err) {
          fetchSpinner.stop(`Skipped ${source.label} - ${(err as Error).message}`);
          p.log.warn(`You can run ${chalk.bold(`align import ${source.id}`)} later to retry.`);
          continue;
        }

        if (!items.length) {
          p.log.warn(`No items found in ${source.label}.`);
          continue;
        }

        // Import (always --approve inside setup to avoid double-confirmation)
        const ingested = await runPersonalImport(items, client, {
          label: source.label,
          approve: true,
          appUrl: resolveAppUrl(env),
        });

        totalDecisions += ingested;
        if (ingested > 0) sourcesImported.push(source.label);
      }

      if (!totalDecisions) {
        p.log.warn('No decisions imported. Run individual align import commands to try specific sources.');
        p.outro('Setup complete (no data imported).');
        return;
      }

      // ---- Step 4: Relationship count (delta from pre-import baseline) ----
      console.log('');
      const linkSpinner = p.spinner();
      linkSpinner.start('Mapping cross-tool relationships...');
      await new Promise<void>(r => setTimeout(r, 4000));
      let linkCount = 0;
      try {
        const links = await client.listDecisionLinks();
        linkCount = Math.max(0, links.length - preImportLinkCount);
        if (linkCount > 0) {
          linkSpinner.stop(`${linkCount} new cross-tool link${linkCount === 1 ? '' : 's'} found`);
        } else {
          linkSpinner.stop('Relationship mapping running in background - check align links list shortly');
        }
      } catch {
        linkSpinner.stop('Check align links list for cross-tool relationships');
      }

      // ---- Step 5: MCP setup ----
      console.log('');
      const editors = detectEditors();
      if (editors.length > 0) {
        p.log.info(`Detected ${editors.length} editor${editors.length === 1 ? '' : 's'}: ${editors.map(e => e.name).join(', ')}`);

        const setupMcp = await p.confirm({ message: 'Configure MCP so Claude/Cursor can query your graph inline?' });

        if (!p.isCancel(setupMcp) && setupMcp) {
          let selected: string[] = editors.map(e => e.name);

          if (editors.length > 1) {
            const sel = await p.multiselect({
              message: 'Which editors to configure?',
              options: editors.map(e => ({ value: e.name, label: e.name })),
            });
            if (!p.isCancel(sel)) selected = sel as string[];
          }

          for (const name of selected) {
            const target = editors.find(e => e.name === name)!;
            try {
              writeMcpConfig(target, envName === 'prod' ? undefined : envName);
              p.log.success(`${name}: align added to MCP servers`);
            } catch (err) {
              p.log.warn(`${name}: ${(err as Error).message}`);
            }
          }

          console.log('');
          p.log.info(chalk.dim('Restart your editor, then ask:'));
          p.log.info(chalk.dim(`  "What has my team decided about ${sourcesImported[0] ? `our ${sourcesImported[0].toLowerCase()} workflow` : 'authentication'}?"`));
        }
      } else {
        p.log.info(
          `To use Align inside Claude or Cursor, run: ${chalk.bold('align mcp --setup')}`,
        );
      }

      // ---- Outro ----
      const linkLine = linkCount > 0
        ? `  ${linkCount} cross-tool link${linkCount === 1 ? '' : 's'} found\n`
        : '';
      const sourceLine = sourcesImported.length > 0
        ? `  ${sourcesImported.length} source${sourcesImported.length === 1 ? '' : 's'}: ${sourcesImported.join(', ')}\n`
        : '';

      const outroText = [
        chalk.bold('Setup complete.\n'),
        `  ${totalDecisions} decisions captured`,
        sourceLine ? `\n${sourceLine}` : '',
        linkLine ? `\n${linkLine}` : '',
        `\n  Run: ${chalk.bold('align ask "any question about your codebase"')}\n`,
        chalk.dim('\n  Want your whole team to have a shared decision graph?'),
        chalk.dim('\n  https://align.tech/pricing'),
      ].join('');
      p.outro(outroText);
    });
}
