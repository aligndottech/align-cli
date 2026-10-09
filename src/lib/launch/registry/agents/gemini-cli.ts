import { buildGeminiLaunch } from '../../adapters/gemini-cli.js';
import type { AgentSpec } from '../types.js';

export const geminiCli: AgentSpec = {
  name: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  injection: 'per-session',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@google/gemini-cli'] },
  build: (d, base) => buildGeminiLaunch({ ...base, env: d.env, platform: d.platform, ...d.readGeminiState(d.cwd, d.home, d.env, d.platform) }),
};
