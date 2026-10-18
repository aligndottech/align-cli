import type { Command } from 'commander';
import { projectFilesWithAlignText } from '../lib/agent-rules.js';
import { agentByName, LAUNCH_AGENTS, resolveAgentBin } from '../lib/launch/agents.js';
import { findOnPath } from '../lib/launch/detect.js';
import { undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';

export interface UseDeps {
  config: { getAgent(): string | undefined; setAgent(agent: string): void; clearAgent(): void; setLaunchOff(off: boolean): void; clearRefusedWrites(): void };
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  /** Every file align wrote into another product's config (C4). */
  writtenConfigs: { get(): Record<string, WrittenConfig>; drop(files: string[]): void };
  env: Record<string, string | undefined>;
  platform: string;
  /** The directory undo looks in for files align wrote that it has no record of. Default: the process cwd. */
  cwd?: string;
  log(line: string): void;
  err(line: string): void;
}

/**
 * `align use [agent]`: switch which coding agent bare `align` opens. Nobody has to run it
 * first - bare `align` picks the one agent it finds - so this is only for changing later.
 * Returns the exit code.
 */
export async function runUse(name: string | undefined, d: UseDeps, opts: { none?: boolean; undo?: boolean } = {}): Promise<number> {
  if (opts.undo) {
    if (name !== undefined || opts.none) {
      d.err('error: --undo takes no agent name and cannot be combined with --none.');
      return 2;
    }
    const manifest = d.writtenConfigs.get();
    if (Object.keys(manifest).length === 0) {
      // The record is empty, but a build that kept none may have written files here. Say so rather
      // than claim there is nothing: undo cannot tell align's text from the user's without a record.
      const unrecorded = projectFilesWithAlignText(d.cwd ?? process.cwd());
      if (unrecorded.length > 0) {
        d.err(`align has no record of writing these files, so it left them alone: ${unrecorded.join(', ')}.`);
        d.err('They carry align text (a block between "align:start" and "align:end" markers, or an "align check" / "align context inject" hook or "align" MCP entry). Remove those by hand; check `git diff` first.');
        return 1;
      }
      d.log('Nothing to undo: align has not written to any agent config.');
      return 0;
    }
    const report = undoWrittenConfigs(manifest);
    for (const f of report.restored) d.log(`Restored ${f} from its backup.`);
    for (const f of report.removed) d.log(`Removed ${f} (align created it).`);
    for (const f of report.cleaned) d.log(`Took align's own entries out of ${f}. Your entries are kept; the file was reformatted.`);
    for (const line of report.skipped) d.err(`Left alone: ${line}`);
    // Only the finished files are forgotten: a skipped one keeps its record (and its backup).
    d.writtenConfigs.drop(report.done);
    // Without this, the next bare `align` would auto-pick the one installed agent and write
    // the same entries back.
    d.config.clearAgent();
    d.config.setLaunchOff(true);
    d.config.clearRefusedWrites();
    const n = report.done.length;
    d.log(`Restored ${n} ${n === 1 ? 'file' : 'files'}. align will not open an agent until you run \`align use <agent>\`.`);
    return report.skipped.length > 0 ? 1 : 0;
  }
  if (opts.none) {
    if (name !== undefined) {
      d.err('error: --none takes no agent name.');
      return 2;
    }
    d.config.clearAgent();
    d.config.setLaunchOff(false); // `--none` means "pick again", which launching being off would contradict
    d.log('Choice cleared. Bare `align` will pick an agent again.');
    return 0;
  }
  if (name === undefined) {
    const current = agentByName(d.config.getAgent());
    d.log(current ? `Agent: ${current.name} (${current.label})` : 'No agent chosen yet. Bare `align` picks one automatically when it finds a supported agent on your PATH.');
    return 0;
  }
  const agent = agentByName(name);
  if (!agent) {
    d.err(`error: unknown agent '${name}'. Choose one of: ${LAUNCH_AGENTS.map((a) => a.name).join(', ')}`);
    return 1;
  }
  if (!agent.supported) {
    d.err(`${agent.label} launching is coming soon. Nothing changed.`);
    return 1;
  }
  if (!resolveAgentBin(agent, d.findOnPath, d.env, d.platform)) {
    d.err(`${agent.bin} is not on your PATH. Install it (${agent.install}), then run this again. Nothing changed. \`align agents\` lists every agent.`);
    return 1;
  }
  d.config.setAgent(agent.name);
  d.log(`Bare \`align\` now opens ${agent.label}.`);
  return 0;
}

export function registerUseCommand(program: Command): void {
  program
    .command('use [agent]')
    .option('--none', 'Clear the choice, so bare `align` picks again')
    .option('--undo', 'Undo what align wrote: removes its entries and blocks, deletes files it created that you have not edited, restores the rest from .align-backup')
    .description('Choose the coding agent bare `align` opens (no argument shows the current one)')
    .action(async (agent: string | undefined, opts: { none?: boolean; undo?: boolean }) => {
      const { createConfigStore } = await import('../lib/config.js');
      const config = createConfigStore();
      const code = await runUse(agent, {
        config,
        writtenConfigs: { get: () => config.getWrittenConfigs(), drop: (files) => config.dropWrittenConfigs(files) },
        findOnPath,
        env: process.env,
        platform: process.platform,
        cwd: process.cwd(),
        log: (l) => console.log(l),
        err: (l) => console.error(l),
      }, opts);
      if (code !== 0) process.exit(code);
    });
}
