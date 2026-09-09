import { ALIGN_HOSTED_GATEWAY_URL, type EnvironmentConfig, type TelemetryConsent } from './config.js';
import { telemetryDisabledByEnv } from './telemetry-env.js';
import { inHookContext } from './hook-context.js';
import pkg from '../../package.json' with { type: 'json' };

/**
 * ALI-403: emit one `cli.command` event per invocation so cloud CLI activation and weekly
 * retention are countable.
 *
 * Cloud mode is opt-out: a cloud user is already on an authenticated connection to our
 * gateway, so an event about a call already being made is not a new phone-home. Local-embedded
 * mode has two tiers (ALI-954, superseding the ALI-618 "nothing by default" for local mode):
 * - Two anonymous BEACONS send by default: `cli.funnel.install` (once, on the first ever run,
 *   see recordInstallBeacon) and `cli.funnel.setup_completed`. They exist so the funnel has a
 *   denominator - opt-in usage alone cannot tell a 10% consent rate from 90%.
 * - Everything else (`cli.command`, the other funnel stages) sends only with the stored
 *   consent (`config.ts`'s `getTelemetryConsent`, set by the one-time prompt at the end of
 *   setup, default No). `--local` users have no account and no tenant, so there is nothing
 *   to authenticate an event against - the consent is the gate.
 * Both modes send only a command name, never arguments or content. docs/telemetry.md lists
 * every event and field, and telemetry-docs-parity.test.ts keeps that page true.
 *
 * `ALIGN_TELEMETRY=0` and `DO_NOT_TRACK=1` (telemetry-env.ts) turn everything off, both tiers,
 * in both modes, over a granted local consent included (ALI-618 D3b - one consent model, not
 * two). `align telemetry off` stores 'off', which does the same thing without an env var.
 */
export const TELEMETRY_TIMEOUT_MS = 2_000;

function telemetryOptedOut(): boolean {
  return telemetryDisabledByEnv() !== undefined;
}

/**
 * POST with a hard timeout, and never throw - telemetry must never fail or delay a command. A
 * blackholing proxy hangs rather than rejecting, so a bare `fetch` would freeze the CLI after
 * its real work is done. The timer both aborts the request and wins the race, so we stop
 * waiting even if the transport ignores the signal. Shared by the cloud and local-embedded send
 * paths below, which were two copies of this exact race before extraction (fresh-context review).
 */
async function postWithTimeout(url: string, init: NonNullable<Parameters<typeof fetch>[1]>): Promise<void> {
  const controller = new AbortController();
  let giveUp: () => void = () => {};
  const abandoned = new Promise<void>((resolve) => {
    giveUp = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort();
    giveUp();
  }, TELEMETRY_TIMEOUT_MS);

  try {
    await Promise.race([fetch(url, { ...init, signal: controller.signal }), abandoned]);
  } catch {
    // Telemetry must never fail a command - see "resolves when the gateway rejects" and
    // "gives up rather than hanging" in usage-telemetry.test.ts / usage-telemetry-anonymous.test.ts.
  } finally {
    clearTimeout(timer);
  }
}

export interface TelemetryStatus {
  enabled: boolean;
  reason: string;
}

/**
 * ALI-618 D3b: what `align telemetry status` prints. Takes the consent decision as a plain
 * argument rather than reading `config.ts` itself, so the two consent MODELS stay visibly
 * distinct in one function a reader can hold in their head - cloud's opt-out default and
 * local's stored decision (ALI-954: three values, and the two default-on beacons named where
 * usage is off but they are not) - with the env switches as the thing that overrides both,
 * checked first.
 */
export function getTelemetryStatus(
  env: EnvironmentConfig,
  localConsent: TelemetryConsent | undefined,
): TelemetryStatus {
  const envSwitch = telemetryDisabledByEnv();
  if (envSwitch === 'DO_NOT_TRACK') {
    return { enabled: false, reason: 'off: DO_NOT_TRACK is set - nothing is sent' };
  }
  if (envSwitch === 'ALIGN_TELEMETRY') {
    return { enabled: false, reason: 'off: ALIGN_TELEMETRY is set to an opt-out value - nothing is sent' };
  }
  if (env.mode === 'local-embedded') {
    // ALI-954: "off" here is about usage. The two beacons still send unless the user ran
    // `align telemetry off` (stored 'off') - and the line has to say so, or "off" would be
    // read as "nothing is sent" over a beacon that still is.
    const beacons = ' - the two anonymous counts (install, setup completed) still send; `align telemetry off` stops those too';
    if (localConsent === 'granted') {
      return { enabled: true, reason: 'on: local mode, you opted in when asked' };
    }
    if (localConsent === 'declined') {
      return { enabled: false, reason: `off: local mode, you declined when asked${beacons}` };
    }
    if (localConsent === 'off') {
      return { enabled: false, reason: 'off: local mode, you ran `align telemetry off` - nothing is sent' };
    }
    return { enabled: false, reason: `off: local mode, you have not been asked yet${beacons}` };
  }
  return { enabled: true, reason: 'on: cloud mode, opt-out default' };
}

