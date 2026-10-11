import type { EnvironmentConfig, EnvName } from './config.js';

/**
 * Which setup `align setup` runs (C5). Solo is local only. A team LOGIN means TEAM: a stored
 * token (or ALIGN_TOKEN, which the config store folds into every env), or ALIGN_ENV naming a
 * team env, sends setup to the team path, and nothing here ever rewires such a user to local
 * behind their back. An explicit flag always wins over both.
 */
export const VALID_ENVS: readonly EnvName[] = ['local', 'preview', 'prod'];

export type SetupRoute =
  | { kind: 'local'; teamLoginUntouched?: 'prod' | 'preview' }
  | { kind: 'team'; env: EnvName };

export class InvalidEnvError extends Error {
  constructor(value: string, destinations: string[] = []) {
    super(`Unknown environment "${value}". Valid environments: ${[...VALID_ENVS, ...destinations].join(', ')}.`);
    this.name = 'InvalidEnvError';
  }
}

const isTeamEnv = (v: string | undefined): v is 'prod' | 'preview' => v === 'prod' || v === 'preview';

export function routeSetup(
  opts: { env?: string; local?: boolean },
  config: {
    getEnvironment(env: EnvName): EnvironmentConfig;
    getDefaultEnv(): EnvName;
    hasTeamDestination(name: string): boolean;
    listTeamDestinationNames(): string[];
  },
  processEnv: Record<string, string | undefined>,
): SetupRoute {
  // A saved team destination (`align join`) is a team env too: setup runs against it. Anything else that is
  // not a builtin is an error, from --env and from ALIGN_ENV alike, as in resolveEnv (join plan S6).
  const known = (v: string): boolean => (VALID_ENVS as readonly string[]).includes(v) || config.hasTeamDestination(v);
  if (opts.env !== undefined && !known(opts.env)) throw new InvalidEnvError(opts.env, config.listTeamDestinationNames());
  const ambient = processEnv['ALIGN_ENV'];
  if (opts.env === undefined && !opts.local && ambient && !known(ambient)) throw new InvalidEnvError(ambient, config.listTeamDestinationNames());

  // The team env this machine is logged in to: the default env first, then prod, then preview.
  const defaultEnv = config.getDefaultEnv();
  const order = [defaultEnv, 'prod', 'preview'].filter(isTeamEnv);
  const loggedInEnv = order.find((e) => Boolean(config.getEnvironment(e).authToken));

  if (opts.local || opts.env === 'local') {
    return loggedInEnv ? { kind: 'local', teamLoginUntouched: loggedInEnv } : { kind: 'local' };
  }
  if (opts.env !== undefined) return { kind: 'team', env: opts.env as EnvName };

  const fromEnvVar = processEnv['ALIGN_ENV'];
  if (fromEnvVar === 'local') return loggedInEnv ? { kind: 'local', teamLoginUntouched: loggedInEnv } : { kind: 'local' };
  if (fromEnvVar && fromEnvVar !== 'local') return { kind: 'team', env: fromEnvVar as EnvName };
  if (loggedInEnv) return { kind: 'team', env: loggedInEnv };
  return { kind: 'local' };
}
