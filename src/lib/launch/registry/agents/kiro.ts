import { buildKiroLaunch } from '../../adapters/kiro.js';
import { kiroDir } from '../../kiro-state.js';
import type { AgentSpec } from '../types.js';

export const kiro: AgentSpec = {
  name: 'kiro',
  label: 'Kiro CLI',
  bin: 'kiro-cli',
  injection: 'written-once',
  supported: true,
  install: { kind: 'docs', url: 'https://kiro.dev/docs/cli/', text: 'curl -fsSL https://cli.kiro.dev/install | bash' },
  // Not runnable here; pinned fail closed to the dir Align reads (Kiro's documented default).
  pins: (d) => ({ KIRO_HOME: kiroDir(d.home, d.env) }),
  build: (d, base) => buildKiroLaunch({ ...base, ...d.readKiroState!(d.cwd, d.home, d.env, d.platform) }),
};
