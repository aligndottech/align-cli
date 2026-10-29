import type { EnvironmentConfig } from './config.js';
import { findStaleCode, type StaleOptions, type StaleReport } from './stale-code.js';
import { type LinkSourceClient, loadStaleLinks } from './stale-links.js';
import { reportNotes } from './stale-render.js';

export interface StaleResult {
  ref: string;
  findings: StaleReport['findings'];
  skipped: StaleReport['skipped'];
  notes: string[];
  counts: { linksConsidered: number; aiExcluded: number; filesCapped: number; budgetExceeded: boolean };
}

/** Load the supersedes links for this environment, then look for code still built on the replaced side. Shared by the command and the MCP tool. */
export async function runStale(
  env: EnvironmentConfig,
  client: LinkSourceClient | null,
  opts: Pick<StaleOptions, 'cwd' | 'includeAi' | 'maxFilesPerDecision' | 'budgetMs'>,
): Promise<{ report: StaleReport; loadNotes: string[]; result: StaleResult }> {
  const loaded = await loadStaleLinks(env, client);
  const report = await findStaleCode(loaded.links, opts);
  const result: StaleResult = {
    ref: report.ref,
    findings: report.findings,
    skipped: report.skipped,
    notes: reportNotes(report, loaded.notes, opts.includeAi === true),
    counts: { linksConsidered: report.linksConsidered, aiExcluded: report.aiExcluded, filesCapped: report.filesCapped, budgetExceeded: report.budgetExceeded },
  };
  return { report, loadNotes: loaded.notes, result };
}
