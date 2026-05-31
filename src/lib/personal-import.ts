import chalk from 'chalk';
import ora from 'ora';
import * as p from '@clack/prompts';
import { renderTable } from './table.js';
import { GatewayError } from './gateway-client.js';
import type { BatchIngestItem, createGatewayClient } from './gateway-client.js';

export type PersonalImportItem = BatchIngestItem;

const BATCH_SIZE = 20;
const BATCH_CONCURRENCY = 3;

// Cap TOTAL concurrent /ingest/batch calls across all imports running in
// parallel (align setup imports several connectors at once). Without this,
// IMPORT_CONCURRENCY x BATCH_CONCURRENCY swamps the gateway's DB pool and
// surfaces as 500 "timeout exceeded when trying to connect" (ALI-110).
const GLOBAL_INGEST_CONCURRENCY = Number(process.env['ALIGN_INGEST_CONCURRENCY']) || 6;
const INGEST_MAX_ATTEMPTS = 3;
const INGEST_BACKOFF_MS = 250;

let activeIngests = 0;
const ingestWaiters: Array<() => void> = [];

// Acquire one of the global ingest slots, run fn, release (waking the next
// waiter). Shared across every concurrent runPersonalImport.
async function withIngestSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeIngests >= GLOBAL_INGEST_CONCURRENCY) {
    await new Promise<void>((resolve) => ingestWaiters.push(resolve));
  }
  activeIngests++;
  try {
    return await fn();
  } finally {
    activeIngests--;
    ingestWaiters.shift()?.();
  }
}

// A pool-connection timeout shows up as a 5xx; network failures as status 0.
// Both are transient - retrying after a short backoff usually succeeds. 4xx
// (bad request / auth) is not retried.
function isTransientGatewayError(err: unknown): boolean {
  return err instanceof GatewayError && (err.statusCode >= 500 || err.statusCode === 0);
}

async function ingestBatchResilient<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= INGEST_MAX_ATTEMPTS; attempt++) {
    try {
      return await withIngestSlot(fn);
    } catch (err) {
      lastErr = err;
      if (!isTransientGatewayError(err) || attempt === INGEST_MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, INGEST_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function runWithConcurrency<T>(
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
  opts: { label: string; approve?: boolean; appUrl: string; quiet?: boolean; deferEnrichment?: boolean; local?: boolean },
): Promise<number> {
  if (!items.length) {
    p.log.warn(`No items found from ${opts.label}.`);
    return 0;
  }

  // Quiet mode (concurrent setup imports): skip the preview table, the animated
  // spinner, and the multi-line footer - they clash when several imports run at
  // once. A single compact completion line is printed at the end instead.
  if (!opts.quiet) {
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
  }

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
  const spinner = opts.quiet ? null : ora(`Importing 0/${batches.length} batches...`).start();

  type BatchResult = Awaited<ReturnType<typeof client.ingestBatch>>;
  const results = await runWithConcurrency<BatchResult>(
    batches.map((batch) => async () => {
      try {
        return await ingestBatchResilient(() => client.ingestBatch(batch, { deferEnrichment: opts.deferEnrichment }));
      } finally {
        done++;
        if (spinner) spinner.text = `Importing ${done}/${batches.length} batches...`;
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

  // Quiet mode: one compact completion line; the shared footer is printed once
  // by the caller after all concurrent imports finish.
  if (opts.quiet) {
    const conn = relatedCount > 0 ? `, ${relatedCount} connection${relatedCount === 1 ? '' : 's'}` : '';
    const failNote = failures.length
      ? chalk.yellow(` (${failures.length} batch${failures.length > 1 ? 'es' : ''} failed)`)
      : '';
    console.log(`  ${chalk.green('✓')} ${opts.label}: ${total} decision${total === 1 ? '' : 's'}${conn}${failNote}`);
    for (const f of failures) p.log.warn(f);
    return total;
  }

  if (failures.length === 0) {
    spinner!.succeed(`Imported ${total} decisions from ${opts.label}`);
  } else {
    spinner!.warn(`Imported ${total} decisions (${failures.length} batch${failures.length > 1 ? 'es' : ''} failed)`);
    for (const f of failures) p.log.warn(f);
  }

  if (relatedCount > 0) {
    console.log(chalk.cyan(`${relatedCount} connections found with existing decisions in your graph.`));
  }
  if (opts.local) {
    // Local mode: on-device SQLite, no web UI and relationships are computed
    // synchronously - don't claim a background job or a browser link.
    console.log(chalk.dim('Stored locally - run `align local status` to inspect your graph.'));
  } else {
    // Cloud personal: CLI/MCP-native. Don't push the web UI (a team surface);
    // point to the CLI instead.
    console.log(chalk.dim('Relationships across all your imported tools are detected automatically in the background.'));
    console.log(chalk.dim('Query your graph: align ask "..."  or  align decisions list'));
  }
  console.log(chalk.dim('Tip: import more tools to build a richer cross-tool decision graph.'));
  console.log('');
  return total;
}
