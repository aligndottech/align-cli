import type { Readable } from 'node:stream';

export interface HookToolInput {
  file_path?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: HookToolInput;
  /**
   * The workspace the edit belongs to, when the host says (every host puts it under `cwd`).
   * A USER-level hook does not run in the project - Cursor documents that user-level hook
   * scripts run from ~/.cursor/ - and the post-edit path reads `git diff` in process.cwd(),
   * so without this the check would look at the wrong directory (ALI-952).
   */
  cwd?: string;
}

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

const cwdOf = (p: Raw): string | undefined => (typeof p['cwd'] === 'string' ? p['cwd'] : undefined);

// pi's edit tool takes edits[{oldText,newText}] (and still accepts a legacy top-level
// oldText/newText pair - see prepareEditArguments in pi's core/tools/edit.ts). Rename
// into the canonical shape proposedChangeText() reads.
function fromPiInput(input: Raw): HookToolInput {
  const out: HookToolInput = {};
  if (typeof input['path'] === 'string') out.file_path = input['path'];
  if (typeof input['content'] === 'string') out.content = input['content'];
  if (Array.isArray(input['edits'])) {
    out.edits = (input['edits'] as Raw[]).map((e) => ({
      old_string: typeof e?.['oldText'] === 'string' ? (e['oldText'] as string) : undefined,
      new_string: typeof e?.['newText'] === 'string' ? (e['newText'] as string) : undefined,
    }));
  } else if (typeof input['oldText'] === 'string' || typeof input['newText'] === 'string') {
    if (typeof input['oldText'] === 'string') out.old_string = input['oldText'];
    if (typeof input['newText'] === 'string') out.new_string = input['newText'];
  }
  return out;
}

// OpenCode passes each tool's own parameter names straight through to the plugin.
// Taken from packages/opencode/src/tool/*.ts:
//   edit        {filePath, oldString, newString, replaceAll?}
//   write       {content, filePath}
//   apply_patch {patchText}  - one blob describing the whole change
function fromOpenCodeArgs(args: Raw): HookToolInput {
  const out: HookToolInput = {};
  if (typeof args['filePath'] === 'string') out.file_path = args['filePath'];
  if (typeof args['content'] === 'string') out.content = args['content'];
  // The patch text IS the proposed change, so it maps to `content` - the first field
  // proposedChangeText() reads.
  if (typeof args['patchText'] === 'string') out.content = args['patchText'];
  if (typeof args['oldString'] === 'string') out.old_string = args['oldString'];
  if (typeof args['newString'] === 'string') out.new_string = args['newString'];
  return out;
}

// Codex speaks Claude Code's field names, and its file edits go through apply_patch, whose
// tool_input carries the whole patch under `command` (Codex hooks reference: "tool_input.command
// applies to Bash and apply_patch"). The patch IS the proposed change, so it maps to
// `content` exactly as OpenCode's patchText does. ONLY for apply_patch: a Bash command is
// not a proposed edit. Documented shape, pending a real capture (fixtures/hook-payloads/).
function fromCodexInput(toolName: string | undefined, input: Raw): HookToolInput {
  const out = { ...input } as HookToolInput;
  if (toolName === 'apply_patch' && typeof input['command'] === 'string' && out.content === undefined) {
    out.content = input['command'];
  }
  return out;
}

// The host event names that mean "before the tool runs" / "after it ran". Claude Code and
// Codex use PascalCase; Cursor uses camelCase for the same two events. Passed through
// verbatim, 'preToolUse' would never equal 'PreToolUse' and the proposed edit would be
// checked as though it had already landed - silently.
function canonicalEvent(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'pretooluse') return 'PreToolUse';
  if (lower === 'posttooluse') return 'PostToolUse';
  return name;
}

