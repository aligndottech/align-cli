/**
 * L9: `align share` as a function of injected dependencies, returning an exit code. The commander
 * wrapper (commands/share.ts) wires the real config, gateway client and prompts; tests wire fakes.
 *
 * Who may complete a share: a person at a terminal. EVERY path (a plain `align share` and
 * `align share --confirm <code>`) shows the preview on the CONTROLLING terminal and needs a typed
 * yes there (default No). There is no `--yes`: a flag is exactly what an agent would pass. A caller
 * with no controlling terminal is refused. The known gap (an agent that allocates its own
 * pseudo-terminal) is stated in SECURITY.md.
 */
import { visible } from './visible.js';
import { type EnvironmentConfig } from '../config.js';
import { teamCtaLine } from '../team-cta.js';
import { combinedHash, consumeCode, lookupCode } from './pending.js';
import { prepare, type Prepared, ratifiedRows, renderResults, renderTeamText, retract, secretRefusal, send, type ShareClient, ShareError } from './run.js';
import type { Judge } from '../curation/judgements-db.js';

export interface ShareOptions {
  ids: string[];
  allRatified?: boolean;
  /** An already-parsed lower bound (ISO), for --since. */
  sinceIso?: string;
  confirm?: string;
  retract?: string;
  envName: string;
}

export interface ShareDeps {
  cloudEnv: EnvironmentConfig;
  /** This install's salt for the opaque client_key. */
  salt: string;
  /** The environment's default gateway URL: anything else is shown in the preview. */
  defaultGatewayUrl: string;
  localDbPath: string | null;
  client: () => ShareClient;
  judge: () => Promise<Judge>;
  /** The person's own git identity: `--all-ratified` shares only what they ratified. */
  owner: () => Promise<string>;
  /** Show `shown` and ask on the controlling terminal; null when there is no interactive terminal. */
  ttyConfirm: (shown: string, question: string) => Promise<boolean | null>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const NO_TERMINAL = 'Confirm this in your own terminal: there is no interactive terminal here (an agent shell, a pipe and a hook have none). Nothing was sent.';

export async function runShare(opts: ShareOptions, deps: ShareDeps): Promise<number> {
  const { out, err } = deps;
  if (deps.cloudEnv.mode === 'demo') {
    err('align share needs a team account, and this environment is in demo mode. Run: align login');
    return 1;
  }
  if (deps.cloudEnv.mode === 'local-embedded' || !deps.cloudEnv.authToken) {
    err(`align share sends decisions from your local graph to your team's.\n  ${teamCtaLine()}\n  Already have a team? Run: align login`);
    return 1;
  }
  if (!deps.localDbPath) {
    err('There is no local graph on this machine to share from. `align setup --local` creates one.');
    return 1;
  }
  const dbPath = deps.localDbPath;
  const ctx = async () => ({ dbPath, envName: opts.envName, client: deps.client(), judge: await deps.judge(), salt: deps.salt, gatewayUrl: deps.cloudEnv.gatewayUrl, defaultGatewayUrl: deps.defaultGatewayUrl });

  try {
    if (opts.retract !== undefined) {
      const r = await retract(await ctx(), opts.retract);
      (r.ok ? out : err)(r.message);
      return r.ok ? 0 : 1;
    }

    let ids = opts.ids;
    let pendingCode: string | undefined;
    if (opts.confirm !== undefined) {
      const found = lookupCode(opts.confirm);
      if (!found.ok) {
        err(found.reason === 'expired' ? 'That confirmation code has expired. Ask your agent to start the share again.' : 'That confirmation code is not valid (unknown, malformed or already used). Nothing was sent.');
        return 1;
      }
      if (found.pending.envName !== opts.envName) {
        err(`That code was issued for ${found.pending.envName}, not ${opts.envName}. Nothing was sent.`);
        return 1;
      }
      ids = found.pending.localIds;
      pendingCode = opts.confirm;
    } else if (ids.length === 0) {
      if (!opts.allRatified && opts.sinceIso === undefined) {
        err('Name what to share: align share <id> [<id>...], or --all-ratified, or --since <30d|2w|6m>.');
        return 2;
      }
      ids = ratifiedRows(dbPath, { owner: await deps.owner(), sinceIso: opts.sinceIso }).map((r) => r.id);
      if (ids.length === 0) { out('Nothing to share: you have no ratified decisions in that range.'); return 0; }
    }

    const c = await ctx();
    const prep: Prepared = await prepare(c, ids);
    if (prep.secrets.length) { err(secretRefusal(prep.secrets)); return 1; }
    for (const a of prep.already) out(`Already shared as ${visible(a.remoteId)}: ${visible(a.title)}`);
    if (prep.payloads.length === 0) return 0;

    if (pendingCode !== undefined) {
      const found = lookupCode(pendingCode);
      if (!found.ok) { err('That confirmation code is no longer valid. Nothing was sent.'); return 1; }
      if (found.pending.hash !== combinedHash(prep.payloads, prep)) {
        err('What would be shared, or where it would go (the workspace or the gateway), has changed since your agent previewed it. Nothing was sent. Ask your agent to start again.');
        return 1;
      }
      const yes = await deps.ttyConfirm(prep.preview, `Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${visible(prep.dest.workspace)}?`);
      if (yes === null) { err(NO_TERMINAL); return 1; }
      if (!yes) { out('Nothing was sent.'); return 0; }
      if (!consumeCode(pendingCode)) { err('That code was already used. Nothing was sent.'); return 1; }
    } else {
      const yes = await deps.ttyConfirm(prep.preview, `Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${visible(prep.dest.workspace)}?`);
      if (yes === null) { err(NO_TERMINAL); return 1; }
      if (!yes) { out('Nothing was sent.'); return 0; }
    }

    const results = await send(c, prep, {
      confirmTeamText: async (i) => {
        const shown = `"${visible(i.title)}" is already on your team graph, as:\n${renderTeamText(i.team)}\nYour ratification would put your name on THAT text, not on yours.`;
        return (await deps.ttyConfirm(shown, 'Do you stand behind the team\'s text?')) === true;
      },
    });
    out(`\n${renderResults(results)}`);
    const failed = results.some((r) => r.outcome.kind === 'refused' || r.outcome.kind === 'unknown');
    return failed ? 1 : 0;
  } catch (e) {
    if (e instanceof ShareError) { err(e.message); return e.exitCode; }
    err((e as Error).message);
    return 1;
  }
}
