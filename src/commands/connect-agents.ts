import chalk from 'chalk';
import * as p from '@clack/prompts';
import { detectEditors, writeMcpConfig } from '../lib/mcp-setup.js';
import type { EnvName } from '../lib/config.js';

/**
 * Connect the agents installed on this machine to Align (ALI-776).
 *
 * WHY THIS ASKS
 * -------------
 * Setup writes a lot without asking, and should: `.mcp.json`, `CLAUDE.md`, the hook configs
 * all live in the repo the user ran us in. They can see them in a diff and delete them.
 *
 * These are different. `~/.claude.json`, a Claude Desktop config, `~/.cursor/mcp.json` are
 * user-level files people curate, shared across every project they have. Editing one
 * silently is the kind of thing someone discovers weeks later and resents, and the cloud
 * path did exactly that whenever it detected precisely one editor - it only prompted at two
 * or more. One keystroke costs almost nothing; a surprise edit to a global config costs
 * trust.
 *
 * Default yes, so `align` still just works for anyone pressing Enter.
 *
 * WHY IT IS SHARED
 * ----------------
 * Local setup used to skip this entirely, so a local-only user - the one for whom an agent
 * running on their own machine is the whole point - got LESS wiring than a cloud user. Both
 * paths call this now, so they cannot drift apart again.
 */
export async function connectDetectedAgents(
  envName: EnvName,
  opts: { interactive: boolean; assumeYes?: boolean },
): Promise<{ detected: number; connected: number }> {
  const editors = detectEditors();
  // writeMcpConfig takes undefined for prod: the default env needs no --env argument in the
  // spawned server's command line.
  const envArg = envName === 'prod' ? undefined : envName;
  // Every mention of the manual command below carries the env, so it is runnable AS PRINTED.
  // Bare `align mcp --setup` resolves to the cloud default, so telling a local user to run it
  // would wire their agent to prod - the graph they did not just build. Same trap as the bare
  // `align decisions list` in ALI-772.
  const setupCmd = `align mcp --setup${envArg ? ` --env ${envArg}` : ''}`;

  if (editors.length === 0) {
    // Align is just an MCP server, so any MCP-capable agent works even when we cannot detect
    // one. Hand over the portable config rather than implying it is unsupported.
    const envArgs = envArg ? `, "--env", "${envArg}"` : '';
    p.log.info(
      'No MCP agent detected automatically. Align works with any MCP-capable agent ' +
      '(Claude, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, pi, ...).\n' +
      `Add this to your agent's MCP config (or re-run ${chalk.bold(setupCmd)} once it is installed):\n\n` +
      `  { "mcpServers": { "align": { "command": "align", "args": ["mcp"${envArgs}] } } }`,
    );
    return { detected: 0, connected: 0 };
  }

  const names = editors.map((e) => e.name).join(', ');

  // `--approve` is the user saying yes to everything up front, so it IS consent - it must
  // not be read as "skip", or a scripted setup silently loses its agent wiring.
  // Anything else without a TTY has nobody to ask: neither write (the silent edit this
  // refuses) nor prompt (a hang - which is what the old unguarded multiselect did).
  if (!opts.assumeYes && !opts.interactive) {
    p.log.info(
      `Detected ${names}. Run ${chalk.bold(setupCmd)} to connect ${editors.length === 1 ? 'it' : 'them'} to Align.`,
    );
    return { detected: editors.length, connected: 0 };
  }

  const ok = opts.assumeYes
    ? true
    : await p.confirm({
        message: `Connect ${names} to Align? This edits ${editors.length === 1 ? 'its' : 'their'} MCP config.`,
        initialValue: true,
      });
  if (p.isCancel(ok) || !ok) {
    p.log.info(`Skipped. ${chalk.bold(setupCmd)} connects them any time.`);
    return { detected: editors.length, connected: 0 };
  }

  let connected = 0;
  for (const target of editors) {
    try {
      writeMcpConfig(target, envArg);
      connected++;
      p.log.success(`${target.name}: align MCP connected`);
    } catch (err) {
      // One unwritable config must not abort onboarding, or a stale Zed install stops a user
      // finishing setup.
      p.log.warn(`${target.name}: ${(err as Error).message}`);
    }
  }
  return { detected: editors.length, connected };
}
