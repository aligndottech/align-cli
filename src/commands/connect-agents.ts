import chalk from 'chalk';
import * as p from '@clack/prompts';
import { alignServerEntry, detectEditors, type EditorTarget, writeMcpConfig } from '../lib/mcp-setup.js';
import { codexHookTrustNotice, editedHookNotice } from '../lib/user-hooks.js';
import type { EnvName } from '../lib/config.js';
import { envFlag } from '../lib/destination-name.js';
import { foreignNotice, keptConnectionNotice } from '../lib/foreign-env.js';

/**
 * Connect the agents installed on this machine to Align, only with a person's yes.
 *
 * Each agent's config is user-wide: its MCP entry and pre-edit hook apply in every project on
 * the machine, not just the repo align ran in. So running align in one repo is not consent to
 * change them. Setup lists these files under their own heading and asks once (default yes); it
 * passes `approved` so nobody is asked twice. Any other caller (`align local start`) gets one
 * checklist here, every agent ticked, and with no terminal nothing is written.
 */
export async function connectDetectedAgents(
  envName: EnvName,
  opts: { verbose?: boolean; /** Already detected by the caller (setup lists their files before writing); one detection, one list. */ editors?: EditorTarget[];
    /** The caller wrote the project .mcp.json just before this call (setup does; `align local start` does not). */ projectMcpWritten?: boolean;
    /** The caller already showed these files and the person said yes (setup's confirmation). */ approved?: boolean;
    /** A person is at a terminal to ask. Defaults to stdin and stdout being a TTY, as setup checks: the prompt draws on stdout. */ interactive?: boolean } = {},
): Promise<{ detected: number; connected: number; wired: string[] }> {
  const editors = opts.editors ?? detectEditors();
  // writeMcpConfig takes undefined for prod: the default env needs no --env argument in the
  // spawned server's command line.
  const envArg = envName === 'prod' ? undefined : envName;
  // Runnable AS PRINTED. Bare `align mcp --setup` resolves to the cloud default, so telling a
  // local user to run it would wire their agent to prod - the graph they did not just build.
  // envFlag also refuses a name that is not shell-safe, before anything is written.
  const envSuffix = envFlag(envName);

  if (editors.length === 0) {
    // Named GLOBAL deliberately: detectEditors() only checks each agent's global config
    // (~/.claude.json etc). .mcp.json was already written by writeAgentAlignment, earlier
    // in this same run, and Claude Code and pi both read it - so "detected: 0" here is true
    // of the global check and false of the actual outcome for those two. Saying only "no
    // agent detected" implied nothing was wired, which cost a user (David, 2026-08-31) a
    // confused "shouldn't this have worked" while sitting inside a working Claude Code
    // session the whole time.
    // Rendered from alignServerEntry, never spelled here: this string is pasted
    // BY HAND into a config we were not able to write, so a Windows reader copying a bare
    // `"command": "align"` hits the align.cmd spawn failure with no writer left to fix it.
    const entry = JSON.stringify(alignServerEntry('mcpServers', envArg));
    // On Windows the project file is NOT sufficient, and saying it is would be the same
    // defect restated in prose. `.mcp.json` is committed and read by the whole team, so it
    // keeps the portable bare `align` - which is exactly the command a Windows client cannot
    // spawn. So on Windows those two clients need the per-machine entry as well, and this is
    // the one place a user with no global agent config is told anything at all.
    const win = process.platform === 'win32';
    const covered = !win && opts.projectMcpWritten === true;
    // On POSIX the two project files connect Claude Code and pi, and "Your agent is connected" prints
    // right after this, so leading with "No agent found" contradicts it. The snippet is for the rest.
    const others = 'Other MCP-capable agents (Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, ...) work too';
    // "written above" is only true when the caller wrote the file in this run (`align local start` often does not).
    const written = opts.projectMcpWritten === true;
    const projectNote = win
      ? `The project's .mcp.json and .pi/mcp.json${written ? ' (written above)' : ', if present,'} keep the portable ` +
        '`align` command so it works for the whole team, and Windows cannot spawn that one - so on this machine ' +
        'Claude Code and pi need the per-machine entry below too. '
      : written
        ? 'Claude Code and pi already read the project files written above (.mcp.json for Claude Code, ' +
          '.pi/mcp.json for pi), so those need nothing further. '
        : 'No project .mcp.json or .pi/mcp.json was written in this run, so Claude Code and pi need the entry below too. ';
    // pi reads its own project file, not the shared one: naming only .mcp.json told a pi user the wrong file.
    const lead = covered
      ? 'Claude Code and pi are connected through the project files written above (.mcp.json for Claude Code, ' +
        '.pi/mcp.json for pi), so they need nothing further. The snippet below is only for other agents ' +
        '(Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI, ...)'
      : `No agent found a GLOBAL config to connect to. ${projectNote}${others}`;
    p.log.info(
      `${lead} - add this to ` +
      `their config (or re-run ${chalk.bold(`align mcp --setup${envSuffix}`)} once installed):\n\n` +
      `  { "mcpServers": { "align": ${entry} } }`,
    );
    return { detected: 0, connected: 0, wired: [] };
  }

  const touched: string[] = [];
  // The outro names the agent to open, so say WHICH were wired, not only how many.
  const wired: string[] = [];
  const skipped: string[] = [];
  const keptAgents: string[] = [];
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!opts.approved && !interactive) {
    p.log.info(`Left ${editors.map((e) => e.name).join(', ')} alone: changing an agent's user-wide config needs a yes, and there is no terminal to ask in. Run ${chalk.bold(`align mcp --setup${envSuffix}`)} in a terminal to connect one.`);
    return { detected: editors.length, connected: 0, wired: [] };
  }
  // One checklist, every agent ticked: Enter connects them all, and any can be unticked. Each row
  // names the files it changes, so the yes is to something specific.
  let chosen = editors;
  if (!opts.approved) {
    const picked = await p.multiselect({
      message: 'Connect these agents to Align? Each adds one entry to that agent\'s own config, used in every project on this machine. Space unticks, Enter confirms.',
      options: editors.map((e) => ({ value: e.name, label: e.name, hint: [e.configPath, ...(e.hooks ? [e.hooks.path] : [])].join(', ') })),
      initialValues: editors.map((e) => e.name),
      required: false,
    });
    if (p.isCancel(picked)) {
      p.log.info('Left every agent alone.');
      return { detected: editors.length, connected: 0, wired: [] };
    }
    const names = picked as string[];
    chosen = editors.filter((e) => names.includes(e.name));
    for (const e of editors) if (!names.includes(e.name)) p.log.info(`Left ${e.name} alone.`);
  }
  for (const target of chosen) {
    try {
      // The MCP entry, plus the user-level pre-edit hook on the hosts that have one
      // (Codex, Cursor, Copilot CLI) - the writer reports every file it wrote.
      const files = writeMcpConfig(target, envArg, (file) => {
        skipped.push(file);
        if (!keptAgents.includes(target.name)) keptAgents.push(target.name);
      }, (file) => p.log.warn(editedHookNotice(file)));
      touched.push(...files);
      const trust = codexHookTrustNotice(target.hooks, files);
      if (trust) p.log.info(trust);
      // Connected only if the MCP entry itself was written. A skipped one (the local wizard
      // leaves an existing non-local entry alone) is reported by the warning below instead.
      if (files.includes(target.configPath)) {
        wired.push(target.name);
        p.log.success(`${target.name}: align MCP connected${target.hooks ? ', pre-edit check hooked' : ''}`);
      }
    } catch (err) {
      // One unwritable config must not abort onboarding, or a stale Zed install stops a user
      // finishing setup.
      p.log.warn(`${target.name}: ${(err as Error).message}`);
    }
  }

  // Inside the wizard frame (p.log), not a bare stderr line outside it.
  // One calm line for the whole run; the per-file detail and the switch command are verbose-only.
  const kept = keptConnectionNotice(keptAgents);
  if (kept) p.log.info(kept);
  if (opts.verbose) for (const file of skipped) p.log.info(foreignNotice(file, 'global'));

  // Naming the FILES, not just the agents. "Cursor: connected" does not tell anyone what was
  // edited, and this is the only disclosure they get in place of being asked.
  if (touched.length > 0) {
    p.log.info(
      chalk.dim(
        `Added an "align" entry to ${touched.length === 1 ? 'this file' : 'these files'} (an MCP server, and a pre-edit check hook where the agent has one):\n${
          touched.map((f) => `  ${f}`).join('\n')
        }\nNothing else in ${touched.length === 1 ? 'it' : 'them'} was changed. Undo any time: ${chalk.bold('align mcp --remove')}`,
      ),
    );
  }

  // mcp_wired is a funnel stage, emitted from this single choke point so
  // setup, `align local start` and `align mcp --setup` all count without three call
  // sites. Consent gating lives inside recordFunnelStage.
  if (touched.length > 0) {
    const { recordFunnelStage } = await import('../lib/usage-telemetry.js');
    const { createConfigStore } = await import('../lib/config.js');
    // No await (Copilot on #215): the emitter never throws, and setup has more work
    // after this - telemetry must not add its 2s worst case to the wiring step.
    void recordFunnelStage(createConfigStore().getEnvironment(envName), 'mcp_wired', 'mcp');
  }

  return { detected: editors.length, connected: touched.length, wired };
}
