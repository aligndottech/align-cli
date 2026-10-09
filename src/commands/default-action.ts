import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import pkg from '../../package.json' with { type: 'json' };
import { printBanner } from '../lib/brand.js';
import { detectWiredEditors, projectMcpAgents } from '../lib/mcp-setup.js';
import { cardLabel, type CardValue, orderAgents, renderSecondRunCard } from '../lib/next-step.js';
import { launchesAfterWizard, launchIfChosen } from '../lib/launch/launch.js';

/**
 * What `align` does with no arguments (ALI-773).
 *
 * A new user's first instinct is to type the tool's name. That printed a twenty-command help
 * wall and did nothing, leaving them to pick correctly out of setup, login, local, import,
 * capture, context and env before anything happened.
 *
 * The tool already knows whether it is set up, so it acts on that:
 *   - not set up  -> run the local-first wizard `align setup` runs (C5): pick your coding
 *                    agent, connect your tools, build the local graph - then open the agent.
 *                    There is no cloud question; a solo developer's graph is local. The
 *                    non-TTY branch below suggests `align setup --approve` because a
 *                    scripted run cannot answer the wizard's questions.
 *   - set up      -> the second-run card (ALI-950): which graph is in play, which agents are
 *                    wired, what the graph did this week, and the one thing to do next -
 *                    which happens in the agent, not here.
 *
 * `align --help` still prints the full command list; Commander handles that before this runs.
 */
export async function runDefaultAction(): Promise<void> {
  const config = createConfigStore();
  const local = config.getEnvironment('local');
  const defaultEnv = config.getDefaultEnv();
  const cloud = config.getEnvironment(defaultEnv);

  const hasLocal = local.mode === 'local-embedded';
  const hasCloud = Boolean(cloud.authToken);

  // Nothing set up. A team user (a token on the default env) is not here: they keep the
  // "Signed in" card below exactly as before, and `align setup` routes them to team setup.
  // What runs here is `runSetup`, which itself routes by login / ALIGN_ENV, so an
  // ALIGN_ENV=prod machine with no token lands in the team login, not the local wizard.
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!hasLocal && !hasCloud) {
    // Onboarding asks questions. Without a TTY - a pipe, a CI step, a Dockerfile - those
    // prompts cannot be answered, and starting anyway leaves a half-drawn cancelled prompt
    // and no explanation. Say what to run instead.
    if (!tty) {
      console.log('');
      console.log('  Align is not set up yet, and setup asks a couple of questions.');
      console.log('  Run it from a terminal:');
      console.log('');
      console.log('    align setup');
      console.log('');
      console.log('  Or skip the questions:');
      console.log('');
      console.log('    align setup --approve');
      console.log('');
      return;
    }
    // No banner here: runSetup prints its own opening lockup, and printing one first
    // stacked two full banners on a fresh user's very first command (found live
    // 2026-09-02). The banner belongs to whichever flow owns the screen.
    const { runSetup } = await import('./setup.js');
    await runSetup({ launchNext: true });

    // The wizard's last step is `align` itself: open the agent it just wired. Re-read the
    // config (the wizard wrote it). Launch only when a local graph now exists AND an agent was
    // chosen: with none installed the real launcher prints its own "no agent" error and returns
    // exit 1, which would turn a finished wizard into a failed command. The wizard already
    // said what to install, so a clean exit 0 is the right end.
    const after = createConfigStore();
    if (launchesAfterWizard({ localGraph: after.getEnvironment('local').mode === 'local-embedded', agent: after.getAgent(), isTTY: tty })) {
      const launch = await launchIfChosen();
      if (launch.handled) process.exit(launch.code);
    }
    return;
  }

  // C1: a set-up local graph and a coding agent means `align` IS the agent. Decided before
  // anything heavy loads (setup, the gateway client, the readout below are all dynamic
  // imports on the card path only), so the launch costs one config read and a PATH scan.
  // process.exit rather than return: the child's exit code is the command's, and Commander's
  // postAction telemetry must not run after a whole agent session.
  if (hasLocal) {
    const launch = await launchIfChosen();
    if (launch.handled) process.exit(launch.code);
  }

  // Typing the bare tool name is the other first-contact moment, so it gets the
  // same lockup. printBanner is a no-op off a TTY, so piped output stays clean.
  printBanner({ version: pkg.version });

  // Which graph a bare command will actually read.
  //
  // Nothing below carries an --env flag, and that is the point: ask, search, import and now
  // decisions (ALI-772) all resolve to the local graph on their own when that is the only
  // one configured. An earlier draft of this printed `--env local` on every line, which is
  // runnable but teaches a flag nobody needs and makes the tool look harder than it is.
  const envName = hasCloud ? defaultEnv : 'local';

  // Whether the graph has anything in it decides which next step is useful, and the most
  // recent decision is the question to hand the agent - one read gives both, and a failure
  // (an expired cloud token) falls back to the import suggestion rather than erroring: the
  // command's job is to orient someone.
  const { createGatewayClient } = await import('../lib/gateway-client.js');
  const { firstDecision } = await import('../lib/first-decision.js');
  const { readValueRollup } = await import('../lib/read-value-rollup.js');
  const { hasDecisions, firstTitle } = await firstDecision(createGatewayClient(config.getEnvironment(envName)));

  // ALI-950: the ALI-215 readout `align status` prints, read for a 7-day window so the card
  // can say "this week" and mean it. Best effort for the same reason as above - a card with
  // no readout line beats no card.
  let value: CardValue | undefined;
  try {
    const { mode, rollup } = await readValueRollup(config, envName, { days: 7 });
    value = { mode, decisions: rollup.decisions, conflictsCaught: rollup.conflictsCaught, reuseRate: rollup.reuseRate };
  } catch {
    value = undefined;
  }

  // The agents wired NOW, by name: this repo's project config first (it is the one the user
  // is most likely sitting in), then every global config that carries an align entry.
  const agents = orderAgents({
    project: projectMcpAgents(process.cwd()),
    global: detectWiredEditors().map((e) => e.name),
  });

  const graphLine = hasLocal && !hasCloud
    ? `${chalk.green(cardLabel('Local graph'))}${chalk.dim((local as { localDbPath?: string }).localDbPath ?? 'on this machine')}`
    : `${chalk.green(cardLabel('Signed in'))}${chalk.dim(defaultEnv)}`;

  console.log('');
  console.log(renderSecondRunCard({ graphLine, agents, hasDecisions, firstTitle, envName, value }));
  console.log('');
}
