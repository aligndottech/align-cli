import { createConfigStore, type EnvName } from './config.js';

const VALID_ENVS: EnvName[] = ['local', 'preview', 'prod'];

export function resolveEnv(flagValue?: string): EnvName {
  if (flagValue && VALID_ENVS.includes(flagValue as EnvName)) {
    return flagValue as EnvName;
  }
  const fromEnvVar = process.env['ALIGN_ENV'];
  if (fromEnvVar && VALID_ENVS.includes(fromEnvVar as EnvName)) {
    return fromEnvVar as EnvName;
  }
  return createConfigStore().getDefaultEnv();
}
