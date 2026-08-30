import chalk from 'chalk';
import * as p from '@clack/prompts';
import { detectEditors, writeMcpConfig } from '../lib/mcp-setup.js';
import type { EnvName } from '../lib/config.js';

/**
 * Connect the agents installed on this machine to Align (ALI-776).
 *
 * WHY THIS DOES NOT ASK
 * ---------------------
 * An earlier version of this asked once, default yes, on the grounds that a global editor
 * config is a user-level file and editing one silently is rude. Two facts moved it:
 *
 *   1. The write is ADDITIVE. writeJsonConfig reads the existing file, adds one key named
 *      `align` under mcpServers, and preserves everything else - and throws rather than
 *      overwriting if the JSON is invalid. It is not the intrusion it sounds like.
 *   2. An agent reading your decision graph IS the product. A prompt costs every user a
 *      keystroke so that a few can decline the one thing that makes Align do anything, and
 *      a default-yes confirm that everyone Enters through is not consent, it is ceremony.
 *
 * So it does it, says exactly which files it touched, and names the one command that undoes
 * it. Disclosure plus a real undo beats a question nobody reads.
 *
 * Project files (.mcp.json, CLAUDE.md, the hook configs) are written elsewhere and are not in
 * question: they live in the repo the user ran us in, show up in a diff, and can be deleted.
 */
export async function connectDetectedAgents(
  envName: EnvName,
): Promise<{ detected: number; connected: number }> {
  const editors = detectEditors();
  // writeMcpConfig takes undefined for prod: the default env needs no --env argument in the
  // spawned server's command line.
  const envArg = envName === 'prod' ? undefined : envName;
  // Runnable AS PRINTED. Bare `align mcp --setup` resolves to the cloud default, so telling a
  // local user to run it would wire their agent to prod - the graph they did not just build.
  const envSuffix = envArg ? ` --env ${envArg}` : '';

  if (editors.length === 0) {
    // Align is just an MCP server, so any MCP-capable agent works even when we cannot detect
    // one. Hand over the portable config rather than implying it is unsupported.
    const envArgs = envArg ? `, "--env", "${envArg}"` : '';
    p.log.info(
      'No MCP agent detected automatically. Align works with any MCP-capable agent ' +
      '(Claude, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, pi, ...).\n' +
      `Add this to your agent's MCP config (or re-run ${chalk.bold(`align mcp --setup${envSuffix}`)} once it is installed):\n\n` +
      `  { "mcpServers": { "align": { "command": "align", "args": ["mcp"${envArgs}] } } }`,
    );
    return { detected: 0, connected: 0 };
  }

  const touched: string[] = [];
  for (const target of editors) {
    try {
      writeMcpConfig(target, envArg);
      touched.push(target.configPath);
      p.log.success(`${target.name}: align MCP connected`);
    } catch (err) {
      // One unwritable config must not abort onboarding, or a stale Zed install stops a user
      // finishing setup.
      p.log.warn(`${target.name}: ${(err as Error).message}`);
    }
  }

  // Naming the FILES, not just the agents. "Cursor: connected" does not tell anyone what was
  // edited, and this is the only disclosure they get in place of being asked.
  if (touched.length > 0) {
    p.log.info(
      chalk.dim(
        `Added an "align" entry to ${touched.length === 1 ? 'this file' : 'these files'}:\n${
          touched.map((f) => `  ${f}`).join('\n')
        }\nNothing else in ${touched.length === 1 ? 'it' : 'them'} was changed. Undo any time: ${chalk.bold('align mcp --remove')}`,
      ),
    );
  }

  return { detected: editors.length, connected: touched.length };
}
