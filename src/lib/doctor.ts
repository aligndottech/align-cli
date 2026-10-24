/**
 * The checks behind `align doctor`, the install preflight.
 *
 * On a remote install the person at the keyboard is the buyer, so every failing check names the
 * one next step for THEM. The last check is the one that matters: a real `tools/call` of
 * `align_ask` through `align mcp`. `tools/list` is a local protocol answer that never reaches the
 * gateway and passes with a wrong-type credential, so it proves nothing about the path the
 * product depends on (verification.md in align-stack, "a positive control on an ADJACENT
 * mechanism proves nothing").
 *
 * Pure of I/O: everything that touches the machine arrives through DoctorDeps, so each failure
 * mode is testable. commands/doctor.ts wires the real ones.
 */
import type { EnvironmentConfig } from './config.js';

export const MIN_NODE = '22.16.0';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export type CheckId = 'node' | 'path' | 'gateway' | 'whoami' | 'embeddings' | 'ask';

export interface DoctorCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the person at the keyboard does about it. Set on failures only. */
  next?: string;
}

export interface DoctorDeps {
  nodeVersion: string;
  envName: string;
  mode: EnvironmentConfig['mode'];
  gatewayUrl: string;
  hasToken: boolean;
  /** Absolute path of the `align` an agent would spawn, or null when none is on PATH. */
  findAlign(): string | null;
  probeGateway(): Promise<{ reached: boolean; detail: string }>;
  whoami(): Promise<{ email: string; tenant: string }>;
  /**
   * Local graph only: make sure the on-device embedding runtime and model are present (downloading
   * them if this is the first run) and verified. Throws with the reason on any failure. Absent on
   * a cloud install, where nothing embeds on this machine.
   */
  ensureEmbeddings?(): Promise<{ detail: string }>;
  /** One real `tools/call` of align_ask through `align mcp`. Resolves with the text content; throws on any error. */
  askViaMcp(alignBin: string): Promise<{ text: string }>;
}

/** Numeric compare on major.minor.patch. A version that does not parse fails the floor. */
export function nodeMeetsFloor(version: string, floor: string = MIN_NODE): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(version);
  const need = parse(floor);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => (e as { statusCode?: number } | null)?.statusCode;
const loginCommand = (envName: string): string => `align login --env ${envName}`;

async function guarded(fn: () => Promise<DoctorCheck>, fallback: Omit<DoctorCheck, 'status' | 'detail'>): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (e) {
    return { ...fallback, status: 'fail', detail: `the check itself crashed: ${message(e)}` };
  }
}

/**
 * Why an answer is not an answer, or undefined when it is one. The real server serialises the
 * gateway's JSON, so a bare `null` or `{}` is non-empty TEXT that carries no answer: JSON text must
 * hold a `results` list (an empty list is a real answer from an empty graph). Plain text passes.
 */
