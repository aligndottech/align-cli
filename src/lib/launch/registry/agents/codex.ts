import type { AgentSpec } from '../types.js';

export const codex: AgentSpec = {
  name: 'codex',
  label: 'Codex',
  bin: 'codex',
  injection: 'per-session',
  supported: false,
  install: 'npm i -g @openai/codex',
};