export async function recordCommandUsage(env: EnvironmentConfig, command: string): Promise<void> {
  if (telemetryOptedOut()) return;
  // `align local ...` is the explicitly-offline path. Its caller may still hold a cloud token
  // (the hook may resolve an env other than the one the command used), so the token check below
  // is not enough on its own.
  if (command === 'local' || command.startsWith('local ')) return;
  // The mode is the consent boundary (PR #77: cloud is opt-out; ALI-618: local usage sends
  // only with the stored consent decision - the ALI-954 beacons are the two named exceptions,
  // and this per-command ping is not one of them). It has to gate on its own because a token
  // can be in scope without cloud consent: ALIGN_TOKEN exported into the shell, or a
  // logged-in default env resolved by the caller.
  if (env.mode === 'local-embedded') {
    await recordAnonymousCommandUsage(command);
    return;
  }
  if (!env.authToken || !env.tenantId) return;

  await postWithTimeout(`${env.gatewayUrl}/telemetry/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.authToken}`,
      'x-tenant-id': env.tenantId,
    },
    body: JSON.stringify({
      eventName: 'cli.command',
      category: 'engagement',
      platform: 'cli',
      properties: { command },
    }),
  });
}

/**
 * ALI-618: the local-embedded sibling of the cloud send above. No Authorization, no tenant -
 * there is neither. Gated on a machine-local consent decision instead of a token, and the
 * payload carries exactly three fields (install id, command name, CLI version) so there is
 * nothing here for the gateway's strict schema to reject and nothing beyond what the consent
 * prompt promises. See usage-telemetry-anonymous.test.ts.
 *
 * Targets `ALIGN_HOSTED_GATEWAY_URL`, never a `gatewayUrl` off the env - local-embedded mode
 * makes no HTTP call for its own work (an embedded local DB client, see gateway-client.ts), so
 * the `local` env's `gatewayUrl` is a vestigial `demo`-mode default nothing real listens on.
 * A fresh-context review caught this: the original version sent every local ping to
 * `http://localhost:8080`, silently discarded, for every user who had not separately stood up
 * a local dev gateway.
 */
async function recordAnonymousCommandUsage(command: string): Promise<void> {
  const { createConfigStore } = await import('./config.js');
  const config = createConfigStore();
  if (config.getTelemetryConsent() !== 'granted') return;

  await postAnonymous({ installId: config.getInstallId(), command: commandPathOf(command), cliVersion: pkg.version });
}

/**
 * ALI-795: the command groups whose second word is a SUBCOMMAND, mirroring the gateway's
 * SUBCOMMAND_PARENTS (telemetryAnonymousRoutes.ts, align-stack#1990) - the two lists must
 * agree or pings silently 400. A query-taking command (ask, search, capture...) sends its
 * top-level word only, so a user's one-word query can never ride the command field.
 */
const SUBCOMMAND_PARENTS = new Set(['context', 'decisions', 'env', 'import', 'links', 'spaces', 'telemetry']);

/** "import git" stays whole (activation-by-source is the point); "ask <anything>" and
 *  every non-group command collapse to the top-level word. */
function commandPathOf(command: string): string {
  const [top, sub] = command.split(' ');
  if (top !== undefined && sub !== undefined && SUBCOMMAND_PARENTS.has(top)) return `${top} ${sub}`;
  return top ?? command;
}

/**
 * ALI-795: the activation-funnel stages, matching the gateway's closed enum
 * (telemetryAnonymousRoutes.ts). Repeat-use and D7 are deliberately absent - both derive
 * server-side from install_id timestamps, so a client event would be a second writer.
 *
 * ALI-938: `teammate_requested` is the bottom-up-thesis signal - fired by `align invite`
 * for every genuine attempt to bring a teammate in, whether or not the invite is
 * actually sent (a member blocked by the org_admin gate is still demand). `align invite`
 * refuses local-embedded mode outright (it needs a real cloud tenant to invite anyone
 * into), so in practice this ALWAYS reaches recordFunnelStage with a cloud env and takes
 * the /telemetry/ingest path, which accepts any eventName as a string. The gateway's
 * FUNNEL_STAGES enum lists it too since ALI-954, so the local path no longer 400s either.
 *
 * ALI-954: `install` is the once-per-install beacon and has its own emitter
 * (recordInstallBeacon) - it is not offered to recordFunnelStage, whose `command` argument
 * is a provenance the install beacon must not carry.
 */
