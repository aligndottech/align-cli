import { buildGooseLaunch } from '../../adapters/goose.js';
import type { AgentSpec } from '../types.js';

export const goose: AgentSpec = {
  name: 'goose',
  label: 'Goose',
  bin: 'goose',
  injection: 'per-session',
  supported: true,
  // A release binary from a script or Homebrew; there is no npm package, so Align only prints it.
  install: { kind: 'docs', url: 'https://goose-docs.ai/docs/getting-started/installation', text: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash' },
  build: (d, base) => buildGooseLaunch({ passthrough: base.passthrough, ...d.readGooseState!(d.cwd, d.home, d.env, d.platform) }),
};
