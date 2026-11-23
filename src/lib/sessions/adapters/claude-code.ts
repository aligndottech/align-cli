import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findFilesRecursive, readLines, sortByMtimeDesc } from '../fs-scan.js';
import type { CanonicalSession, SessionAdapter, SessionToolCall, SessionTurn } from '../types.js';

interface ClaudeCodeLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function parseLine(raw: string): ClaudeCodeLine | null {
  try {
    return JSON.parse(raw) as ClaudeCodeLine;
  } catch {
    return null;
  }
}

/** Reads just enough of the file to know which project it belongs to, without reading the
 *  whole thing - every message line carries `cwd`, so the first one that does is enough. The
 *  lines before it (a summary, a file-history snapshot) carry none: at most 8 of them across
 *  2,507 real sessions, so this is a loop and not a look at line one. */
function peekCwd(filePath: string): string | null {
  for (const rawLine of readLines(filePath)) {
    if (!rawLine.trim()) continue;
    const line = parseLine(rawLine);
    if (line?.cwd) return line.cwd;
  }
  return null;
}

export function locateSessionFilesUnder(sessionsRoot: string, cwd: string): string[] {
  const files = findFilesRecursive(sessionsRoot, /\.jsonl$/);
  const matching = files.filter(f => peekCwd(f) === cwd);
  return sortByMtimeDesc(matching);
}

function turnFromLine(line: ClaudeCodeLine): SessionTurn | null {
  const role = line.message?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = line.message?.content;
  let text = '';
  const toolCalls: SessionToolCall[] = [];
  const toolResults: Record<string, string> = {};

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        text += (text ? '\n' : '') + b['text'];
      } else if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        toolCalls.push({ id: b['id'], name: b['name'], arguments: b['input'] });
      } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        const resultContent = b['content'];
        toolResults[b['tool_use_id']] = typeof resultContent === 'string'
          ? resultContent
          : JSON.stringify(resultContent);
      }
    }
  }

  return { role, text, toolCalls, toolResults, timestamp: line.timestamp ?? null };
}

function parseClaudeCodeSession(filePath: string): CanonicalSession | null {
  const text = readFileSync(filePath, 'utf8');
  const turns: SessionTurn[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;

  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const line = parseLine(rawLine);
    if (!line) continue;
    sessionId ??= line.sessionId ?? null;
    cwd ??= line.cwd ?? null;
    const turn = turnFromLine(line);
    if (turn) turns.push(turn);
  }

  if (!sessionId || turns.length === 0) return null;
  return { agent: 'claude-code', sessionId, cwd, turns };
}

export const claudeCodeAdapter: SessionAdapter = {
  agent: 'claude-code',
  fixtureVerified: true,
  locateSessionFiles(cwd: string): string[] {
    const root = join(homedir(), '.claude', 'projects');
    return locateSessionFilesUnder(root, cwd);
  },
  parseSession: parseClaudeCodeSession,
};
