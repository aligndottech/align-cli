import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { runSetup } from './setup.js';

/**
 * What `align` does with no arguments (ALI-773).
 *
 * A new user's first instinct is to type the tool's name. That printed a twenty-command help
 * wall and did nothing, leaving them to pick correctly out of setup, login, local, import,
 * capture, context and env before anything happened.
 *
 * The tool already knows whether it is set up, so it acts on that:
 *   - not set up  -> run the onboarding `align setup` runs. That flow asks cloud-or-local
 *                    itself, so nobody has to know `--local` to get the offline path. The
 *                    flag still earns its place where there is nothing to ask: the non-TTY
 *                    branch below suggests `--local --approve` precisely because a scripted
 *                    run cannot answer the question.
 *   - set up      -> say which graph is in play and the two or three things worth doing next.
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

  if (!hasLocal && !hasCloud) {
    // Onboarding asks questions. Without a TTY - a pipe, a CI step, a Dockerfile - those
    // prompts cannot be answered, and starting anyway leaves a half-drawn cancelled prompt
    // and no explanation. Say what to run instead.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log('');
      console.log('  Align is not set up yet, and setup asks a couple of questions.');
      console.log('  Run it from a terminal:');
      console.log('');
      console.log('    align setup');
      console.log('');
      console.log('  Or skip the questions and stay offline, no account:');
      console.log('');
      console.log('    align setup --local --approve');
      console.log('');
      return;
    }
    await runSetup();
    return;
  }

  // Which graph a bare command will actually read.
  //
  // Nothing below carries an --env flag, and that is the point: ask, search, import and now
  // decisions (ALI-772) all resolve to the local graph on their own when that is the only
  // one configured. An earlier draft of this printed `--env local` on every line, which is
  // runnable but teaches a flag nobody needs and makes the tool look harder than it is.
  const envName = hasCloud ? defaultEnv : 'local';

  // Whether the graph has anything in it decides which next step is useful, and it is one
  // read. A failure here (an expired cloud token) must not turn `align` into an error - the
  // command's job is to orient someone, so fall back to the import suggestion.
  let hasDecisions = false;
  try {
    const some = await createGatewayClient(config.getEnvironment(envName)).listDecisions({ limit: 1 });
    hasDecisions = Array.isArray(some) && some.length > 0;
  } catch {
    hasDecisions = false;
  }

  console.log('');
  if (hasLocal && !hasCloud) {
    const path = (local as { localDbPath?: string }).localDbPath ?? 'on this machine';
    console.log(`  ${chalk.green('Local graph')}  ${chalk.dim(path)}`);
  } else {
    console.log(`  ${chalk.green('Signed in')}  ${chalk.dim(defaultEnv)}`);
  }
  console.log('');

  if (hasDecisions) {
    console.log(`${chalk.dim('  Ask it something     ')}align ask "why postgres"`);
    console.log(`${chalk.dim('  See what is in it    ')}align decisions list`);
    console.log(`${chalk.dim('  Add another source   ')}align import git`);
  } else {
    console.log(chalk.dim('  Your graph is empty. Fill it:'));
    console.log(`${chalk.dim('    ')}align import git`);
  }
  console.log('');
  console.log(chalk.dim('  align --help for everything else'));
  console.log('');
}
