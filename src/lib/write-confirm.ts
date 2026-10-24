import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planAgentAlignment } from './agent-rules.js';
import { type EditorTarget, mcpConfigFiles } from './mcp-setup.js';

/** One file setup will create or modify. `display` is what the person reads. */
export interface PlannedWrite {
  /** Absolute path. */
  file: string;
  display: string;
  action: 'create' | 'modify';
}

/**
 * A path under home as `~/...` with forward slashes on every OS, so the list reads the same as the
 * project rows. Windows' native separator made it `~\.codex\config.toml` beside `.claude/settings.json`.
 */
export function homeDisplay(file: string, home: string): string {
  const under = file.startsWith(`${home}/`) || file.startsWith(`${home}\\`);
  return under ? `~${file.slice(home.length).replace(/\\/g, '/')}` : file;
}

/**
 * Every file one setup run can create or modify: the project's agent files, then each detected
 * agent's own config. Built from the tables the writers themselves run (planAgentAlignment,
 * mcpConfigFiles), never from a second hand-written list.
 */
export function planSetupWrites(opts: { cwd: string; editors: EditorTarget[]; home?: string }): PlannedWrite[] {
  const home = opts.home ?? os.homedir();
  const out: PlannedWrite[] = [];
  const seen = new Set<string>();
  const add = (abs: string, display: string, action: 'create' | 'modify') => {
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ file: abs, display, action });
  };
  for (const { file, action } of planAgentAlignment(opts.cwd)) add(path.join(opts.cwd, file), file, action);
  for (const editor of opts.editors) {
    for (const file of mcpConfigFiles(editor)) {
      add(file, homeDisplay(file, home), existsSync(file) ? 'modify' : 'create');
    }
  }
  return out;
}

/**
 * "may": the list is every file a writer CAN touch. A writer leaves its file as found when it is a
 * symlink or the entry in it belongs to a team, and that is decided inside the writer while it runs
 * (agent-rules.ts, mcp-setup.ts), so it cannot be asked ahead of time without a second copy of the rule.
 */
export const WRITE_PLAN_HEADING = 'Align may create or change these files:';

/** The list, one file per line. Plain text so the same lines print on a terminal and in a log. */
export function renderWritePlan(files: PlannedWrite[]): string {
  const width = Math.max(...files.map((f) => f.action.length));
  return [WRITE_PLAN_HEADING, ...files.map((f) => `  ${f.action.padEnd(width)}  ${f.display}`)].join('\n');
}

/**
 * Shown with the list, before the question. `align use --undo` replays the write manifest, which
 * records the project files AND each agent's own config (write-confirm.test.ts pins both), so one
 * command covers every file listed. `align mcp --remove` also works, but only for the agent configs.
 */
export const WRITE_UNDO_LINE = 'The first copy of any file that already exists is kept. Undo any time: align use --undo (it covers every file listed, project and agent config alike)';

export const WRITE_CONFIRM_QUESTION = 'Continue?';

/**
 * Show the list, then ask. The list prints on EVERY run, so a scripted run leaves a record of
 * what it touched. The question is asked only with a person at a terminal and without
 * --approve; otherwise the run goes ahead, as it did before the prompt existed.
 * Returns false only when the person says no (or cancels).
 */
export async function confirmWrites(opts: {
  files: PlannedWrite[];
  approve?: boolean;
  interactive: boolean;
  print: (text: string) => void;
  /** The yes/no prompt. Default yes. Resolves to undefined when the person cancels. */
  ask: (message: string) => Promise<boolean | undefined>;
}): Promise<boolean> {
  if (opts.files.length === 0) return true;
  opts.print(`${renderWritePlan(opts.files)}\n${WRITE_UNDO_LINE}`);
  if (!opts.interactive || opts.approve) return true;
  return (await opts.ask(WRITE_CONFIRM_QUESTION)) === true;
}
