/**
 * LM: the MCP tool `align_mark` - the USER's judgement, recorded locally, relayed by their agent.
 *
 * What an agent may and may not do here:
 * - It may record a verdict, a replacement, a "not a decision" and a note the user asked it to
 *   record. Each row carries `via = 'mcp'` and the agent's registry id (or 'unknown'), so the
 *   person sees later which answers came through an agent, and a share lists them separately.
 * - It may NOT ratify. Ratifying is a person standing behind a decision; `align ratify` refuses
 *   anything that is not a terminal. `kind: "ratify"` gets the command for the user instead.
 * - It may NOT pass a token or key: the schema is closed.
 * - Nothing is sent anywhere and no model is asked. The tool reads and writes the local file.
 */
import { applyJudgement, type MarkAction, MarkError, MAX_CHECK_FILES, MAX_NOTE_CHARS } from '../curation/mark.js';
import type { Judge } from '../curation/judgements-db.js';
import { defaultJudge } from '../curation/judge.js';
import type { EnvironmentConfig } from '../config.js';
import { agentIdFrom, cliCommandFor, jsonSchemaOf, strictInput, type StrictSpec } from './tool-rules.js';

export const MARK_TOOL = 'align_mark';
/** What an agent may record. Hiding a decision, declaring one replaced and ratifying are the person's. */
export const MARK_KINDS = ['verdict', 'note'] as const;
const PERSON_ONLY: Readonly<Record<string, (id: string, other: string) => string>> = {
  not_a_decision: (id) => `align mark ${id} not-a-decision`,
  supersede: (id, other) => `align mark ${id} replaces ${other}`,
  ratify: (id) => cliCommandFor('ratify', id),
};

const SPEC: StrictSpec = {
  tool: MARK_TOOL,
  required: ['decision_id'],
  properties: {
    decision_id: { type: 'string', description: 'The decision the user is judging (its id from the check or from align_get_conflicts)', maxLength: 200 },
    kind: { type: 'string', description: 'verdict (default) or note', enum: MARK_KINDS },
    verdict: { type: 'string', description: 'With a verdict: real, or false (a false alarm), as the USER answered', enum: ['real', 'false'] },
    counterpart_id: { type: 'string', description: 'A stored conflict: the other decision of the pair. ', maxLength: 200 },
    check_files: { type: 'array', description: 'A check hit: the files the check covered, exactly as the check result listed them', maxItems: MAX_CHECK_FILES, itemMaxLength: 1024 },
    text: { type: 'string', description: 'With note: the note', maxLength: MAX_NOTE_CHARS },
  },
};

export const MARK_TOOL_SCHEMA = {
  name: MARK_TOOL,
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Record the USER\'s judgement in the local graph on this machine. After a conflict from align_check_alignment or align_get_conflicts, ASK the user "Was that a real conflict?" and pass their answer; never decide for them. ' +
    'For a check hit: decision_id + verdict (real or false) + check_files (the files the check covered, as the check result lists them); a false verdict hides that decision only for a later check of the same files. ' +
    'For a stored conflict: decision_id + counterpart_id + verdict. ' +
    'Also kind note (text: one line of plain text, 500 characters at most). ' +
    'Each is recorded as passed on by you, under your agent name; the user sees it labelled that way, a hit you hide is shown as hidden by you, and every check says so. Nothing is shared or sent; sharing is a separate step the user confirms. ' +
    'You cannot hide a decision (not_a_decision), mark one replaced (supersede) or ratify: those are the user\'s own acts, and asking for one returns the exact `align mark` or `align ratify` command to give them. You cannot replace a mark the user made themselves. It never takes a token or key. The user can list or undo marks with `align mark --list` and `--undo`.',
  inputSchema: jsonSchemaOf(SPEC),
} as const;

export interface MarkToolResult { text: string; [k: string]: unknown }
export interface MarkToolContext {
  /** The MCP `initialize` clientInfo, as the SDK holds it. */
  clientInfo?: { name?: unknown };
  judge?: () => Promise<Judge>;
}

function actionFrom(input: Record<string, unknown>): MarkAction {
  const id = input['decision_id'] as string;
  const kind = (input['kind'] as string | undefined) ?? 'verdict';
  const counterpart = input['counterpart_id'] as string | undefined;
  const files = input['check_files'] as string[] | undefined;
  const verdict = input['verdict'] as 'real' | 'false' | undefined;
  const stray = (names: string[]): string | undefined => names.find((n) => input[n] !== undefined);
  switch (kind) {
    case 'verdict': {
      if (verdict === undefined) throw new MarkError('usage', `${MARK_TOOL} needs "verdict" (real or false) for a verdict.`);
      if (input['text'] !== undefined) throw new MarkError('usage', `${MARK_TOOL} takes "text" only with kind "note".`);
      const hasFiles = files !== undefined && files.length > 0;
      if ((counterpart !== undefined) === hasFiles) {
        throw new MarkError('usage', `${MARK_TOOL} verdict takes one of two shapes: a check hit (decision_id + verdict + check_files), or a stored conflict (decision_id + counterpart_id + verdict).`);
      }
      return counterpart !== undefined
        ? { action: 'conflict', a: id, b: counterpart, verdict }
        : { action: 'check', id, verdict, files: files ?? [] };
    }
    default: {
      const text = input['text'];
      if (typeof text !== 'string' || text.trim() === '') throw new MarkError('usage', `${MARK_TOOL} kind note needs "text".`);
      const other = stray(['verdict', 'check_files', 'counterpart_id']);
      if (other) throw new MarkError('usage', `${MARK_TOOL} kind note does not take "${other}".`);
      return { action: 'note', id, text };
    }
  }
}

export async function runMarkTool(args: Record<string, unknown> | undefined, env: EnvironmentConfig, ctx: MarkToolContext = {}): Promise<MarkToolResult> {
  // A friendly refusal ahead of the closed enum: these are the person's acts, not typos.
  const kind = args?.['kind'];
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(PERSON_ONLY, kind)) {
    const clip = (v: unknown): string => (typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v) ? v : '<id>');
    throw new Error(`${MARK_TOOL} cannot do ${kind}: only the person can, not an agent. Ask the user to run: ${PERSON_ONLY[kind](clip(args?.['decision_id']), clip(args?.['counterpart_id']))}`);
  }
  const input = strictInput(SPEC, args);
  if (env.mode !== 'local-embedded' || !env.localDbPath) {
    throw new Error(
      `${MARK_TOOL} records judgements in the local graph on this machine, and this server reads a hosted Align graph. ` +
      'Use the local Align server (align mcp --env local).',
    );
  }
  const action = actionFrom(input);
  const judge = await (ctx.judge ?? defaultJudge)();
  try {
    const out = applyJudgement({ dbPath: env.localDbPath, judge, origin: { via: 'mcp', agentId: agentIdFrom(ctx.clientInfo) } }, action);
    return { recorded: true, kind: out.kind, replaced: out.replaced, text: out.text };
  } catch (e) {
    if (e instanceof MarkError) throw new Error(e.message);
    throw e;
  }
}
