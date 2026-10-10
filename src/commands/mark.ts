/**
 * `align mark` - a person's judgement on what the local guardrail shows, kept on this machine.
 *
 *   align mark conflict <a> <b> real|false       a stored pair (from align get-conflicts)
 *   align mark check <a> real|false [--files ...] a check hit; files default to the last check's set
 *   align mark <a> replaces <b>                   a supersede judgement plus a supersedes link
 *   align mark <a> not-a-decision [--undo]        out of ask and check retrieval, kept in the list
 *   align mark <a> note "<text>"                  appends
 *   align mark --list [<id>]  /  --undo           show or take back your own marks
 *
 * It makes no network call and asks no model. It is not a gate: a mark is a person's answer, so it
 * runs without a terminal when its arguments are complete. Ratifying is a different act and stays
 * in `align ratify`, which does insist on a terminal.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { applyJudgement, type MarkAction, MarkError, parseMarkArgs } from '../lib/curation/mark.js';
import { agentLabel, quote } from '../lib/curation/text.js';
import { existingTitles, type Judge, type JudgementRow, listJudgements } from '../lib/curation/judgements-db.js';
import { defaultJudge } from '../lib/curation/judge.js';
import { gitHead, type LastCheck, readLastCheck } from '../lib/curation/last-check.js';
import { localGraphPath } from '../lib/sync/real-env.js';

export interface MarkCommandOptions { files?: string[]; undo?: boolean; list?: boolean; force?: boolean }

export interface MarkCommandDeps {
  out(line: string): void;
  err(line: string): void;
  graphPath(): string | undefined;
  judge(): Promise<Judge>;
  lastCheck(): Pick<LastCheck, 'files'> & Partial<Pick<LastCheck, 'decision_ids' | 'cwd' | 'head'>> | null;
  /** A controller terminal on stdin: the marks that HIDE something are a person's at a keyboard. */
  isTty(): boolean;
  /** The git HEAD of the current directory, or null outside a repository. */
  head(): Promise<string | null>;
}

const LABEL: Record<string, string> = {
  conflict_verdict: 'conflict', check_verdict: 'check hit', supersede: 'replaces', not_a_decision: 'not a decision', note: 'note',
};

function describe(r: JudgementRow, titles: Map<string, string>): string {
  const name = (id: string) => quote(titles.get(id) ?? id);
  const day = r.judged_at.slice(0, 10);
  // An agent's mark is always said so, with its verdict: a hit hidden by an agent is never invisible.
  const who = r.via === 'mcp' ? `marked ${r.value ?? r.kind.replace(/_/g, ' ')} by ${agentLabel(r.agent_id)} via MCP` : 'by you';
  const what =
    r.kind === 'conflict_verdict' ? `${name(r.decision_id)} and ${name(r.counterpart_id ?? '')}: ${r.value === 'false' ? 'false alarm' : 'real conflict'}`
    : r.kind === 'check_verdict' ? `${name(r.decision_id)}: ${r.value === 'false' ? 'false alarm' : 'real conflict'} for one set of files`
    : r.kind === 'supersede' ? `${name(r.decision_id)} replaces ${name(r.counterpart_id ?? '')}`
    : r.kind === 'not_a_decision' ? `${name(r.decision_id)}: not a decision`
    : `${name(r.decision_id)}: ${quote(r.note ?? '')}`;
  return `${day}  ${LABEL[r.kind]}  ${what}  (${who})`;
}

const TTY_MESSAGE = 'This hides or replaces a decision, or takes a mark back, so it is a person\'s act and needs a terminal. Run it in your own terminal. (A terminal check is a speed bump, not proof: a program can open one. It keeps an agent\'s shell tool and a pipe from doing this by accident.)';

/** The marks that make the guardrail show LESS, or declare a decision replaced. */
function needsTerminal(a: MarkAction): boolean {
  return (a.action === 'check' && a.verdict === 'false') || a.action === 'not-a-decision' || a.action === 'replaces';
}

export async function runMarkCommand(args: string[], opts: MarkCommandOptions, deps: MarkCommandDeps): Promise<number> {
  const dbPath = deps.graphPath();
  const needsGraph = (): number => {
    deps.err('There is no local graph to mark on yet. Capture or connect something with `align capture` or `align connect` first.');
    return 1;
  };
  try {
    if (opts.list) {
      if (!dbPath) return needsGraph();
      const judge = await deps.judge();
      const rows = listJudgements(dbPath, judge.judgeId, args[0]);
      if (rows.length === 0) {
        deps.out(args[0] ? `No marks of yours name ${quote(args[0])}.` : 'No marks yet. `align mark --help` shows what you can mark.');
        return 0;
      }
      const titles = existingTitles(dbPath, [...new Set(rows.flatMap((r) => [r.decision_id, ...(r.counterpart_id ? [r.counterpart_id] : [])]))]);
      for (const r of rows) deps.out(describe(r, titles));
      return 0;
    }
    let files = opts.files && opts.files.length ? opts.files : undefined;
    const draft = parseMarkArgs(args, files);
    if (draft.action === 'check' && files === undefined) {
      // The last check is a default only for the decision it covered, in the directory it ran in.
      const last = deps.lastCheck();
      if (last && last.decision_ids?.includes(draft.id) && last.cwd === process.cwd() && (last.head ?? null) === (await deps.head())) files = last.files;
      else {
        deps.err(last
          ? 'The last `align check` did not cover that decision in this directory, at this commit, so its files are not a default for it. Pass the files: align mark check <id> real|false --files <file>...'
          : 'There is no last `align check` to take the files from. Pass them: align mark check <id> real|false --files <file>...');
        return 2;
      }
    }
    const action = draft.action === 'check' ? { ...draft, files: files ?? [] } : draft;
    if (!dbPath) return needsGraph();
    // Undo needs one too: otherwise a shell could take back a person's verdict and then have an agent write its own.
    if ((opts.undo || opts.force || needsTerminal(action)) && !deps.isTty()) {
      deps.err(TTY_MESSAGE);
      return 1;
    }
    const outcome = applyJudgement({ dbPath, judge: await deps.judge(), origin: { via: 'cli' } }, action, { undo: opts.undo, force: opts.force });
    deps.out(outcome.text);
    return 0;
  } catch (e) {
    if (e instanceof MarkError) {
      deps.err(e.message);
      return e.code === 'usage' ? 2 : 1;
    }
    throw e;
  }
}

export function registerMarkCommand(program: Command): void {
  program
    .command('mark [args...]')
    .description('Record your judgement on what the guardrail shows: a conflict real or false, a replacement, "not a decision", a note. Stays on this machine.')
    .option('--files <paths...>', 'For a check hit: the files the check covered (default: the last `align check`)')
    .option('--undo', 'Take back your own mark')
    .option('--force', 'Replace a decision that is ratified or confirmed (at a terminal)')
    .option('--list', 'Show your marks (optionally those naming one decision id)')
    .action(async (args: string[], opts: MarkCommandOptions) => {
      const code = await runMarkCommand(args, opts, {
        out: (l) => console.log(l),
        err: (l) => console.error(chalk.red(l)),
        graphPath: () => localGraphPath(),
        judge: defaultJudge,
        lastCheck: readLastCheck,
        isTty: () => Boolean(process.stdin.isTTY),
        head: gitHead,
      });
      if (code !== 0) process.exitCode = code;
    });
}
