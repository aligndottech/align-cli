import { buildContinueLaunch } from '../../adapters/continue.js';
import { continueHome, isContinueBin } from '../../continue-state.js';
import type { AgentSpec } from '../types.js';

export const continueCli: AgentSpec = {
  name: 'continue',
  label: 'Continue CLI',
  // Two letters, so `acceptsBin` takes a `cn` only when it is the npm package's own (both of
  // Continue's installers run `npm install -g @continuedev/cli`).
  bin: 'cn',
  injection: 'per-session',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@continuedev/cli'] },
  acceptsBin: (found, _env, platform) => isContinueBin(found, platform),
  // cn runs dotenv in the cwd: pin the continue home Align read.
  // The other variables cn reads that place config or models (its source, 1.5.47): the API base it
  // fetches a default config and models from when there is no local config.yaml (cn's default,
  // env.ts), and the onboarding switch to Bedrock models. Off/default unless the user exported them.
  pins: (d) => ({ CONTINUE_GLOBAL_DIR: continueHome(d.home, d.env, d.cwd), CONTINUE_API_BASE: 'https://api.continue.dev/', CONTINUE_USE_BEDROCK: '0' }),
  build: (d, base) => buildContinueLaunch({ ...base, env: d.env, ...d.readContinueState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
