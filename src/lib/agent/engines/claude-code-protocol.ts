import type { HookToolInput } from '../../hook-payload.js';
import { failureTail } from '../failure-tail.js';
import type { AgentUiEvent, BrokerVerdict, ToolAsk, ToolKind } from '../types.js';

/**
 * The wire format of the user's own `claude` in stream-json mode, as probed against 2.1.318.
 * Everything here is pure so a change in Claude Code's format is fixed in one file.
 */

export interface ParsedLine {
  events: AgentUiEvent[];
  /** The engine saw its system/init line. */
  init?: true;
  /** The request id a successful control_response answers. */
  answered?: string;
  /** A can_use_tool request the host must answer. */
  permission?: { requestId: string; ask: ToolAsk; input: Record<string, unknown> };
}

type Raw = Record<string, unknown>;
const asRecord = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

/** `manual` + host prompts: every permission question comes to us. Never bypassPermissions. */
export function buildArgs(extra: string[] = []): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
    // The user's own settings only. A repo's .claude/settings.json could otherwise run its hooks and
    // pre-approve tools before Align is asked, and headless claude shows no trust prompt for it.
    '--setting-sources', 'user', ...extra];
}

export const initializeLine = (requestId: string): string =>
  line({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } });
export const userMessageLine = (text: string): string =>
  line({ type: 'user', message: { role: 'user', content: text } });
export const interruptLine = (requestId: string): string =>
  line({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });

export function controlResponse(requestId: string, verdict: BrokerVerdict, input: Record<string, unknown>): string {
  const response = verdict.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.message };
  return line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite']);

function kindOf(tool: string): ToolKind {
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  return READ_TOOLS.has(tool) ? 'read' : 'other';
}

/** Only the fields the hook check reads, so the gate sees the same shape from every engine. */
function toEdit(input: Raw): HookToolInput {
  const out: HookToolInput = {};
  const path = str(input['file_path']) ?? str(input['notebook_path']);
  if (path !== undefined) out.file_path = path;
  if (str(input['content']) !== undefined) out.content = str(input['content']);
  if (str(input['old_string']) !== undefined) out.old_string = str(input['old_string']);
  const next = str(input['new_string']) ?? str(input['new_source']);
  if (next !== undefined) out.new_string = next;
  if (Array.isArray(input['edits'])) out.edits = input['edits'] as HookToolInput['edits'];
  return out;
}

function toAsk(id: string, tool: string, input: Raw): ToolAsk {
  const kind = kindOf(tool);
  const ask: ToolAsk = { id, tool, kind };
  if (kind === 'edit') ask.edit = toEdit(input);
  if (kind === 'command') ask.command = str(input['command']) ?? '';
  if (kind === 'other') ask.detail = JSON.stringify(input);
  return ask;
}

function summaryOf(tool: string, input: Raw): string {
  const kind = kindOf(tool);
  if (kind === 'command') return str(input['command']) ?? tool;
  if (kind === 'edit') return str(input['file_path']) ?? tool;
  return tool;
}

function contentBlocks(msg: Raw): Raw[] {
  const content = asRecord(msg['message'])?.['content'];
  return Array.isArray(content) ? content.map(asRecord).filter((b): b is Raw => b !== null) : [];
}

export function parseLine(raw: string): ParsedLine {
  let msg: Raw | null;
  try { msg = asRecord(JSON.parse(raw)); } catch { return { events: [] }; }
  if (!msg) return { events: [] };

  switch (msg['type']) {
    case 'system':
      return msg['subtype'] === 'init' ? { events: [], init: true } : { events: [] };
    case 'control_response': {
      const r = asRecord(msg['response']);
      const id = r?.['subtype'] === 'success' ? str(r['request_id']) : undefined;
      return id === undefined ? { events: [] } : { events: [], answered: id };
    }
    case 'result': {
      // An error result ("Not logged in", a refused request) must show, not read as an empty turn.
      const failed = msg['is_error'] === true ? str(msg['result']) : undefined;
      return { events: failed ? [{ type: 'error', message: failed }, { type: 'turn-end' }] : [{ type: 'turn-end' }] };
    }
    case 'stream_event': {
      const delta = asRecord(asRecord(msg['event'])?.['delta']);
      const text = delta?.['type'] === 'text_delta' ? str(delta['text']) : undefined;
      return { events: text === undefined ? [] : [{ type: 'text', delta: text }] };
    }
    case 'assistant': {
      const events: AgentUiEvent[] = [];
      for (const b of contentBlocks(msg)) {
        if (b['type'] !== 'tool_use') continue;
        const tool = str(b['name']) ?? '';
        events.push({ type: 'tool-start', id: str(b['id']) ?? '', tool, summary: summaryOf(tool, asRecord(b['input']) ?? {}) });
      }
      return { events };
    }
    case 'user': {
      const events: AgentUiEvent[] = [];
      for (const b of contentBlocks(msg)) {
        if (b['type'] !== 'tool_result') continue;
        const ok = b['is_error'] !== true;
        const detail = ok ? undefined : failureTail(b['content']);
        events.push({ type: 'tool-end', id: str(b['tool_use_id']) ?? '', ok, ...(detail === undefined ? {} : { detail }) });
      }
      return { events };
    }
    case 'control_request': {
      const req = asRecord(msg['request']);
      if (req?.['subtype'] !== 'can_use_tool') return { events: [] };
      const input = asRecord(req['input']) ?? {};
      const tool = str(req['tool_name']) ?? '';
      return { events: [], permission: { requestId: str(msg['request_id']) ?? '', ask: toAsk(str(req['tool_use_id']) ?? '', tool, input), input } };
    }
    default:
      return { events: [] };
  }
}
