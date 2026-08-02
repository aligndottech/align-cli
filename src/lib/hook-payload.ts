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
}

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

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

// Normalize whichever host's hook payload arrived on stdin into the canonical
// HookPayload, so runAdvisory never learns which agent it is serving. Every field name
// below comes from that host's published schema:
//   Claude Code  {hook_event_name, tool_name, tool_input}            - already canonical
//   pi           {type:'tool_call'|'tool_result', toolName, input}   - extension events
//   Gemini CLI   {tool_name, tool_input, tool_response?}             - AfterTool is the
//                one carrying tool_response, which is what derives the event
//   Cursor       {hook_event_name:'afterFileEdit', file_path, edits} - fields sit at the
//                TOP level rather than under tool_input
// Returns null when nothing tool-shaped is present, so callers fall back rather than
// checking an empty change.
export function normalizeHookPayload(raw: unknown): HookPayload | null {
  const p = asRecord(raw);
  if (!p) return null;

  // pi: the event type is explicit on the payload.
  if (p['type'] === 'tool_call' || p['type'] === 'tool_result') {
    const input = asRecord(p['input']) ?? {};
    return {
      hook_event_name: p['type'] === 'tool_call' ? 'PreToolUse' : 'PostToolUse',
      tool_name: typeof p['toolName'] === 'string' ? p['toolName'] : undefined,
      tool_input: fromPiInput(input),
    };
  }

  // OpenCode: the plugin hook name is the event.
  if (p['type'] === 'tool.execute.before' || p['type'] === 'tool.execute.after') {
    return {
      hook_event_name: p['type'] === 'tool.execute.before' ? 'PreToolUse' : 'PostToolUse',
      tool_name: typeof p['tool'] === 'string' ? p['tool'] : undefined,
      tool_input: fromOpenCodeArgs(asRecord(p['args']) ?? {}),
    };
  }

  // Cursor: afterFileEdit is observational and flat. (There is no beforeFileEdit.)
  if (p['hook_event_name'] === 'afterFileEdit') {
    const tool_input: HookToolInput = {};
    if (typeof p['file_path'] === 'string') tool_input.file_path = p['file_path'];
    if (Array.isArray(p['edits'])) tool_input.edits = p['edits'] as HookToolInput['edits'];
    return { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input };
  }

  // Claude Code / Gemini CLI: both already speak tool_name + tool_input.
  if (p['tool_name'] !== undefined || p['tool_input'] !== undefined) {
    const event =
      typeof p['hook_event_name'] === 'string'
        ? p['hook_event_name']
        : p['tool_response'] !== undefined
          ? 'PostToolUse'
          : 'PreToolUse';
    return {
      hook_event_name: event,
      tool_name: typeof p['tool_name'] === 'string' ? p['tool_name'] : undefined,
      tool_input: (asRecord(p['tool_input']) ?? {}) as HookToolInput,
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
function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 200);
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string) => { data += chunk; });
    stream.on('end', () => { clearTimeout(timer); resolve(data); });
    stream.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
