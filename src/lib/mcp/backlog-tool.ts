/**
 * The MCP tool `align_backlog` - an agent can PLAN a backlog from a decision and can create it only after the person says yes.
 *
 * Two calls, and the second cannot happen without the first:
 * 1. `decision` (+ optional tracker, team, repo, project): shapes the tasks and returns the plan (tracker, destination, the
 *    titles, a plan token). Nothing is created, and nothing is written but the pending plan on this machine.
 * 2. `confirm_token`: creates exactly the tasks of that plan, once. The token comes only from call 1, so an agent that
 *    never planned cannot create, and one that planned has been handed the plan to show the user.
 *
 * What it reuses, not forks: run.ts does every question, the ledger, the lock and the creating, exactly as `align backlog`
 * does. What it adds is the token, and a structured question where the command would ask one at a terminal.
 *
 * The input schema is closed: there is no property for a token or key. The credential is the person's own (align connect,
 * LINEAR_API_KEY, GITHUB_TOKEN) and Align's read-only sign-ins are never upgraded. The person asked, in their own agent.
 */
import { createConfigStore } from '../config.js';
import type { EnvironmentConfig } from '../config.js';
import type { createGatewayClient } from '../gateway-client.js';
import { resolveMcpEnvironment } from '../mcp-env.js';
import { backlogPaths, backlogRepoKey, createBacklogDeps } from '../backlog/deps.js';
import { getEntry, type PlannedTask, withLock } from '../backlog/ledger.js';
import { isPlanToken, savePlan, takePlan } from '../backlog/pending.js';
import {
  type BacklogDeps, createIssues, credentialFor, loadTasks, NeedsChoice, resolveBacklog, type Resolved, savedTargetLine, Stop,
} from '../backlog/run.js';
import { TRACKER_LABEL, TRACKERS } from '../backlog/trackers.js';
import { LockedError } from '../backlog/ledger.js';
import { jsonSchemaOf, strictInput, type StrictSpec } from './tool-rules.js';

export const BACKLOG_TOOL = 'align_backlog';

const SPEC: StrictSpec = {
  tool: BACKLOG_TOOL,
  required: [],
  properties: {
    decision: { type: 'string', description: 'The decision to turn into issues: its id, or words that name it. Pass this to PLAN.', maxLength: 500 },
    confirm_token: { type: 'string', description: 'The plan_id the plan call returned, passed back AFTER the user said yes to that plan. Pass only this to CREATE.', maxLength: 64 },
    tracker: { type: 'string', description: 'linear, github or jira. Leave out to use the saved one or the only one connected.', enum: TRACKERS },
    team: { type: 'string', description: 'Linear team key. Leave out unless the user named one or the tool asked.', maxLength: 100 },
    repo: { type: 'string', description: 'GitHub repository as owner/repo. Leave out unless the user named one or the tool asked.', maxLength: 200 },
    project: { type: 'string', description: 'Jira project key. Leave out unless the user named one or the tool asked.', maxLength: 100 },
  },
};

export const BACKLOG_TOOL_SCHEMA = {
  name: BACKLOG_TOOL,
  // It writes issues to the user's own tracker, but only on the second call and only for a plan the first call returned. It deletes nothing.
  annotations: { readOnlyHint: false, destructiveHint: false },
  description:
    'Turn one decision into a backlog of issues (one per task, up to 8) in the user\'s own Linear, GitHub Issues or Jira. Call it ONLY when the user asks for tickets, issues or a backlog from a decision. Never call it on your own initiative. ' +
    'It works in two steps. Step 1: pass `decision` (and tracker, team, repo or project only if the user said them). You get a PLAN: tracker, destination, the task titles, and a plan_id. Nothing is created until step 2. ' +
    'Show the plan to the user, with the destination and the number of issues, and ask whether to create them. Step 2, only after the user says yes: call again with only `confirm_token` set to the plan_id. That creates exactly the tasks you showed, once. ' +
    'If the plan comes back as needs_choice, ask the user the question it carries (its options are real choices) and call step 1 again with their answer. Never guess a team, repo or project. ' +
    'If the user changes their mind about a task or the destination, plan again. The tool remembers the destination per repo after the first success, so later plans need no question. ' +
    'It uses the user\'s own tracker credential, and never takes a token or key.',
  inputSchema: jsonSchemaOf(SPEC),
} as const;

