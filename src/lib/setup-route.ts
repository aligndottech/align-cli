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
  | { kind: 'team'; env: 'prod' | 'preview' };

export class InvalidEnvError extends Error {
  constructor(value: string) {
    super(`Unknown environment "${value}". Valid environments: ${VALID_ENVS.join(', ')}.`);
    this.name = 'InvalidEnvError';
  }
}

const isTeamEnv = (v: string | undefined): v is 'prod' | 'preview' => v === 'prod' || v === 'preview';

export function routeSetup(
  opts: { env?: string; local?: boolean },
  config: { getEnvironment(env: EnvName): EnvironmentConfig; getDefaultEnv(): EnvName },
  processEnv: Record<string, string | undefined>,
): SetupRoute {
  if (opts.env !== undefined && !VALID_ENVS.includes(opts.env as EnvName)) throw new InvalidEnvError(opts.env);

  // The team env this machine is logged in to: the default env first, then prod, then preview.
  const defaultEnv = config.getDefaultEnv();
  const order = [defaultEnv, 'prod', 'preview'].filter(isTeamEnv);
  const loggedInEnv = order.find((e) => Boolean(config.getEnvironment(e).authToken));

  if (opts.local || opts.env === 'local') {
    return loggedInEnv ? { kind: 'local', teamLoginUntouched: loggedInEnv } : { kind: 'local' };
  }
  if (isTeamEnv(opts.env)) return { kind: 'team', env: opts.env };

  const fromEnvVar = processEnv['ALIGN_ENV'];
  if (fromEnvVar === 'local') return loggedInEnv ? { kind: 'local', teamLoginUntouched: loggedInEnv } : { kind: 'local' };
  if (isTeamEnv(fromEnvVar)) return { kind: 'team', env: fromEnvVar };
  if (loggedInEnv) return { kind: 'team', env: loggedInEnv };
  return { kind: 'local' };
}
