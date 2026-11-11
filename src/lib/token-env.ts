/**
 * Credentials a person supplies through the environment, for a password manager to fill:
 *
 *   op run --env-file=align.env -- align connect --source github
 *
 * One variable per source token, `ALIGN_<SOURCE>_TOKEN` (ALIGN_GITHUB_TOKEN, ALIGN_JIRA_TOKEN...),
 * plus `ALIGN_<SOURCE>_<FIELD>` for the few connectors that ask for more than a token. The
 * extra-field table below must name every `extraFields` key in setup.ts; a test pins that.
 *
 * They apply to local mode only, where a person pastes their own read-only tokens. The cloud
 * connectors sign in with OAuth and have no such variable. An empty variable counts as unset,
 * which is what a password-manager template with no value filled in produces.
 *
 * A value from here is a read-through: config.ts never writes it to the keychain or the file.
 */

/** Non-secret extra fields per source, as setup.ts's `extraFields` names them. */
export const ENV_FIELDS: Readonly<Record<string, readonly string[]>> = {
  jira: ['email', 'domain'],
  confluence: ['email', 'domain'],
  gitlab: ['domain'],
};

export const tokenEnvName = (source: string): string => `ALIGN_${source.toUpperCase()}_TOKEN`;
export const fieldEnvName = (source: string, field: string): string => `ALIGN_${source.toUpperCase()}_${field.toUpperCase()}`;

const present = (v: string | undefined): v is string => v !== undefined && v !== '';

/** The token and any extra fields set in the environment for a source, or null when no token is. */
export function envCredentials(source: string, env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> | null {
  const token = env[tokenEnvName(source)];
  if (!present(token)) return null;
  const fields: Record<string, string> = { token };
  for (const f of ENV_FIELDS[source] ?? []) {
    const v = env[fieldEnvName(source, f)];
    if (present(v)) fields[f] = v;
  }
  return fields;
}
