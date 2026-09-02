import type { Command } from 'commander';
import { subcommandOpts } from '../../lib/command-opts.js';
import * as p from '@clack/prompts';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { fetchZoomItems } from '../../lib/fetchers/zoom.js';
import { runPersonalImport } from '../../lib/personal-import.js';
import { renderCaptureReport, toCaptureSource } from '../../lib/capture-report.js';
import { CAPTURE_SOURCES } from '../../lib/capture-sources.js';
import { personalCredsForImport } from '../../lib/personal-oauth.js';
import { commandIntro } from '../../lib/brand.js';

interface ZoomImportOpts {
  token?: string;
  personal?: boolean;
  limit: string;
  approve?: boolean;
  env?: EnvName;
}

export function registerImportZoomCommand(importCmd: Command): void {
  importCmd
    .command('zoom')
    .description('Import cloud recording transcripts from Zoom')
    .option('--token <token>', 'Zoom OAuth access token')
    .option('--personal', 'Connect via browser OAuth (Align Zoom app) instead of pasting a token')
    .option('--limit <n>', 'Max recordings to import', '30')
    .option('--approve', 'Skip confirmation prompt')
    .option('--env <env>', 'Environment')
    .action(async (_opts: ZoomImportOpts, cmd: Command) => {
      const opts = subcommandOpts<ZoomImportOpts>(cmd);
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);
      const client = createGatewayClient(env);

      let token = opts.token;
      if (!token && opts.personal) {
        try {
          ({ token } = await personalCredsForImport('zoom', 'Zoom', { config, envName, env, client }));
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
      }
      if (!token) {
        p.log.error('No Zoom credentials. Pass --token, or use --personal to connect via browser OAuth.');
        process.exit(1);
      }

      p.intro(commandIntro('align import zoom'));
      const spinner = p.spinner();
      spinner.start('Fetching cloud recording transcripts from Zoom...');
      try {
        const fetched = await fetchZoomItems({
          token,
          limit: parseInt(opts.limit, 10),
        });
        const { items } = fetched;
        spinner.stop(`Found ${items.length} recordings with transcripts`);
        await runPersonalImport(items, client, { label: 'Zoom', approve: opts.approve, appUrl: resolveAppUrl(env), funnel: { env, source: 'zoom' } });
        console.log(`${renderCaptureReport([toCaptureSource(CAPTURE_SOURCES.zoom, fetched)])}\n`);
      } catch (err) {
        spinner.stop('');
        p.log.error((err as Error).message);
        process.exit(1);
      }
    });
}
