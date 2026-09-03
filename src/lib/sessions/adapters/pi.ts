import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFilesRecursive, sortByMtimeDesc } from '../fs-scan.js';
import type { CanonicalSession, SessionAdapter, SessionToolCall, SessionTurn } from '../types.js';

interface PiLine {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
  };
}

function parseLine(raw: string): PiLine | null {
  try {
    return JSON.parse(raw) as PiLine;
  } catch {
    return null;
  }
}

/** Only pi's first line (`type: "session"`) carries cwd - unlike Claude Code, later lines
 *  do not repeat it, so this only needs to look at the first parseable line. */
function peekCwd(filePath: string): string | null {
  const firstLine = readFileSync(filePath, 'utf8').split('\n').find(l => l.trim());
  if (!firstLine) return null;
  return parseLine(firstLine)?.cwd ?? null;
}

export function locateSessionFilesUnder(sessionsRoot: string, cwd: string): string[] {
  const files = findFilesRecursive(sessionsRoot, /\.jsonl$/);
  return sortByMtimeDesc(files.filter(f => peekCwd(f) === cwd));
}

function extractText(content: unknown): { text: string; toolCalls: SessionToolCall[] } {
  let text = '';
  const toolCalls: SessionToolCall[] = [];
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        text += (text ? '\n' : '') + b['text'];
      } else if (b['type'] === 'toolCall' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        toolCalls.push({ id: b['id'], name: b['name'], arguments: b['arguments'] });
      }
    }
  }
  return { text, toolCalls };
}

/** pi's toolResult text lives in a `content: [{type:'text', text}]` array on its own
 *  message, same shape as a user/assistant message's text blocks. */
function extractResultText(content: unknown): string {
  return extractText(content).text;
}

function parsePiSession(filePath: string): CanonicalSession | null {
  const text = readFileSync(filePath, 'utf8');
  const turns: SessionTurn[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  // toolResult lines are their own top-level pi message (role: 'toolResult'), not nested
  // inside the next user/assistant turn the way Claude Code embeds a tool_result block -
  // so a pending result is carried forward and merged into whichever real turn comes next.
  let pendingResults: Record<string, string> = {};

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const line = parseLine(rawLine);
    if (!line) continue;

    if (line.type === 'session') {
      sessionId ??= line.id ?? null;
      cwd ??= line.cwd ?? null;
      continue;
    }
    if (line.type !== 'message') continue;

    const role = line.message?.role;
    if (role === 'toolResult' && typeof line.message?.toolCallId === 'string') {
      pendingResults[line.message.toolCallId] = extractResultText(line.message.content);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;

    const { text: turnText, toolCalls } = extractText(line.message?.content);
    turns.push({ role, text: turnText, toolCalls, toolResults: pendingResults, timestamp: line.timestamp ?? null });
    pendingResults = {};
  }

  // A pi transcript ending immediately after a toolResult (nothing to attach it to yet) -
  // fold it onto the last turn rather than dropping it.
  if (Object.keys(pendingResults).length > 0 && turns.length > 0) {
    Object.assign(turns[turns.length - 1].toolResults, pendingResults);
  }

  if (!sessionId || turns.length === 0) return null;
  return { agent: 'pi', sessionId, cwd, turns };
}

export const piAdapter: SessionAdapter = {
  agent: 'pi',
  fixtureVerified: true,
  locateSessionFiles(cwd: string): string[] {
    const root = join(homedir(), '.pi', 'agent', 'sessions');
    return locateSessionFilesUnder(root, cwd);
  },
  parseSession: parsePiSession,
};
