/**
 * `align local relink --detector v1` (shared detector P3, review F3).
 *
 * The estimate (calls, tokens, cost) prints before anything else. A dry run calls no model unless
 * `--classify` is passed with it. A spending run stops after DEFAULT_RELINK_MAX_CALLS calls unless
 * `--max-calls` raises it, asks at a terminal, and refuses with no terminal or inside an agent
 * (ALIGN_WRAPPED) unless BOTH `--yes` and `--max-calls` are given, so an unattended run always
 * names its own ceiling. The rules for which links are touched live in src/lib/local-relink.ts.
 */
import type { LlmProviderId } from '../lib/llm-providers.js';
import type { RelinkPlan, RelinkReport, relinkWithV1 } from '../lib/local-relink.js';
import { costEstimate } from '../lib/relink-estimate.js';

export const DEFAULT_RELINK_MAX_CALLS = 50;

export interface RelinkCommandOptions {
  detector: string;
  dryRun?: boolean;
  classify?: boolean;
  apply?: boolean;
  replace?: boolean;
  yes?: boolean;
  maxCalls?: number;
}

export interface RelinkCommandDeps {
  dbPath(): string;
  plan(dbPath: string): RelinkPlan;
  relink(dbPath: string, opts: Parameters<typeof relinkWithV1>[1]): Promise<RelinkReport>;
  hasProvider(): boolean;
  provider(): LlmProviderId | undefined;
  isTty(): boolean;
  wrapped(): boolean;
  confirm(message: string): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

const fmt = (c: { sourceId: string; targetId: string; from: string[]; to: string }): string => `${c.sourceId} -> ${c.targetId}: ${c.from.join('+')} -> ${c.to}`;

export async function runRelinkCommand(opts: RelinkCommandOptions, d: RelinkCommandDeps): Promise<number> {
  const refuse = (message: string): number => { d.err(`align local relink: ${message}`); return 2; };
  if (opts.detector !== 'v1') return refuse(`only --detector v1 can re-type links (got "${opts.detector}").`);
  if (opts.dryRun && opts.apply) return refuse('--dry-run and --apply contradict each other. Pick one.');
  if (opts.replace && !opts.apply) return refuse('--replace only makes sense with --apply.');
  if (opts.classify && opts.apply) return refuse('--classify belongs to --dry-run; --apply always classifies.');
  if (opts.classify && !opts.dryRun) return refuse('--classify needs --dry-run (it shows the v1 verdicts without writing them).');
  if (opts.maxCalls !== undefined && (!Number.isInteger(opts.maxCalls) || opts.maxCalls < 1)) return refuse('--max-calls needs a whole number of at least 1.');

  const dbPath = d.dbPath();
  const plan = d.plan(dbPath);
  const cost = costEstimate(plan.inputTokens, plan.maxOutputTokens, d.provider());
  const price = cost.usd === null ? cost.note : `about $${cost.usd.toFixed(4)} at most, at ${cost.model} list prices`;
  d.out(`Relink with the v1 detector: ${plan.calls} model call(s) for ${plan.pairs} pair(s), about ${plan.inputTokens} input tokens and up to ${plan.maxOutputTokens} output tokens, ${price}.`);
  if (plan.skippedJudged > 0) d.out(`${plan.skippedJudged} pair(s) skipped: a person judged them (a mark or a verdict), and relink never touches those.`);
  if (plan.calls === 0) { d.out('Nothing to relink.'); return 0; }

  const spends = opts.apply === true || opts.classify === true;
  if (!spends) {
    d.out('Dry run: no model was called and nothing was written. Add --dry-run --classify to see the v1 verdicts (this spends the calls above), or --apply to write them.');
    return 0;
  }
  if (!d.hasProvider()) {
    d.err('align local relink: no AI provider is configured, so nothing can be re-typed. Run: align ai');
    return 1;
  }
  const maxCalls = opts.maxCalls ?? DEFAULT_RELINK_MAX_CALLS;
  if (plan.calls > maxCalls) d.out(`This run stops after ${maxCalls} of ${plan.calls} calls; raise it with --max-calls.`);
  if (d.wrapped() || !d.isTty()) {
    if (!opts.yes || opts.maxCalls === undefined) {
      d.err('align local relink: this spends your AI provider key and there is no person at a terminal to ask. Nothing was sent. Pass --yes and --max-calls <n> to go ahead.');
      return 1;
    }
  } else if (!opts.yes && !(await d.confirm(`Make up to ${Math.min(maxCalls, plan.calls)} model call(s) now? This costs money.`))) {
    d.out('Cancelled. Nothing was sent.');
    return 0;
  }

  const apply = opts.apply === true;
  const r = await d.relink(dbPath, { apply, replace: opts.replace === true, maxCalls });
  if (apply) for (const c of r.written) d.out(`  wrote: ${fmt(c)}`);
  else for (const c of r.proposed) d.out(`  would change: ${fmt(c)}`);
  d.out(`${r.calls} call(s): ${apply ? `${r.written.length} link(s) written` : `${r.proposed.length} link(s) would change type`}, ${r.unchanged} unchanged, ${r.omitted} given no relationship (left as they are), ${r.keptSupersedes} supersedes kept (only a conflict answer changes one), ${r.failed} failed.`);
  if (!apply) d.out('Dry run: nothing was written.');
  else if (!opts.replace && r.written.length > 0) d.out('The v0 links stay beside the new v1 ones; add --replace to swap them.');
  if (r.remainingCalls > 0) d.out(`${r.remainingCalls} more call(s) not made (--max-calls).`);
  if (r.stopped) { d.err(`align local relink: stopped early: ${r.stopped}`); return 1; }
  return 0;
}
