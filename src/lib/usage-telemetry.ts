import { ALIGN_HOSTED_GATEWAY_URL, type EnvironmentConfig, type TelemetryConsent } from './config.js';
import { telemetryDisabledByEnv } from './telemetry-env.js';
import { inHookContext, markHookContext } from './hook-context.js';
import { inCi } from './telemetry-ci.js';
import { maybeShowTelemetryNotice } from './telemetry-consent.js';
import pkg from '../../package.json' with { type: 'json' };

/**
 * ALI-403: emit one `cli.command` event per invocation so cloud CLI activation and weekly
 * retention are countable.
 *
 * Cloud mode is opt-out: a cloud user is already on an authenticated connection to our
 * gateway, so an event about a call already being made is not a new phone-home. Local-embedded
 * mode is opt-out too since C6, disclosed by a one-time notice (telemetry-consent.ts) that cli.ts
 * prints to stderr before the first send - nothing local sends until it has printed
 * (localTierAllows). An install that answered No to the pre-C6 setup question ('declined')
 * keeps that answer for usage; the two ALI-954 beacons (install, setup_completed) still send
 * for it, as they did. `--local` users have no account and no tenant, so there is nothing to
 * authenticate an event against - the notice, and the stored decision, are the gate.
 * Both modes send only a command name, never arguments or content. docs/telemetry.md lists
 * every event and field, and telemetry-docs-parity.test.ts keeps that page true.
 *
 * `ALIGN_TELEMETRY=0` and `DO_NOT_TRACK=1` (telemetry-env.ts), and running in CI
 * (telemetry-ci.ts, C6), turn everything off, both tiers, in both modes, over a granted local
 * consent included (ALI-618 D3b - one consent model, not two). `align telemetry off` stores 'off', which does the same thing without an env var.
 */
export const TELEMETRY_TIMEOUT_MS = 2_000;

function telemetryOptedOut(): boolean {
  return telemetryDisabledByEnv() !== undefined || inCi();
}

/**
 * THE one predicate for "a stored answer forbids sending anything", read by every send path:
 * local usage, local stages and beacons (localTierAllows), the install beacon's first-run
 * consumption, cloud cli.command and cloud funnel stages, and `align telemetry status`.
 * 'off' is `align telemetry off`; 'declined' is a No to the pre-C6 setup question. The privacy
 * page promises "if you turned telemetry off earlier, it stays off", with no mode attached, so
 * both stop everything in both modes (review of e794c6e, then the coordinator's call that a
 * declined cloud user is off too).
 */
export function storedAnswerForbidsSending(consent: TelemetryConsent | undefined): boolean {
  return consent === 'off' || consent === 'declined';
}

/** The predicate above, read from the store. A store that cannot be read forbids - the direction
 *  that sends nothing. */
async function storedAnswerForbidsSendingNow(): Promise<boolean> {
  try {
    const { createConfigStore } = await import('./config.js');
    return storedAnswerForbidsSending(createConfigStore().getTelemetryConsent());
  } catch {
    return true;
  }
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

/**
 * The hard cap on the one send that is awaited: the first-run install beacon. Once per install,
 * so ordinary runs never pay it.
 */
export const INSTALL_BEACON_CAP_MS = 800;

/**
 * POST and report whether it was DELIVERED - any HTTP response counts, since the gateway
 * received it; a refused connection, a network error or the cap does not. Never throws, never
 * prints, and never takes longer than `capMs`: the abort signal ends the request, and the timer
 * wins the race even if a transport ignores the signal.
 */
async function postDelivered(url: string, init: NonNullable<Parameters<typeof fetch>[1]>, capMs: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, capMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }).then(() => true, () => false),
      capped,
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface TelemetryStatus {
  enabled: boolean;
  reason: string;
}

/**
 * ALI-618 D3b: what `align telemetry status` prints. Takes the consent decision and whether the
 * C6 notice has printed as plain arguments rather than reading `config.ts` itself, so the
 * model stays visible in one function a reader can hold in their head - cloud's opt-out
 * default, and local's stored decision or the notice (ALI-954: the two default-on beacons named
 * where usage is off but they are not) - with the env switches and CI overriding both, checked
 * first.
 */
