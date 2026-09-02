import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchConfluenceItems } from '../../lib/fetchers/confluence.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { PERSONAL_OAUTH_KEYS, personalCredsForImport } from '../../lib/personal-oauth.js';
import { AuthExpiredError } from '../../lib/errors.js';
import { commandIntro } from '../../lib/brand.js';

interface ConfluenceImportOpts {
  email?: string;
  token?: string;
  personal?: boolean;
  domain?: string;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportConfluenceCommand(importCmd: Command): void {
  importCmd
    .command('confluence')
    .description('Import your Confluence pages')
    .option('--email <email>', 'Atlassian account email (for API token auth)')
    .option('--token <token>', 'Atlassian API token (or uses cached OAuth token from align setup)')
    .option('--personal', 'Connect via browser OAuth (Align personal Atlassian app) instead of a token')
    .option('--domain <domain>', 'Confluence domain, e.g. company.atlassian.net (for API token auth)')
    .option('--limit <n>', 'Max pages to import', '50')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: ConfluenceImportOpts, cmd: Command) => {
      const opts = subcommandOpts<ConfluenceImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      // Resolve auth: explicit flags first, then --personal (cached-or-browser OAuth), then
      // the cached OAuth token align setup persisted - under the source's oauthKey
      // ('confluence-personal'), which is the key this file wrongly read as 'confluence'
      // until ALI-388.
      const cachedKey = PERSONAL_OAUTH_KEYS['confluence'];
      let token = opts.token;
      let cloudId: string | undefined;
      let siteBase: string | undefined;
      if (!token && opts.personal) {
        try {
          const creds = await personalCredsForImport('confluence', 'Confluence', { config, envName, env, client });
          token = creds.token;
          cloudId = creds.cloudId;
          siteBase = creds.siteBase;
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        token = config.getConnectorToken(envName, cachedKey) ?? undefined;
        cloudId = config.getConnectorCloudId(envName, cachedKey) ?? undefined;
        siteBase = config.getConnectorSiteBase(envName, cachedKey) ?? undefined;
      }

      if (!token) {
        p.log.error('No Confluence credentials found. Run align setup or align import confluence --personal to connect via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }
      if (!cloudId && (!opts.email || !opts.domain)) {
        p.log.error('OAuth metadata incomplete. Run align setup --reset to reconnect Confluence via OAuth, or pass --email, --token, and --domain.');
        process.exit(1);
      }

      p.intro(commandIntro('align import confluence'));
      const spinner = p.spinner();
      spinner.start('Fetching your Confluence pages...');
      try {
        const fetched = await fetchConfluenceItems({
          token,
          cloudId,
          siteBase,
          email: opts.email,
          domain: opts.domain,
          limit: parseInt(opts.limit, 10),
        });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} pages`);
        await runPersonalImport(items, client, { label: 'Confluence', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'confluence' } });
        console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.confluence, fetched)])}\n`);
      } catch (err) {
        spinner.stop('');
        if (err instanceof AuthExpiredError) {
          p.log.error(err.message);
        } else {
          p.log.error((err as Error).message);
        }
        process.exit(1);
      }
    });
}
