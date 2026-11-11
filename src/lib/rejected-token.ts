import { tokenEnvName } from './token-env.js';

/**
 * A SAVED token the provider rejected: forget it, so the source stops reading as connected, and say what happened.
 * Returns the sentence that follows "its saved token was rejected". It never claims a forget that did not happen:
 * a token from ALIGN_<SOURCE>_TOKEN is not Align's to remove, and a keychain that could not delete it still holds it.
 */
export function dropRejectedToken(
  config: {
    forgetConnector(env: 'local', source: string): { keychainFailed: boolean };
    tokenStoreStatus(): { label: string };
  },
  source: string,
): string {
  const variable = tokenEnvName(source);
  if (process.env[variable]) return `That token comes from ${variable}, so Align cannot forget it. Unset the variable or set a fresh token in it.`;
  const { keychainFailed } = config.forgetConnector('local', source);
  if (keychainFailed) {
    return `Align could not remove it from ${config.tokenStoreStatus().label}: delete the "align-cli" entry for ${source} there, then run setup again to paste a fresh one.`;
  }
  return 'Token forgotten; run setup again to paste a fresh one.';
}