export function getTelemetryStatus(
  env: EnvironmentConfig,
  localConsent: TelemetryConsent | undefined,
  noticeShown = false,
): TelemetryStatus {
  const envSwitch = telemetryDisabledByEnv();
  if (envSwitch === 'DO_NOT_TRACK') {
    return { enabled: false, reason: 'off: DO_NOT_TRACK is set - nothing is sent' };
  }
  if (envSwitch === 'ALIGN_TELEMETRY') {
    return { enabled: false, reason: 'off: ALIGN_TELEMETRY is set to an opt-out value - nothing is sent' };
  }
  if (inCi()) {
    return { enabled: false, reason: 'off: running in CI - nothing is sent' };
  }
  if (env.mode !== 'local-embedded' && storedAnswerForbidsSending(localConsent)) {
    const why = localConsent === 'declined' ? 'you declined when asked' : 'you ran `align telemetry off`';
    return { enabled: false, reason: `off: ${why} - nothing is sent, cloud events included` };
  }
  if (env.mode === 'local-embedded') {
    if (localConsent === 'granted') {
      return { enabled: true, reason: 'on: local mode, you opted in' };
    }
    if (localConsent === 'declined') {
      // A No to the old setup question is off, beacons included (review of e794c6e).
      return { enabled: false, reason: 'off: local mode, you declined when asked - nothing is sent' };
    }
    if (localConsent === 'off') {
      return { enabled: false, reason: 'off: local mode, you ran `align telemetry off` - nothing is sent' };
    }
    // C6: opt-out, disclosed by the one-time notice. Nothing sends before it has printed.
    if (noticeShown) {
      return { enabled: true, reason: 'on: local mode, opt-out (the one-time notice explained it) - `align telemetry off` stops it' };
    }
    return { enabled: false, reason: 'off: local mode, nothing has been sent yet - a one-time notice prints before the first send' };
  }
  return { enabled: true, reason: 'on: cloud mode, opt-out default' };
}

export async function recordCommandUsage(env: EnvironmentConfig, command: string): Promise<void> {
  if (telemetryOptedOut()) return;
  // C6: an agent hook runs on the agent's clock, many times a session, with nobody watching -
  // a usage ping from there counts an editing loop, not a person running a command.
  if (inHookContext()) return;
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
  if (await storedAnswerForbidsSendingNow()) return;

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
 * there is neither. Gated on the C6 notice and the machine-local decision instead of a token,
 * and the payload carries exactly three fields (install id, command name, CLI version) so there
 * is nothing here for the gateway's strict schema to reject and nothing beyond what the notice
 * promises. See usage-telemetry-anonymous.test.ts.
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
  if (!localTierAllows(config.getTelemetryConsent(), 'command', noticeShownOn(config))) return;

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
/**
 * ALI-835: the stages the gateway ACCEPTS a measurement on. Permission, not obligation - three
 * of the four come from one `align connect sessions` run and carry a count and an agent name,
 * while `decisions_ratified` comes from `align ratify` and deliberately carries neither, since
 * a ratification is a person standing behind a claim rather than anything an agent counted.
 *
 * Session import is the first funnel event whose value IS a number; every earlier stage only
 * had to happen.
 *
 * Declared above FUNNEL_STAGES and spread into it rather than listed in both, so the four
 * strings have one writer here as they now do on the gateway side (align-stack #2237).
 */
export const SESSION_IMPORT_STAGES = [
  'sessions_scanned', 'candidates_found', 'candidates_confirmed', 'decisions_ratified',
] as const;

export const FUNNEL_STAGES = [
  'setup_started',
  'setup_completed',
  'import_completed',
  'mcp_wired',
  'first_useful_decision',
  'teammate_requested',
  // The gateway's own FUNNEL_STAGES must list these too or every ping 400s; that half
  // shipped first, deliberately (align-stack #2237, the ALI-790 lesson).
  ...SESSION_IMPORT_STAGES,
  // C1: bare `align` handed the terminal to a coding agent. Carries the agent name only.
  'agent_launched',
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
/** What `agent_launched` reports: the agent's name, and nothing else (no count). */
export interface AgentMeasurement {
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
  measurement?: FunnelMeasurement | AgentMeasurement,
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
      ? localTierAllows(config.getTelemetryConsent(), stage, noticeShownOn(config))
      : Boolean(env.authToken && env.tenantId) && !storedAnswerForbidsSending(config.getTelemetryConsent());
    if (!canSend) return false;
    if (stage === 'first_useful_decision') config.markFunnelStageRecorded(stage);

    const commandPath = commandPathOf(command);

    // ALI-835 (Copilot on #286): the measurement is admitted only on the stages the gateway
    // permits it on. Gated HERE rather than at the two payload sites below, for the same
    // reason first_useful_decision's once-check is: one enforcement point. The gateway's
    // schema is `.strict()` with a superRefine refusing `count` and `agent` on every other
    // stage, so a future call site passing a measurement alongside, say, `mcp_wired` would
    // 400 the whole ping - and the catch below swallows that, so the stage would go silently
    // missing rather than fail loudly. Dropping the two fields keeps the stage itself.
    const measured: Record<string, string | number> =
      measurement && 'count' in measurement && (SESSION_IMPORT_STAGES as readonly string[]).includes(stage)
        ? { count: measurement.count, agent: measurement.agent }
        : measurement && stage === 'agent_launched'
          ? { agent: measurement.agent }
          : {};

    if (isLocal) {
      await postAnonymous({
        installId: config.getInstallId(),
        command: commandPath,
        cliVersion: pkg.version,
        stage,
        // Spread rather than set: the gateway's schema is `.strict()`, and an explicit
        // undefined key is still a key.
        ...measured,
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
        properties: { command: commandPath, ...measured },
      }),
    });
    return true;
  } catch {
    // Swallowed for the reason above. The funnel loses one row; the command survives.
    return false;
  }
}