export const FUNNEL_STAGES = [
  'setup_started',
  'setup_completed',
  'import_completed',
  'mcp_wired',
  'first_useful_decision',
  'teammate_requested',
  // ALI-835: the four session-import stages, emitted together by one `align import sessions`
  // run. They are the only stages that carry a measurement (a count and an agent name). The
  // gateway's own FUNNEL_STAGES must list these too or every ping 400s; that half shipped
  // first, deliberately (align-stack #2237, the ALI-790 lesson).
  'sessions_scanned',
  'candidates_found',
  'candidates_confirmed',
  'decisions_ratified',
] as const;

/**
 * ALI-835: the stages that carry a measurement, and the only ones the gateway accepts one on.
 * Session import is the first funnel event whose value IS a number - every earlier stage only
 * had to happen.
 */
export const SESSION_IMPORT_STAGES = [
  'sessions_scanned', 'candidates_found', 'candidates_confirmed', 'decisions_ratified',
] as const;

/**
 * What a session-import stage reports. A count and the agent's name, and nothing else - never a
 * repo, a path, a session id or a line of any transcript. The gateway refuses both fields on
 * every other stage.
 */
export interface FunnelMeasurement {
  count: number;
  agent: string;
}
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * ALI-954: the two stages that send BY DEFAULT in local mode, with no consent - the
 * denominator of the funnel. `install` goes through recordInstallBeacon; `setup_completed`
 * goes through recordFunnelStage like every other stage and is the one stage there that
 * does not read the consent decision. Adding a stage here is a documented promise changing:
 * docs/telemetry.md lists this set, and telemetry-docs-parity.test.ts checks it.
 */
export const BEACON_STAGES = ['install', 'setup_completed'] as const;

/**
 * The single funnel-stage emitter. Same consent model as recordCommandUsage, no new
 * consent surface: cloud is opt-out behind a token, local is behind the stored decision
 * except for the beacon tier (BEACON_STAGES), and the env switches beat everything.
 * `command` is the stage's provenance ("first_useful_decision via ask"), never arguments
 * or content.
 *
 * first_useful_decision is once-per-install, guarded HERE rather than at call sites so
 * there is exactly one enforcement point. Marked before the send, deliberately: a ping
 * lost to a timeout costs one funnel row in the undercount direction, while marking
 * after would re-send forever on a machine that cannot reach the gateway.
 *
 * Resolves `true` when a send was made (not necessarily delivered - see the once-mark
 * reasoning above, the same trade), `false` when this call could not send: opted out, no
 * consent, no token, the store threw, or - for first_useful_decision only, the one
 * once-per-install stage - already recorded on this install. ALI-949: the setup wizard
 * offers setup_started at several checkpoints because local-mode consent arrives
 * mid-wizard, and this is how it knows which offer landed (lib/setup-funnel.ts).
 */
