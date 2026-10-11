/**
 * The name a person gives a team destination (`align join` saves one). It becomes a config key,
 * a `--env` value, a `<name>:<connector>` token key and, later, text pasted into a shell, so
 * the rules are strict and live in one place.
 *
 * ':' is rejected on purpose: connector tokens are stored as `<env>:<key>`, so a name carrying a
 * colon could collide with a builtin's keys (`prod:slack`). The reserved set keeps a team from
 * shadowing a builtin or a word the CLI already gives a meaning.
 */
export const RESERVED = new Set(['local', 'preview', 'prod', 'default', 'all', 'none', 'team', 'align', 'demo']);

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** A destination name that has passed `validateDestinationName`. Only `asDestinationName` makes one. */
export type TeamDestinationName = string & { readonly __teamDestinationName: unique symbol };

/** null when the name is usable, otherwise a sentence saying why not. */
export function validateDestinationName(n: string): string | null {
  // /$/ without the u/s flags still lets a trailing "\n" through, so test the whole string with \z semantics.
  if (!NAME_RE.test(n) || n.includes('\n')) return 'use 2-32 lowercase letters, digits or hyphens, starting with a letter';
  if (RESERVED.has(n)) return `"${n}" is reserved`;
  return null;
}

/**
 * ` --env <name>` for a command line a person will paste, or '' for prod (the default, left off to keep
 * the line portable). Refuses any name that is neither a builtin nor a valid destination name: this is
 * the one place a name becomes shell text, so it is checked here and not trusted from the config file.
 */
export function envFlag(name: string): string {
  if (name === 'prod') return '';
  if (name === 'preview' || name === 'local' || validateDestinationName(name) === null) return ` --env ${name}`;
  throw new Error(`"${name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}" is not a safe environment name`);
}

export function asDestinationName(n: string): TeamDestinationName {
  const problem = validateDestinationName(n);
  if (problem) throw new Error(`Invalid destination name "${n.slice(0, 40)}": ${problem}`);
  return n as TeamDestinationName;
}