export function answerProblem(text: string): string | undefined {
  if (text.trim() === '') return 'the tool call came back with an empty answer, which is not a pass';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const results = (parsed as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? undefined : 'the tool call came back with an empty answer: JSON with no results list, which is not a pass';
}

function resultCount(text: string): number | undefined {
  try {
    const r = (JSON.parse(text) as { results?: unknown } | null)?.results;
    return Array.isArray(r) ? r.length : undefined;
  } catch {
    return undefined;
  }
}

export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Node
  checks.push(
    nodeMeetsFloor(d.nodeVersion)
      ? { id: 'node', label: 'Node version', status: 'pass', detail: `Node ${d.nodeVersion} (needs ${MIN_NODE} or newer)` }
      : {
          id: 'node',
          label: 'Node version',
          status: 'fail',
          detail: `Node ${d.nodeVersion} is older than the ${MIN_NODE} Align needs`,
          next: `Install Node 22.16 or newer from nodejs.org, open a new terminal, then run: align doctor`,
        },
  );

  // 2. align on PATH
  const bin = d.findAlign();
  checks.push(
    bin
      ? { id: 'path', label: 'align on PATH', status: 'pass', detail: bin }
      : {
          id: 'path',
          label: 'align on PATH',
          status: 'fail',
          detail: 'no `align` found on PATH, so an agent could not start it either',
          next: 'Run: npm install -g @aligndottech/cli  then open a new terminal (PATH is read when a terminal opens) and run: align doctor',
        },
  );

  const local = d.mode === 'local-embedded';

  // 3. gateway reachable
  let gatewayUp = false;
  if (local) {
    checks.push({ id: 'gateway', label: 'Gateway reachable', status: 'skip', detail: 'local graph on this machine, no gateway involved' });
  } else {
    checks.push(
      await guarded(
        async () => {
          const r = await d.probeGateway();
          gatewayUp = r.reached;
          return r.reached
            ? { id: 'gateway', label: 'Gateway reachable', status: 'pass', detail: `${d.gatewayUrl} ${r.detail}` }
            : {
                id: 'gateway',
                label: 'Gateway reachable',
                status: 'fail',
                detail: `${d.gatewayUrl} did not answer (${r.detail})`,
                next: 'Check this machine can reach the internet without a VPN or proxy blocking it (open the URL above in a browser), then run: align doctor',
              };
        },
        { id: 'gateway', label: 'Gateway reachable' },
      ),
    );
  }

  // 4. whoami
  if (local) {
    checks.push({ id: 'whoami', label: 'Token accepted', status: 'skip', detail: 'local graph on this machine, no account involved' });
  } else if (!gatewayUp) {
    checks.push({ id: 'whoami', label: 'Token accepted', status: 'skip', detail: 'not run: the gateway is not reachable' });
  } else if (!d.hasToken) {
    checks.push({
      id: 'whoami',
      label: 'Token accepted',
      status: 'fail',
      detail: `no token saved for ${d.envName}`,
      next: `Run: ${loginCommand(d.envName)}`,
    });
  } else {
    checks.push(
      await guarded(
        async () => {
          try {
            const me = await d.whoami();
            return { id: 'whoami', label: 'Token accepted', status: 'pass', detail: `${me.email} (${me.tenant})` };
          } catch (e) {
            const code = statusOf(e);
            const rejected = code === 401 || code === 403;
            return {
              id: 'whoami',
              label: 'Token accepted',
              status: 'fail',
              detail: message(e),
              next: rejected ? `The gateway rejected this token. Run: ${loginCommand(d.envName)}` : 'Run: align doctor again in a minute; if it repeats, send the line above to whoever set up Align for you.',
            };
          }
        },
        { id: 'whoami', label: 'Token accepted' },
      ),
    );
  }

  // 5. on-device embeddings (local graph only)
  if (local && d.ensureEmbeddings) {
    checks.push(
      await guarded(
        async () => {
          try {
            const r = await d.ensureEmbeddings!();
            return { id: 'embeddings', label: 'On-device embeddings', status: 'pass', detail: r.detail };
          } catch (e) {
            return {
              id: 'embeddings',
              label: 'On-device embeddings',
              status: 'fail',
              detail: message(e),
              next: 'Check this machine can reach github.com and huggingface.co (a proxy or firewall is the usual cause; HF_ENDPOINT and ALIGN_ORT_RUNTIME_URL point at a mirror), then run: align doctor. Cloud mode (align login) needs none of this.',
            };
          }
        },
        { id: 'embeddings', label: 'On-device embeddings' },
      ),
    );
  }

  // 6. the real tool call
  if (!bin) {
    checks.push({ id: 'ask', label: 'Tool call (align_ask)', status: 'skip', detail: 'not run: no `align` on PATH to start' });
  } else {
    checks.push(
      await guarded(
        async () => {
          try {
            const { text } = await d.askViaMcp(bin);
            const problem = answerProblem(text);
            if (problem !== undefined) {
              return {
                id: 'ask',
                label: 'Tool call (align_ask)',
                status: 'fail',
                detail: problem,
                next: 'Send this screen to whoever set up Align for you. An empty answer means the call did not reach a working Align.',
              };
            }
            return { id: 'ask', label: 'Tool call (align_ask)', status: 'pass', detail: `align mcp answered a real align_ask (${text.length} characters${resultCount(text) === 0 ? ', 0 decisions matched: the graph may just be empty' : ''})` };
          } catch (e) {
            const m = message(e);
            const auth = /\b40[13]\b/.test(m);
            return {
              id: 'ask',
              label: 'Tool call (align_ask)',
              status: 'fail',
              detail: m,
              next: auth ? `The gateway rejected the credential on a real call. Run: ${loginCommand(d.envName)}` : 'Send this screen to whoever set up Align for you.',
            };
          }
        },
        { id: 'ask', label: 'Tool call (align_ask)' },
      ),
    );
  }

  return checks;
}

/** Skips never fail a run (each one has a failing or n/a prerequisite named in its detail). A fail always does. */
export function doctorPassed(checks: DoctorCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.status !== 'fail');
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const tag: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${tag[c.status]}  ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.status === 'fail' && c.next) lines.push(`      Next: ${c.next}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  lines.push('', failed === 0 ? 'All checks passed.' : `${failed} check${failed === 1 ? '' : 's'} failed.`);
  return lines.join('\n');
}