/**
 * Whether a local-mode event may send, given the stored decision and whether the one-time
 * notice has printed (C6). Local mode is opt-out since C6, and the notice is the disclosure:
 * - stored 'off' (`align telemetry off`) stops everything, and so does 'declined' (a No to the
 *   pre-C6 setup question): the privacy page promises "if you turned telemetry off earlier, it
 *   stays off", so a stored No stops the beacons too (review of e794c6e);
 * - otherwise everything sends with a granted consent (`align telemetry on`) or after the notice.
 *   Beacons and usage now share one rule; BEACON_STAGES remains the documented set.
 * Every caller has already returned under an env switch, in CI and (for usage) in a hook.
 */
function localTierAllows(
  consent: TelemetryConsent | undefined,
  stage: FunnelStage | 'install' | 'command',
  noticeShown: boolean,
): boolean {
  if (storedAnswerForbidsSending(consent)) return false;
  return consent === 'granted' || noticeShown;
}

function noticeShownOn(config: { getTelemetryNoticeShownAt(): string | undefined }): boolean {
  return config.getTelemetryNoticeShownAt() !== undefined;
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
    // C6: a CI job is not an install, so it must not consume the first run; nor do the runs
    // nobody is reading (an agent's `mcp` server, a hook, a run inside a launched agent) - the
    // notice is skipped there, so the beacon would have nothing to follow.
    if (inCi() || inHookContext() || commandPath === 'mcp' || commandPath.startsWith('mcp ')) return false;
    if (process.env['ALIGN_WRAPPED']) return false;
    const { createConfigStore } = await import('./config.js');
    const { resolveEnv } = await import('./resolve-env.js');
    const config = createConfigStore();
    if (config.wasFunnelStageRecorded('install')) return false;
    const env = config.getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
    if (env.authToken) return false;
    // A decision that says "never" consumes the first run, so the beacon is never sent later
    // either: an env switch, `align telemetry off`, or a stored No.
    const consent = config.getTelemetryConsent();
    if (telemetryOptedOut() || storedAnswerForbidsSending(consent)) {
      config.markFunnelStageRecorded('install');
      return false;
    }
    // Not told yet (no notice: no terminal, or the notice failed): the first run is NOT consumed,
    // so the beacon goes out after the first run that does show the notice.
    if (!localTierAllows(consent, 'install', noticeShownOn(config))) return false;
    // Marked BEFORE the send, as a check-and-set on the store, so two first runs started together
    // mostly send one beacon. Not atomic across processes: the store is a JSON file with no lock,
    // so two processes that both read it before either writes can still both send. The cost is
    // one duplicate install row, in the overcount direction, and only on a racing first run.
    if (!config.claimFunnelStage('install')) return false;

    // Awaited, unlike every other send: the stage is once-only and already claimed, so a request
    // that never left (the command exited first, `align status` does) would lose this install
    // from the funnel forever. Capped at INSTALL_BEACON_CAP_MS; if it is not delivered in that
    // time the claim is released, so the next run retries. A request the gateway received but did
    // not answer in time may then arrive twice - an overcount of one, never a lost install.
    const target = process.env['ALIGN_GATEWAY_URL'] || ALIGN_HOSTED_GATEWAY_URL;
    const delivered = await postDelivered(
      `${target}/telemetry/anonymous`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installId: config.getInstallId(),
          command: 'align',
          cliVersion: pkg.version,
          stage: 'install',
          os: process.platform,
        }),
      },
      INSTALL_BEACON_CAP_MS,
    );
    if (!delivered) config.releaseFunnelStage('install');
    return delivered;
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
 * `align connect git --env local` leaves the subcommand's own `opts()` empty, because `--env`
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

/**
 * C6: what runs before every command (cli.ts's preAction): the one-time notice, then the
 * install beacon, both awaited. On every run but the first, the beacon returns after a config
 * read and sends nothing. On the first run it is the one send that is awaited, capped at
 * INSTALL_BEACON_CAP_MS (see recordInstallBeacon), so the command cannot exit before it is
 * delivered. Every other event stays fire-and-forget. `hook` is the invocation's own flags (`check --hook` /
 * `--advisory`), marked here because the command's action, which also marks it, runs later.
 */
export async function beginInvocationTelemetry(commandPath: string, opts: { hook: boolean }): Promise<boolean> {
  if (opts.hook) markHookContext();
  try {
    const { createConfigStore } = await import('./config.js');
    const { resolveEnv } = await import('./resolve-env.js');
    const config = createConfigStore();
    const env = config.getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
    maybeShowTelemetryNotice(config, { command: commandPath, hook: opts.hook, cloudSignedIn: Boolean(env.authToken) });
  } catch {
    // Telemetry must never fail a command. No notice means nothing that waits on it sends.
  }
  return recordInstallBeacon(commandPath);
}
