import { buildGrokLaunch } from '../../adapters/grok-build.js';
import { grokHome, isGrokBuildBin } from '../../grok-state.js';
import type { AgentSpec } from '../types.js';

export const grokBuild: AgentSpec = {
  name: 'grok-build',
  label: 'Grok Build',
  // Generic on its own: `acceptsBin` takes a `grok` only from Grok Build's install locations.
  bin: 'grok',
  injection: 'written-once',
  supported: true,
  install: { kind: 'docs', url: 'https://x.ai/build', text: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  acceptsBin: (found, env, platform) => isGrokBuildBin(found, env, platform),
  // Not runnable here; pinned fail closed to the ~/.grok Align reads (resolved as Grok Build does).
  pins: (d) => ({ GROK_HOME: grokHome(d.env, d.platform) }),
  build: (d, base) => buildGrokLaunch({ ...base, ...d.readGrokState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
