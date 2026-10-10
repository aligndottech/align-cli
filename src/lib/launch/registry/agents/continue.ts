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
  pins: (d) => ({ CONTINUE_GLOBAL_DIR: continueHome(d.home, d.env, d.cwd) }),
  build: (d, base) => buildContinueLaunch({ ...base, ...d.readContinueState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
