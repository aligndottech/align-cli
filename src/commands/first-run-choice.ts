import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { runChoiceKey } from '../lib/run-choice-key.js';
import { findOnPath } from '../lib/launch/detect.js';
import { askRunMode, type ChoiceResult, resolveRunChoice, suggestRunMode } from '../lib/first-run-choice.js';

/**
 * Choosing "keep my agent" runs the same three steps setup runs, in the same order: list the files
 * and ask (default yes), write the project's hook and rules, then add the MCP server to each
 * detected agent. Nothing here is a second copy: confirmAgentWrites, writeAgentAlignment and
 * connectDetectedAgents are setup's own. No tool is pre-approved in any agent's permissions.
 */
async function wireExistingAgents(): Promise<boolean> {
  const { confirmAgentWrites, writeAgentAlignment } = await import('./setup.js');
  const { connectDetectedAgents } = await import('./connect-agents.js');
  const { confirmed, editors } = await confirmAgentWrites({ interactive: true });
  if (!confirmed) return false;
  writeAgentAlignment('local');
  await connectDetectedAgents('local', { editors, projectMcpWritten: true, approved: true });
  return true;
}

/** The answer is per repo: the main repository's root (worktrees share it), or the folder itself outside git. */
export async function runFirstRunChoice(o: { switching?: boolean; alreadyWired?: boolean } = {}): Promise<ChoiceResult> {
  const config = createConfigStore();
  const repo = await runChoiceKey(process.cwd());
  return resolveRunChoice({
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    switching: o.switching === true,
    alreadyWired: o.alreadyWired,
    suggestion: suggestRunMode(findOnPath, process.env, process.platform),
    getStored: () => config.getRunChoice(repo),
    setStored: (mode) => config.setRunChoice(repo, mode),
    ask: askRunMode,
    wire: wireExistingAgents,
    say: (line) => console.error(chalk.dim(`  ${line}`)),
  });
}
