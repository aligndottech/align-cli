/**
 * `align push <id>` - promote ONE ratified local decision to the shared graph (ALI-831).
 *
 * Per-item, after ratify, never bulk: that is Tom's ruling (2026-09-03), and it is what
 * keeps a session's worth of agent claims from arriving in the team graph as facts. The row
 * travels through the existing ingestBatch contract with its platform and provenance
 * verbatim, so the cloud derives `decider_kind` from the platform the way it does for every
 * other capture (`agent-session` classifies agent once ALI-832 lands; until then the cloud's
 * platform CHECK rejects it, which is the right failure direction).
 *
 * The push is then ratified cloud-side by the same person, best-effort: the local
 * ratification is the human act, the cloud call carries it across. If that second call
 * fails the push stands and the command says what to run.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { resolveEnv } from '../lib/resolve-env.js';

/** A local row with no source URL (a bare `align capture` of text) still needs one on the
 *  wire - the cloud keys decisions on it - and it must be STABLE so a re-push upserts the
 *  same cloud row rather than minting a twin. The local id is the only stable identity
 *  such a row has. */
export function pushSourceUrl(row: { id: string; sourceUrl: string | null }): string {
  return row.sourceUrl ?? `align-local://decision/${row.id}`;
}

export function registerPushCommand(program: Command): void {
  program
    .command('push <id>')
    .description('Promote one ratified local decision to the shared graph (per item, after align ratify)')
    .option('--env <env>', 'Which shared environment to push to (prod, preview)')
    .action(async (id: string, opts: { env?: EnvName }) => {
      const config = createConfigStore();
      // No local preference here, unlike every read command: the destination is the
      // SHARED graph by definition, and a no-account user has nowhere to push to.
      const envName = resolveEnv(opts.env);
      const target = config.getEnvironment(envName);
      if (target.mode === 'local-embedded') {
        console.error(chalk.red('\n  align push sends a decision from your local graph to the shared one, and no shared environment is configured.'));
        console.error(chalk.dim('  Name one with --env prod (or --env preview), after `align login`.\n'));
        process.exit(1);
        return;
      }
      const local = config.getEnvironment('local');
      if (local.mode !== 'local-embedded' || !local.localDbPath) {
        console.error(chalk.red('\n  There is no local graph on this machine to push from. `align setup --local` creates one.\n'));
        process.exit(1);
        return;
      }

      const db = createLocalDb(local.localDbPath);
      try {
        const row = db.getDecisionById(id);
        if (!row) {
          console.error(chalk.red(`\n  No decision ${id} in your local graph. \`align decisions list\` shows what is there.\n`));
          process.exit(1);
          return;
        }
        if (!row.ratifiedAt) {
          console.error(chalk.red(`\n  ${id} has not been ratified, so it stays a claim on this machine.`));
          console.error(chalk.dim(`  A human stands behind it first: align ratify ${id}\n`));
          process.exit(1);
          return;
        }

        const client = createGatewayClient(target);
        const spinner = ora(`Pushing to ${envName}...`).start();
        let cloudId: string;
        try {
          const { snapshots } = await client.ingestBatch([{
            source_url: pushSourceUrl(row),
            platform: row.platform,
            title: row.title,
            raw_text: row.summary,
            // The cloud client renames this to decided_at on the wire (ALI-829).
            ...(row.decidedAt ? { created_at: row.decidedAt } : {}),
          }]);
          const first = snapshots[0];
          if (!first) throw new Error('The gateway accepted the push but returned no decision id.');
          cloudId = first.id;
        } catch (err) {
          spinner.fail(chalk.red((err as Error).message));
          process.exit(1);
          return;
        }
        spinner.stop();
        db.insertAudit({ decisionId: id, action: 'pushed', actor: row.ratifiedBy, detail: `${envName}:${cloudId}` });
        console.log(chalk.green(`\n  Pushed to ${envName} as ${cloudId}.`));

        // Carry the human act across. Best-effort: the push is the deliverable, and a
        // failure here (a service token, an older gateway) leaves the cloud row a claim
        // the same person can ratify by hand.
        try {
          await client.ratifyDecision(cloudId);
          console.log(chalk.dim(`  Ratified there too, as you.\n`));
        } catch (err) {
          console.log(chalk.yellow(`  It arrived as an unratified claim: ${(err as Error).message}`));
          console.log(chalk.dim(`  To stand behind it there: align ratify ${cloudId} --env ${envName}\n`));
        }
      } finally {
        db.close();
      }
    });
}
