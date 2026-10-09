import { buildGrokLaunch } from '../../adapters/grok-build.js';
import { isGrokBuildBin } from '../../grok-state.js';
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
  build: (d, base) => buildGrokLaunch({ ...base, ...d.readGrokState!(d.cwd, d.home, d.env, d.platform, base.passthrough) }),
};