export async function recordFunnelStage(
  env: EnvironmentConfig,
  stage: FunnelStage,
  command: string,
  measurement?: FunnelMeasurement,
): Promise<boolean> {
  // The whole body is guarded: telemetry must never fail or delay a command (the same
  // invariant postWithTimeout enforces for the network half, extended to the config
  // half). The concrete case: an emitter call site inside a command's try block plus a
  // config store missing a method turned a working `align ask` into exit(1) - 25 tests
  // in a file this change never touched said so (tdd.md's hand-built-fake rule).
  try {
    if (telemetryOptedOut()) return false;
    // ALI-835: never from inside an agent hook. A hook runs on the agent's clock, many times a
    // session, with nobody watching - so a ping from there would measure an editing loop rather
    // than a person choosing to do something, which is what every funnel stage means. Guarded
    // HERE for the same reason first_useful_decision's once-check is: one enforcement point
    // rather than one per call site.
    if (inHookContext()) return false;

    const { createConfigStore } = await import('./config.js');
    const config = createConfigStore();
    if (stage === 'first_useful_decision' && config.wasFunnelStageRecorded(stage)) return false;

    // Whether this call CAN send, checked before the once-mark (Copilot on #215):
    // marking an unsendable call permanently burned the stage for exactly the opt-in
    // cohort - a not-yet-consented user's first real answer marked the install, and
    // consenting later could never emit it. Mark only when a send follows, and still
    // BEFORE the network call so an unreachable gateway undercounts rather than
    // re-sending forever.
    const isLocal = env.mode === 'local-embedded';
    const canSend = isLocal
      ? localTierAllows(config.getTelemetryConsent(), stage)
      : Boolean(env.authToken && env.tenantId);
    if (!canSend) return false;
    if (stage === 'first_useful_decision') config.markFunnelStageRecorded(stage);

    const commandPath = commandPathOf(command);

    if (isLocal) {
      await postAnonymous({
        installId: config.getInstallId(),
        command: commandPath,
        cliVersion: pkg.version,
        stage,
        // ALI-835: only the session-import stages carry these, and the gateway's schema refuses
        // them on any other stage - so this spreads rather than setting undefined, because that
        // schema is `.strict()` and an explicit undefined key is still a key.
        ...(measurement ? { count: measurement.count, agent: measurement.agent } : {}),
      });
      return true;
    }

    await postWithTimeout(`${env.gatewayUrl}/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.authToken}`,
        'x-tenant-id': env.tenantId as string,
      },
      body: JSON.stringify({
        eventName: `cli.funnel.${stage}`,
        category: 'engagement',
        platform: 'cli',
        properties: { command: commandPath, ...(measurement ? { count: measurement.count, agent: measurement.agent } : {}) },
      }),
    });
    return true;
  } catch {
    // Swallowed for the reason above. The funnel loses one row; the command survives.
    return false;
  }
}

/**
 * ALI-954: whether a local-mode stage may send, given the stored decision. A beacon stage
 * sends unless the user ran `align telemetry off` (stored 'off'); every other stage needs
 * a granted consent. A prompt-declined consent ('declined') is a decision about USAGE and
 * leaves the beacons on - that split is the ticket's decision, and docs/telemetry.md says
 * it in the user's words.
 */
function localTierAllows(consent: TelemetryConsent | undefined, stage: FunnelStage | 'install'): boolean {
  if ((BEACON_STAGES as readonly string[]).includes(stage)) return consent !== 'off';
  return consent === 'granted';
}

/**
 * The anonymous payload, the one place its shape is spelled. Targets ALIGN_HOSTED_GATEWAY_URL,
 * never a `gatewayUrl` off the env - see recordAnonymousCommandUsage for why.
 */
