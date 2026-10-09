import type { AgentSpec } from '../types.js';

export const geminiCli: AgentSpec = {
  name: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  injection: 'per-session',
  supported: false,
  install: 'npm i -g @google/gemini-cli',
};
