import chalk from 'chalk';
import ora from 'ora';
import * as p from '@clack/prompts';
import { renderTable } from './table.js';
import type { BatchIngestItem, createGatewayClient } from './gateway-client.js';

export type PersonalImportItem = BatchIngestItem;

const BATCH_SIZE = 20;

export async function runPersonalImport(
  items: PersonalImportItem[],
  client: ReturnType<typeof createGatewayClient>,
  opts: { label: string; approve?: boolean; appUrl: string },
): Promise<void> {
  if (!items.length) {
    p.log.warn(`No items found from ${opts.label}.`);
    return;
  }

  const preview = items.slice(0, 10);
  const more = items.length - preview.length;
  console.log(chalk.bold(`\nFound ${items.length} items from ${opts.label}\n`));
  renderTable(
    [
      { header: 'SOURCE', width: 48 },
      { header: 'TITLE', width: 50 },
    ],
    preview.map(i => [
      i.source_url.replace(/https?:\/\//, '').slice(0, 46),
      (i.title ?? i.raw_text.split('\n')[0]).slice(0, 48),
    ]),
  );
  if (more > 0) console.log(chalk.dim(`  ...and ${more} more\n`));
  else console.log('');

  if (!opts.approve) {
    const confirmed = await p.confirm({
      message: `Import ${items.length} items to your decision graph?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const batches: PersonalImportItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  let total = 0;
  let relatedCount = 0;
  for (let i = 0; i < batches.length; i++) {
    const spinner = ora(`Importing batch ${i + 1}/${batches.length}...`).start();
    try {
      const result = await client.ingestBatch(batches[i]);
      total += result.snapshots.length;
      for (const s of result.snapshots) {
        relatedCount += s.analysis?.relatedDecisions?.length ?? 0;
      }
      spinner.succeed(`Batch ${i + 1}/${batches.length} done (${result.snapshots.length} decisions)`);
    } catch (err) {
      spinner.fail(`Batch ${i + 1} failed: ${(err as Error).message}`);
    }
  }

  console.log('');
  console.log(chalk.green(`${total} decisions captured from ${opts.label}.`));
  if (relatedCount > 0) {
    console.log(chalk.cyan(`${relatedCount} connections found with existing decisions in your graph.`));
  }
  console.log(chalk.dim('Relationships across all your imported tools are detected automatically in the background.'));
  console.log(chalk.dim(`View at: ${opts.appUrl}/decisions`));
  console.log(chalk.dim('Tip: import more tools to build a richer cross-tool decision graph.'));
  console.log('');
}
