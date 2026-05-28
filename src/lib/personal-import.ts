import chalk from 'chalk';
import ora from 'ora';
import * as p from '@clack/prompts';
import { renderTable } from './table.js';
import type { BatchIngestItem, createGatewayClient } from './gateway-client.js';

export type PersonalImportItem = BatchIngestItem;

const BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 3;

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await tasks[i]() }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function runPersonalImport(
  items: PersonalImportItem[],
  client: ReturnType<typeof createGatewayClient>,
  opts: { label: string; approve?: boolean; appUrl: string },
): Promise<number> {
  if (!items.length) {
    p.log.warn(`No items found from ${opts.label}.`);
    return 0;
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
  let done = 0;
  const failures: string[] = [];
  const spinner = ora(`Importing 0/${batches.length} batches...`).start();

  type BatchResult = Awaited<ReturnType<typeof client.ingestBatch>>;
  const results = await runWithConcurrency<BatchResult>(
    batches.map((batch) => async () => {
      try {
        return await client.ingestBatch(batch);
      } finally {
        spinner.text = `Importing ${++done}/${batches.length} batches...`;
      }
    }),
    BATCH_CONCURRENCY,
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      total += r.value.snapshots.length;
      for (const s of r.value.snapshots) relatedCount += s.analysis?.relatedDecisions?.length ?? 0;
    } else {
      failures.push(`Batch ${i + 1}: ${(r.reason as Error).message}`);
    }
  }

  if (failures.length === 0) {
    spinner.succeed(`Imported ${total} decisions from ${opts.label}`);
  } else {
    spinner.warn(`Imported ${total} decisions (${failures.length} batch${failures.length > 1 ? 'es' : ''} failed)`);
    for (const f of failures) p.log.warn(f);
  }

  if (relatedCount > 0) {
    console.log(chalk.cyan(`${relatedCount} connections found with existing decisions in your graph.`));
  }
  console.log(chalk.dim('Relationships across all your imported tools are detected automatically in the background.'));
  console.log(chalk.dim(`View at: ${opts.appUrl}/decisions`));
  console.log(chalk.dim('Tip: import more tools to build a richer cross-tool decision graph.'));
  console.log('');
  return total;
}