export interface BacklogToolContext {
  /** Test seam: the deps (with this call's output collectors) and where pending plans live. Production reads the real config. */
  backlog?: { makeDeps: (io: { out: (l: string) => void; err: (l: string) => void }) => BacklogDeps; planDir: string };
}

export type BacklogToolResult = { status: string; text: string; [k: string]: unknown };

interface Wiring { makeDeps: (io: { out: (l: string) => void; err: (l: string) => void }) => BacklogDeps; planDir: string }

async function wiringFor(client: ReturnType<typeof createGatewayClient>, env: EnvironmentConfig, ctx: BacklogToolContext): Promise<Wiring> {
  if (ctx.backlog) return ctx.backlog;
  const config = createConfigStore();
  const resolved = resolveMcpEnvironment(undefined, config);
  const repoKey = await backlogRepoKey();
  const paths = backlogPaths();
  return {
    planDir: paths.plansDir,
    // Connector tokens live under the env they were connected in; local mode is where token paste lives.
    makeDeps: (io) => createBacklogDeps({ client, config, envNames: resolved.name === 'local' ? ['local'] : [resolved.name, 'local'], appUrlEnv: env, repoKey, interactive: false, out: io.out, err: io.err, paths }),
  };
}

const issuesOf = (tasks: PlannedTask[]) => tasks.filter((t) => t.key).map((t) => ({ key: t.key!, url: t.url!, title: t.title }));

export async function runBacklogTool(
  args: Record<string, unknown> | undefined, client: ReturnType<typeof createGatewayClient>, env: EnvironmentConfig, ctx: BacklogToolContext = {},
): Promise<BacklogToolResult> {
  const input = strictInput(SPEC, args);
  const token = input['confirm_token'];
  const decision = input['decision'];
  if (token !== undefined && (decision !== undefined || ['tracker', 'team', 'repo', 'project'].some((k) => input[k] !== undefined))) {
    throw new Error(`${BACKLOG_TOOL}: pass only confirm_token to create, or decision to plan, not both. To change the plan, plan again.`);
  }
  if (token === undefined && (typeof decision !== 'string' || decision.trim() === '')) {
    throw new Error(`${BACKLOG_TOOL} requires "decision" to plan a backlog, or "confirm_token" to create the plan the user approved.`);
  }
  const w = await wiringFor(client, env, ctx);
  try {
    return token !== undefined ? await confirm(String(token), w) : await plan(input, w);
  } catch (e) {
    if (e instanceof Stop && !(e instanceof NeedsChoice)) throw new Error(e.message);
    if (e instanceof LockedError) throw new Error(e.message);
    throw e;
  }
}

