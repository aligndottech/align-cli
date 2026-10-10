/**
 * Where a share goes, decided in one place for `align share` and the MCP `align_share` tool.
 *
 * Precedence: `--to` > the saved share destination > the existing environment logic. Once a team
 * destination is the share destination, an ambient `--env prod` (or an exported ALIGN_ENV) must
 * not quietly send the share to a different server: moving it takes an explicit `--to`.
 */
import { assertTransport, TransportError } from '../destination-trust.js';
import type { createConfigStore, EnvName } from '../config.js';
import { acceptEnvName, resolveEnv } from '../resolve-env.js';

export class ShareTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareTargetError';
  }
}

type ConfigStore = ReturnType<typeof createConfigStore>;

const shareable = (name: EnvName): EnvName => {
  if (name === 'local') throw new ShareTargetError('The local graph is where shares come from, not where they go. Use --to prod, --to preview or a team destination. Nothing was sent.');
  return name;
};

/**
 * Who is asking. A team destination the person has NOT made their share destination must be named by a person at a terminal:
 * answering no at the join prompt has to be a boundary an agent cannot step over with `--to <name>`.
 */
export interface ShareCaller { wrapped: boolean; tty: boolean }

export function resolveShareEnv(opts: { to?: string; env?: string }, config: ConfigStore, caller: ShareCaller = { wrapped: false, tty: true }): EnvName {
  const named = resolveNamed(opts, config);
  if (named !== null && config.hasTeamDestination(named) && named !== config.getShareDestination() && (caller.wrapped || !caller.tty)) {
    throw new ShareTargetError(`${named} is not your share destination, so sharing to it needs you at a terminal of your own, not an agent or a script. Nothing was sent.`);
  }
  return named ?? defaultTarget(config);
}

function defaultTarget(config: ConfigStore): EnvName {
  const dest = config.getShareDestination();
  return dest !== null ? (dest as EnvName) : resolveEnv(undefined, { config });
}

function resolveNamed(opts: { to?: string; env?: string }, config: ConfigStore): EnvName | null {
  const dest = config.getShareDestination();
  if (opts.to !== undefined) {
    const to = acceptEnvName(opts.to, config);
    if (opts.env !== undefined && acceptEnvName(opts.env, config) !== to) {
      throw new ShareTargetError(`--to ${to} and --env ${opts.env.slice(0, 40)} name different destinations, and a share goes to one destination. Nothing was sent.`);
    }
    return shareable(to);
  }
  if (opts.env !== undefined) {
    const env = shareable(acceptEnvName(opts.env, config));
    if (dest !== null && env !== dest) {
      throw new ShareTargetError(`Your share destination is ${dest}. To share to ${env} instead, pass --to ${env}. Nothing was sent.`);
    }
    return env;
  }
  return null;
}

export type AppUrlChoice = { ok: true; appUrl: string } | { ok: false; message: string };

const origin = (raw: string): string | null => {
  try { return assertTransport(raw); } catch (e) { if (e instanceof TransportError) return null; throw e; }
};

/**
 * The web app an approval link opens on. A team destination uses the address saved at join time:
 * the approval page receives the share's key in the link's fragment, so a gateway that later names
 * a different app must stop the share, not redirect it. A builtin takes the gateway's own
 * `app_url` when it gives one and the old guess only when it does not; an `app_url` it gives that
 * is unusable is an error, never a reason to guess.
 */
export function resolveApprovalAppUrl(i: { stored: string | null; cfgAppUrl: string | null; guessed: string }): AppUrlChoice {
  const cfg = i.cfgAppUrl === null ? null : origin(i.cfgAppUrl);
  if (i.cfgAppUrl !== null && cfg === null) {
    return { ok: false, message: 'The gateway reports a web app address that is not acceptable (it must be https, or http for localhost, with no path). Nothing was sent.' };
  }
  if (i.stored !== null) {
    if (cfg !== null && cfg !== i.stored.replace(/\/+$/, '')) {
      return { ok: false, message: `The web app this destination was joined with is ${i.stored}, but its gateway now says ${cfg}. The approval link carries the share's key, so nothing was sent. Run align join again if the team moved.` };
    }
    return { ok: true, appUrl: i.stored.replace(/\/+$/, '') };
  }
  return { ok: true, appUrl: cfg ?? i.guessed };
}