// Normalize whichever host's hook payload arrived on stdin into the canonical
// HookPayload, so runAdvisory never learns which agent it is serving. Every field name
// below comes from that host's published schema:
//   Claude Code  {hook_event_name, tool_name, tool_input, cwd}            - already canonical
//   Codex        the same, with apply_patch's patch under tool_input.command
//   pi           {type:'tool_call'|'tool_result', toolName, input}   - extension events
//   Gemini CLI   {tool_name, tool_input, tool_response?}             - AfterTool is the
//                one carrying tool_response, which is what derives the event
//   Cursor       {hook_event_name:'preToolUse'|'postToolUse', tool_name, tool_input, cwd},
//                and {hook_event_name:'afterFileEdit', file_path, edits} - fields sit at the
//                TOP level rather than under tool_input
//   Copilot CLI  {sessionId, timestamp, cwd, toolName, toolArgs, toolResult?} - no event
//                name at all; toolResult is what postToolUse carries. Its "VS Code
//                compatible" variant is the Claude Code shape and takes that branch.
// Returns null when nothing tool-shaped is present, so callers fall back rather than
// checking an empty change.
export function normalizeHookPayload(raw: unknown): HookPayload | null {
  const p = asRecord(raw);
  if (!p) return null;
  const cwd = cwdOf(p);

  // pi: the event type is explicit on the payload.
  if (p['type'] === 'tool_call' || p['type'] === 'tool_result') {
    const input = asRecord(p['input']) ?? {};
    return {
      hook_event_name: p['type'] === 'tool_call' ? 'PreToolUse' : 'PostToolUse',
      tool_name: typeof p['toolName'] === 'string' ? p['toolName'] : undefined,
      tool_input: fromPiInput(input),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  // OpenCode: the plugin hook name is the event.
  if (p['type'] === 'tool.execute.before' || p['type'] === 'tool.execute.after') {
    return {
      hook_event_name: p['type'] === 'tool.execute.before' ? 'PreToolUse' : 'PostToolUse',
      tool_name: typeof p['tool'] === 'string' ? p['tool'] : undefined,
      tool_input: fromOpenCodeArgs(asRecord(p['args']) ?? {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  // Cursor: afterFileEdit is observational and flat.
  if (p['hook_event_name'] === 'afterFileEdit') {
    const tool_input: HookToolInput = {};
    if (typeof p['file_path'] === 'string') tool_input.file_path = p['file_path'];
    if (Array.isArray(p['edits'])) tool_input.edits = p['edits'] as HookToolInput['edits'];
    return { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input, ...(cwd !== undefined ? { cwd } : {}) };
  }

  // Claude Code / Codex / Gemini CLI / Cursor: all speak tool_name + tool_input.
  if (p['tool_name'] !== undefined || p['tool_input'] !== undefined) {
    const tool_name = typeof p['tool_name'] === 'string' ? p['tool_name'] : undefined;
    const event =
      typeof p['hook_event_name'] === 'string'
        ? canonicalEvent(p['hook_event_name'])
        : p['tool_response'] !== undefined
          ? 'PostToolUse'
          : 'PreToolUse';
    return {
      hook_event_name: event,
      tool_name,
      tool_input: fromCodexInput(tool_name, asRecord(p['tool_input']) ?? {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  // Copilot CLI (camelCase): toolName + toolArgs, toolResult only after the tool ran. The
  // toolArgs field names for its edit/create tools are not documented; they pass through
  // as-is and a shape proposedChangeText() cannot read means the pre-edit check stays
  // silent (fail-open) while postToolUse still carries the landed diff. Pending a real
  // capture (fixtures/hook-payloads/).
  if (typeof p['toolName'] === 'string') {
    return {
      hook_event_name: p['toolResult'] !== undefined ? 'PostToolUse' : 'PreToolUse',
      tool_name: p['toolName'],
      tool_input: (asRecord(p['toolArgs']) ?? {}) as HookToolInput,
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }

  return null;
}

// Read and parse the JSON payload the host agent pipes to a hook command on stdin,
// normalizing whichever shape it sent (see normalizeHookPayload). Returns null when
// there is no usable payload - a TTY (manual `align check --advisory` run), empty
// stdin, invalid JSON, or nothing tool-shaped - so callers fall back to their
// non-hook behaviour.
export async function readHookPayload(
  stream: Readable & { isTTY?: boolean } = process.stdin,
): Promise<HookPayload | null> {
  if (stream.isTTY) return null;
  const raw = await readAll(stream).catch(() => '');
  if (!raw.trim()) return null;
  try {
    return normalizeHookPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Read the stream to end. A short timeout guarantees a manual, non-TTY run with no
// piped data never hangs the hook - it resolves empty and the caller falls back.
/**
 * How long to wait for the FIRST byte. A host spawns the process and then writes, so this is
 * spawn latency, not think time - and the old 200ms was inside it. Measured on the shipped
 * build: a payload delayed 150ms was already being missed, which read as "no payload" and made
 * the hook exit 0 in silence. Bounded well under check.ts's own 2.5s retrieval race so a
 * genuinely empty pipe still cannot make the hook the slow part of an edit.
 */
const FIRST_BYTE_TIMEOUT_MS = 2_000;
/** Once bytes are flowing, only a stall this long ends the read. `end` normally beats it. */
const IDLE_TIMEOUT_MS = 200;

function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    // ReturnType<typeof setTimeout> rather than NodeJS.Timeout: the eslint config has no Node
    // globals declared, so the namespace form is a no-undef error here.
    let timer: ReturnType<typeof setTimeout>;
    const settle = (): void => {
      clearTimeout(timer);
      resolve(data);
    };
    // Re-armed per chunk rather than set once: a fixed deadline from attach time is a race
    // against the writer, which is the defect. Waiting on `end` alone would instead hang a
    // manual run whose stdin is an open pipe nobody writes to.
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(settle, ms);
    };
    arm(FIRST_BYTE_TIMEOUT_MS);
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => {
      data += chunk;
      arm(IDLE_TIMEOUT_MS);
    });
    stream.on('end', settle);
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
