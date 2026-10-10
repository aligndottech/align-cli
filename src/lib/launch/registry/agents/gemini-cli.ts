import { buildGeminiLaunch } from '../../adapters/gemini-cli.js';
import type { AgentSpec } from '../types.js';

export const geminiCli: AgentSpec = {
  name: 'gemini-cli',
  label: 'Gemini CLI',
  bin: 'gemini',
  injection: 'written-once',
  supported: true,
  install: { kind: 'npm', argv: ['npm', 'i', '-g', '@google/gemini-cli'] },
  build: (d, base) => buildGeminiLaunch({ ...base, ...d.readGeminiState(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
