import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFilesRecursive, sortByMtimeDesc } from '../fs-scan.js';
import type { CanonicalSession, SessionAdapter, SessionTurn } from '../types.js';

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    session_id?: string;
    cwd?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    // custom_tool_call: the field that actually links a call to its output is call_id, not
    // this record's own `id` (confirmed against a real captured session - see fixture README).
    call_id?: string;
    name?: string;
    input?: unknown;
    output?: Array<{ type?: string; text?: string }>;
  };
}

function parseLine(raw: string): CodexLine | null {
  try {
    return JSON.parse(raw) as CodexLine;
  } catch {
    return null;
  }
}

function peekMeta(filePath: string): { sessionId: string | null; cwd: string | null } {
  const firstLine = readFileSync(filePath, 'utf8').split('\n').find(l => l.trim());
  if (!firstLine) return { sessionId: null, cwd: null };
  const line = parseLine(firstLine);
  if (line?.type !== 'session_meta') return { sessionId: null, cwd: null };
  return { sessionId: line.payload?.session_id ?? null, cwd: line.payload?.cwd ?? null };
}

/** No per-project directory at all - codex partitions purely by date (YYYY/MM/DD), so
 *  every adapter here has to scan and match by content regardless of tree shape. */
export function locateSessionFilesUnder(sessionsRoot: string, cwd: string): string[] {
  const files = findFilesRecursive(sessionsRoot, /\.jsonl$/);
  return sortByMtimeDesc(files.filter(f => peekMeta(f).cwd === cwd));
}

function joinText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return '';
  return content.filter(b => typeof b.text === 'string').map(b => b.text).join('\n');
}

function parseCodexSession(filePath: string): CanonicalSession | null {
  const text = readFileSync(filePath, 'utf8');
  const turns: SessionTurn[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let pendingResults: Record<string, string> = {};

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const line = parseLine(rawLine);
    if (!line) continue;

    if (line.type === 'session_meta') {
      sessionId ??= line.payload?.session_id ?? null;
      cwd ??= line.payload?.cwd ?? null;
      continue;
    }
    if (line.type !== 'response_item') continue;
    const payload = line.payload;

    if (payload?.type === 'custom_tool_call' && typeof payload.call_id === 'string' && typeof payload.name === 'string') {
      // Attaches to the NEXT turn built (matches the pattern in pi.ts): codex records a
      // tool call as its own response_item, not nested inside a message.
      turns.push({
        role: 'assistant', text: '', toolCalls: [{ id: payload.call_id, name: payload.name, arguments: payload.input }],
        toolResults: {}, timestamp: line.timestamp ?? null,
      });
      continue;
    }
    if (payload?.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
      pendingResults[payload.call_id] = joinText(payload.output);
      continue;
    }
    if (payload?.type !== 'message') continue;
    const role = payload.role;
    // developer = Codex's own system-prompt boilerplate, not a real turn.
    if (role !== 'user' && role !== 'assistant') continue;

    turns.push({ role, text: joinText(payload.content), toolCalls: [], toolResults: pendingResults, timestamp: line.timestamp ?? null });
    pendingResults = {};
  }

  if (Object.keys(pendingResults).length > 0 && turns.length > 0) {
    Object.assign(turns[turns.length - 1].toolResults, pendingResults);
  }

  if (!sessionId || turns.length === 0) return null;
  return { agent: 'codex', sessionId, cwd, turns };
}

export const codexAdapter: SessionAdapter = {
  agent: 'codex',
  fixtureVerified: true,
  locateSessionFiles(cwd: string): string[] {
    const root = join(homedir(), '.codex', 'sessions');
    return locateSessionFilesUnder(root, cwd);
  },
  parseSession: parseCodexSession,
};
