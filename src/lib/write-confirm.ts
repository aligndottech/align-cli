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
  /** ALI-2069: 'user' is a file outside the project that every project on this machine reads
   *  (an agent's own config or user-level hook file). Listed under its own heading. Absent = project. */
  scope?: 'project' | 'user';
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
  const add = (abs: string, display: string, action: 'create' | 'modify', scope: 'project' | 'user') => {
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ file: abs, display, action, scope });
  };
  const inProject = (abs: string) => !path.relative(opts.cwd, abs).startsWith('..') && !path.isAbsolute(path.relative(opts.cwd, abs));
  for (const { file, action } of planAgentAlignment(opts.cwd)) add(path.join(opts.cwd, file), file, action, 'project');
  for (const editor of opts.editors) {
    for (const file of mcpConfigFiles(editor)) {
      add(file, homeDisplay(file, home), existsSync(file) ? 'modify' : 'create', inProject(file) ? 'project' : 'user');
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

/** ALI-2069: a change outside the project is said to be one, so nobody finds it later by surprise. */
export const USER_WIDE_HEADING = 'Outside this project (user-wide, read by every project on this machine):';

/** The list, one file per line, project files first and user-wide files under their own heading.
 *  Plain text so the same lines print on a terminal and in a log. */
export function renderWritePlan(files: PlannedWrite[]): string {
  const width = Math.max(...files.map((f) => f.action.length));
  const line = (f: PlannedWrite) => `  ${f.action.padEnd(width)}  ${f.display}`;
  const project = files.filter((f) => f.scope !== 'user');
  const user = files.filter((f) => f.scope === 'user');
  return [WRITE_PLAN_HEADING, ...project.map(line), ...(user.length ? [USER_WIDE_HEADING, ...user.map(line)] : [])].join('\n');
}

/**
 * Shown with the list, before the question. `align use --undo` replays the write manifest, which
 * records the project files AND each agent's own config (write-confirm.test.ts pins both), so one
 * command covers every file listed. `align mcp --remove` also works, but only for the agent configs.
 */
export const WRITE_UNDO_LINE = 'The first copy of any file that already exists is kept. Undo any time: align use --undo (it covers every file listed, project and agent config alike)';

export const WRITE_CONFIRM_QUESTION = 'Continue?';

/** ALI-2069: printed instead of writing when nobody could be asked (no terminal) and nobody passed the flag. */
export const WRITE_NOT_APPROVED_LINE = 'Nothing written: there is no terminal to ask in. Run align in a terminal, or pass --approve to allow these files.';

/**
 * Show the list, then ask. The list prints on EVERY run, so a scripted run leaves a record of
 * what it touched. With a person at a terminal the question is asked; --approve is the yes for a
 * scripted run. With no terminal and no --approve nobody said yes, so nothing is written
 * (ALI-2069: an agent running align in its own shell must not edit agent config unasked).
 * Returns false when the person says no, cancels, or could not be asked.
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
  if (opts.approve) return true;
  if (!opts.interactive) {
    opts.print(WRITE_NOT_APPROVED_LINE);
    return false;
  }
  return (await opts.ask(WRITE_CONFIRM_QUESTION)) === true;
}