async function plan(input: Record<string, unknown>, w: Wiring): Promise<BacklogToolResult> {
  const lines: string[] = [];
  const d = w.makeDeps({ out: (l) => lines.push(l), err: (l) => lines.push(l) });
  let r: Resolved;
  try {
    r = await resolveBacklog({
      decision: String(input['decision']), tracker: input['tracker'] as string | undefined, team: input['team'] as string | undefined,
      repo: input['repo'] as string | undefined, project: input['project'] as string | undefined, structuredChoices: true,
    }, d);
  } catch (e) {
    if (!(e instanceof NeedsChoice)) throw e;
    const c = e.choice;
    const options = c.options.length
      ? `Options:\n${c.options.map((o) => `  ${o.value}  (${o.label})`).join('\n')}\n`
      : '';
    return {
      status: 'needs_choice', field: c.field, question: c.question, options: c.options,
      text: `Nothing has been created or planned yet. ASK THE USER: ${c.question}\n${options}Then call ${BACKLOG_TOOL} again with their answer as "${c.field}"${c.field === 'decision' ? '' : ' and the same decision'}.`,
    };
  }
  const l = await loadTasks({ decision: r.dec.id }, d, r);
  const where = `${TRACKER_LABEL[r.tracker]} (${r.target})`;
  if (l.done) {
    return {
      status: 'already_created', tracker: r.tracker, destination: r.target, issues: issuesOf(l.tasks),
      text: `"${r.dec.title}" already has ${l.tasks.length} issues in ${where}. Nothing to create:\n${l.tasks.map((t) => `  ${t.key}  ${t.title}  ${t.url}`).join('\n')}`,
    };
  }
  const { token, expiresAt } = savePlan(w.planDir, {
    decision: { id: r.dec.id, title: r.dec.title, summary: r.dec.summary, sourceUrl: r.dec.sourceUrl ?? null, actions: r.dec.actions },
    tracker: r.tracker, target: r.target, key: r.key, tasks: l.tasks,
  });
  const pending = l.tasks.filter((t) => !t.key);
  const saved = r.usedSaved ? `${savedTargetLine(r.tracker, r.target)}\n` : '';
  return {
    status: 'plan', plan_id: token, expires_at: expiresAt, tracker: r.tracker, destination: r.target, used_saved_target: r.usedSaved,
    decision: { id: r.dec.id, title: r.dec.title }, count: pending.length, resumed: l.resumed,
    tasks: pending.map((t) => ({ title: t.title })),
    text: `PLAN ONLY. Nothing has been created.\n${saved}${pending.length} ${pending.length === 1 ? 'issue' : 'issues'} in ${where} from "${r.dec.title}"${l.resumed ? ' (the rest of an earlier run)' : ''}:\n` +
      `${pending.map((t) => `  - ${t.title}`).join('\n')}\n` +
      `Show this plan to the user and ask whether to create these issues in ${where}. Only if they say yes, call ${BACKLOG_TOOL} with confirm_token "${token}" and nothing else. The token works once, for 30 minutes.`,
  };
}

async function confirm(token: string, w: Wiring): Promise<BacklogToolResult> {
  const stored = isPlanToken(token) ? takePlan(w.planDir, token) : null;
  if (!stored) {
    throw new Error(`No pending plan for that token: it was never issued, was already used, or expired. Nothing was created. Plan again with ${BACKLOG_TOOL} and "decision", show the user the plan, then confirm.`);
  }
  const lines: string[] = [];
  const d = w.makeDeps({ out: (l) => lines.push(l), err: (l) => lines.push(l) });
  const r: Resolved = {
    dec: { ...stored.decision, actions: stored.decision.actions }, tracker: stored.tracker, target: stored.target, key: stored.key,
    fields: credentialFor(stored.tracker, undefined, d), usedSaved: false,
  };
  const where = `${TRACKER_LABEL[r.tracker]} (${r.target})`;
  return withLock(d.ledgerPath, async () => {
    // The ledger outranks the plan: a run that finished while the user was deciding must not be created twice.
    const prior = getEntry(d.ledgerPath, r.key);
    const tasks = prior?.tasks ?? stored.tasks;
    if (prior && prior.tasks.every((t) => t.key)) {
      return { status: 'already_created', tracker: r.tracker, destination: r.target, issues: issuesOf(tasks), text: `Those issues already exist in ${where}, so nothing was created:\n${tasks.map((t) => `  ${t.key}  ${t.title}  ${t.url}`).join('\n')}` };
    }
    const done = await createIssues(d, r, tasks, prior !== undefined);
    const made = issuesOf(done.tasks);
    const missing = done.tasks.length - made.length;
    return {
      status: done.code === 0 ? 'created' : 'partial', tracker: r.tracker, destination: r.target, created: made, not_created: missing,
      text: `${lines.join('\n')}\n${done.code === 0 ? `Created ${made.length} in ${where}. Give the user these links.` : `${missing} not created. Tell the user; to create the rest, plan again (the plan resumes from what exists).`}`,
    };
  });
}