async function postAnonymous(payload: Record<string, string | number>): Promise<void> {
  const target = process.env['ALIGN_GATEWAY_URL'] || ALIGN_HOSTED_GATEWAY_URL;
  await postWithTimeout(`${target}/telemetry/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * ALI-954: the install beacon - the funnel's denominator. Sent from the preAction hook in
 * index.ts, so it goes out BEFORE any prompt on the very first run of this install id, and
 * never again. The payload is the CLI version, the OS (`process.platform`, a closed enum the
 * gateway also constrains), the install id, and the literal command `align` - the endpoint
 * requires a command and this one must not carry which command was run first, so it sends
 * the program's own name, which carries no information. Nothing about the repo, the graph,
 * or the user.
 *
 * "First ever run" is a moment, not a state, so the install is marked recorded on that run
 * whether or not the beacon went out: `DO_NOT_TRACK=1` or `ALIGN_TELEMETRY=0` set before the
 * first run means it is NEVER sent, by construction, even if the variable is later unset.
 * That is the opposite trade from first_useful_decision's once-mark (which waits for
 * sendability so a later opt-in still emits), and it is deliberate: a beacon on the fifth
 * run would not be the install it claims to be, and "never" is the promise the docs make.
 *
 * Two cases do not consume the first run: `align telemetry ...` as the user's first command
 * (the off switch must not be raced by the thing it switches off), and a run that already
 * holds a cloud token (cloud mode is unchanged by this ticket - its funnel is the authed
 * one). Resolves true when a send was made, false otherwise; never throws, like every other
 * emitter here.
 */
export async function recordInstallBeacon(commandPath: string): Promise<boolean> {
  try {
    if (commandPath === 'telemetry' || commandPath.startsWith('telemetry ')) return false;
    const { createConfigStore } = await import('./config.js');
    const { resolveEnv } = await import('./resolve-env.js');
    const config = createConfigStore();
    if (config.wasFunnelStageRecorded('install')) return false;
    const env = config.getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
    if (env.authToken) return false;
    config.markFunnelStageRecorded('install');
    if (telemetryOptedOut()) return false;
    if (!localTierAllows(config.getTelemetryConsent(), 'install')) return false;

    await postAnonymous({
      installId: config.getInstallId(),
      command: 'align',
      cliVersion: pkg.version,
      stage: 'install',
      os: process.platform,
    });
    return true;
  } catch {
    // Telemetry must never fail or delay a command; the funnel loses one row.
    return false;
  }
}

/**
 * The command path the postAction hook reports: the full path ("local ask", "import git")
 * so recordCommandUsage can exclude the offline `local` group, and never the leaf alone.
 *
 * ALI-949: the ROOT command has no parent. Bare `align` (`program.action(runDefaultAction)`,
 * ALI-773) is the primary first-run path, and walking `.parent` from the root yielded '' -
 * so every bare invocation was reported as no command at all and the funnel's "activated"
 * stage could not see it. The root reports under the program's own name.
 */
export function invocationCommandPath(actionCommand: { name(): string; parent: unknown }): string {
  type Node = { name(): string; parent: Node | null };
  const parts: string[] = [];
  for (let c: Node | null = actionCommand as Node; c?.parent; c = c.parent) parts.unshift(c.name());
  return parts.length > 0 ? parts.join(' ') : actionCommand.name();
}

/**
 * The `--env` the user actually typed, including one Commander handed to a parent.
 *
 * `align import git --env local` leaves the subcommand's own `opts()` empty, because `--env`
 * is declared on both and Commander resolves that in the parent's favour (align-cli#79, which
 * fixed the same read for the import commands via subcommandOpts). Reading `.opts()` here
 * would send a local command's event to the cloud default - this slice's own bug, one layer up.
 */
export function envFlagOf(cmd: { optsWithGlobals(): Record<string, unknown> }): string | undefined {
  const opts = cmd.optsWithGlobals();
  const value = opts['env'];
  if (typeof value === 'string') return value;
  // `align setup --local` is how a user ENTERS local mode, and it is not spelled `--env local`,
  // so reading only `env` reported the one command whose whole purpose is going private. Checked
  // after `env` so an explicitly typed cloud env still wins.
  if (opts['local'] === true) return 'local';
  return undefined;
}

/**
 * Resolve the env the command actually addressed, then report against THAT.
 *
 * The postAction hook used to hand over `getEnvironment(getDefaultEnv())`, and
 * `align setup --local` deliberately leaves the default env alone (local-mode.ts), so a
 * machine that had ever run `align login` reported every `ask --env local` to the cloud -
 * the one thing PR #77 said local mode does not do. Only the three-member `local` command
 * group was excluded, and no local user types `align local ask`.
 *
 * `preferLocalEmbedded` IS now passed (ALI-618) - this paragraph used to say it was
 * deliberately withheld, on the reasoning that the flag/ALIGN_ENV the user explicitly chose is
 * what a CLOUD consent decision may rest on. That reasoning never covered local telemetry: the
 * redirect only ever fires when the cloud env has no token, which is exactly the case
 * recordCommandUsage's cloud branch already drops on its own (`if (!env.authToken || ...)
 * return`) - so passing it here cannot cause an extra cloud send, only let a genuinely
 * never-logged-in user's BARE command reach the local-embedded branch at all. Without it, that
 * exact audience - "never met Tom" - resolved to the tokenless cloud default on every bare
 * command and recordCommandUsage silently dropped it: neither cloud nor local ever counted
 * them, which defeated the whole point of adding local telemetry. A fresh-context review
 * caught this too. Fixed in `usage-telemetry-invocation-local-only.test.ts`.
 *
 * `setup` is suppressed once local-embedded is configured. The interactive "Local only" choice
 * sets no flag, and the default env stays cloud on purpose, so the only evidence the session was
 * local is what the run left behind - and a `setup` that ends with the machine in local mode is
 * a local session. It costs one activation count on a once-per-machine command, in the direction
 * that cannot leak.
 */
export async function recordInvocationUsage(
  envFlag: string | undefined,
  command: string,
): Promise<void> {
  const { createConfigStore } = await import('./config.js');
  const { resolveEnv } = await import('./resolve-env.js');
  const config = createConfigStore();
  if (command === 'setup' && config.getEnvironment('local').mode === 'local-embedded') return;
  await recordCommandUsage(config.getEnvironment(resolveEnv(envFlag, { preferLocalEmbedded: true })), command);
}
