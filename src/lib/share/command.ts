/**
 * L9: `align share` as a function of injected dependencies, returning an exit code. The commander
 * wrapper (commands/share.ts) wires the real config, gateway client and prompts; tests wire fakes.
 *
 * Who may complete a share: a person. The normal path needs a TTY on stdin and a "yes" (default No),
 * or `--yes`. `--confirm <code>` finishes a share an agent previewed and needs a CONTROLLING terminal
 * (`/dev/tty`), which an agent's shell tool does not have; `--yes` is refused with it. The known gap
 * (an agent that allocates its own pseudo-terminal) is stated in SECURITY.md.
 */
import { type EnvironmentConfig } from '../config.js';
import { teamCtaLine } from '../team-cta.js';
import { combinedHash, consumeCode, lookupCode } from './pending.js';
import { prepare, type Prepared, ratifiedRows, renderResults, retract, secretRefusal, send, type ShareClient, ShareError } from './run.js';
import type { Judge } from '../curation/judgements-db.js';

export interface ShareOptions {
  ids: string[];
  allRatified?: boolean;
  /** An already-parsed lower bound (ISO), for --since. */
  sinceIso?: string;
  yes?: boolean;
  confirm?: string;
  retract?: string;
  envName: string;
}

export interface ShareDeps {
  cloudEnv: EnvironmentConfig;
  localDbPath: string | null;
  client: () => ShareClient;
  judge: () => Promise<Judge>;
  /** The person's own git identity: `--all-ratified` shares only what they ratified. */
  owner: () => Promise<string>;
  stdinIsTty: boolean;
  /** Ask on the controlling terminal; null when there is none. */
  ttyConfirm: (question: string) => Promise<boolean | null>;
  /** Ask on stdin (only reached when stdinIsTty). */
  ask: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function runShare(opts: ShareOptions, deps: ShareDeps): Promise<number> {
  const { out, err } = deps;
  if (opts.confirm !== undefined && opts.yes) {
    err('--yes cannot be combined with --confirm: the confirmation is the person\'s own answer.');
    return 2;
  }
  if (deps.cloudEnv.mode === 'local-embedded' || (!deps.cloudEnv.authToken && deps.cloudEnv.mode !== 'demo')) {
    err(`align share sends decisions from your local graph to your team's.\n  ${teamCtaLine()}\n  Already have a team? Run: align login`);
    return 1;
  }
  if (!deps.localDbPath) {
    err('There is no local graph on this machine to share from. `align setup --local` creates one.');
    return 1;
  }
  const dbPath = deps.localDbPath;
  const ctx = async () => ({ dbPath, envName: opts.envName, client: deps.client(), judge: await deps.judge() });

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
    for (const a of prep.already) out(`Already shared as ${a.remoteId}: ${a.title}`);
    if (prep.payloads.length === 0) return 0;

    if (pendingCode !== undefined) {
      const found = lookupCode(pendingCode);
      if (!found.ok) { err('That confirmation code is no longer valid. Nothing was sent.'); return 1; }
      if (found.pending.hash !== combinedHash(prep.payloads)) {
        err('What would be shared has changed since your agent previewed it (a decision, a judgement or the destination). Nothing was sent. Ask your agent to start again.');
        return 1;
      }
      out(prep.preview);
      const yes = await deps.ttyConfirm(`Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${prep.dest.workspace}?`);
      if (yes === null) { err('Confirm this in your own terminal: there is no controlling terminal here. Nothing was sent.'); return 1; }
      if (!yes) { out('Nothing was sent.'); return 0; }
      if (!consumeCode(pendingCode)) { err('That code was already used. Nothing was sent.'); return 1; }
    } else if (opts.yes) {
      out(prep.preview);
    } else if (!deps.stdinIsTty) {
      err(prep.preview);
      err('\nNot a terminal and no --yes, so nothing was sent. Run this in your own terminal, or add --yes.');
      return 1;
    } else {
      out(prep.preview);
      if (!(await deps.ask(`Share ${prep.payloads.length} decision${prep.payloads.length === 1 ? '' : 's'} with ${prep.dest.workspace}?`))) { out('Nothing was sent.'); return 0; }
    }

    const interactive = pendingCode !== undefined || (deps.stdinIsTty && !opts.yes);
    const results = await send(c, prep, {
      confirmTeamText: async (i) => {
        if (!interactive) return false;
        out(`\n"${i.title}" is already on your team graph, as:\n  ${i.teamTitle}\n  ${i.teamSummary}\nYour ratification would put your name on THAT text, not on yours.`);
        const q = 'Do you stand behind the team\'s text?';
        return pendingCode !== undefined ? (await deps.ttyConfirm(q)) === true : deps.ask(q);
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
