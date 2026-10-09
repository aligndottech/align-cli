import { buildPiLaunch } from '../../adapters/pi.js';
import type { AgentSpec } from '../types.js';

export const pi: AgentSpec = {
  name: 'pi',
  label: 'pi',
  bin: 'pi',
  injection: 'written-once',
  supported: true,
  install: 'https://pi.dev',
  build: (d, base) => buildPiLaunch({ ...base, ...d.readPiState(d.cwd, d.home, d.env) }),
};
