import { buildCodexLaunch } from '../../adapters/codex.js';
import type { AgentSpec } from '../types.js';

export const codex: AgentSpec = {
  name: 'codex',
  label: 'Codex',
  bin: 'codex',
  injection: 'per-session',
  supported: true,
  install: 'npm i -g @openai/codex',
  build: (d, base) => buildCodexLaunch({ ...base, ...d.readCodexState(d.cwd, d.home, d.env, d.platform) }),
};
