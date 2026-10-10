import { buildGooseLaunch } from '../../adapters/goose.js';
import { gooseRecipeMentions, isGooseBin } from '../../goose-state.js';
import type { AgentSpec } from '../types.js';

export const goose: AgentSpec = {
  name: 'goose',
  label: 'Goose',
  // Also the name of pressly/goose (a Go migration CLI): `acceptsBin` takes a `goose` only from
  // Block's install places.
  bin: 'goose',
  injection: 'per-session',
  supported: true,
  // A release binary from a script or Homebrew; there is no npm package, so Align only prints it.
  install: { kind: 'docs', url: 'https://goose-docs.ai/docs/getting-started/installation', text: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash' },
  acceptsBin: (found, env, platform) => isGooseBin(found, env, platform),
  build: (d, base) => buildGooseLaunch({
    passthrough: base.passthrough,
    ...d.readGooseState!(d.cwd, d.home, d.env, d.platform),
    recipeDefinesAlignLocal: gooseRecipeMentions(d.cwd, base.passthrough),
  }),
};
