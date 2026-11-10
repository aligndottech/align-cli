import type { createConfigStore, EnvironmentConfig, EnvName } from './config.js';
import { getLocalDbPath } from './local-mode.js';
import { resolveEnv } from './resolve-env.js';

type ConfigStore = ReturnType<typeof createConfigStore>;

/**
 * The environment `align mcp` serves. Directories hand out `npx -y @aligndottech/cli mcp`, so on
 * a machine where nothing was ever set up this is the first command a person runs. resolveEnv
 * would pick the hosted prod gateway there (no login, every call fails, every tool description
 * naming https://api.align.tech), because the `local` env only becomes local-embedded once setup
 * runs. So, with no explicit choice, no team login and no local graph yet, serve the local graph
 * at the path setup would use. Nothing is written to the config: starting a server is not setup.
 */
export function resolveMcpEnvironment(flag: string | undefined, config: ConfigStore, localDbPath: string = getLocalDbPath()): { name: EnvName; env: EnvironmentConfig } {
  const name = resolveEnv(flag, { preferLocalEmbedded: true, config });
  const env = config.getEnvironment(name);
  // A set ALIGN_GATEWAY_URL names a server, and a saved team destination (`align join`) means the
  // person belongs to a team graph: neither is "nothing set up", so both keep the old resolution.
  const chosen = Boolean(flag || process.env['ALIGN_ENV'] || process.env['ALIGN_GATEWAY_URL']);
  const joined = config.listTeamDestinationNames().length > 0;
  const local = config.getEnvironment('local');
  if (!chosen && !joined && name !== 'local' && !env.authToken && env.mode !== 'demo' && local.mode !== 'local-embedded') {
    return { name: 'local', env: { ...local, mode: 'local-embedded', localDbPath } };
  }
  return { name, env };
}
