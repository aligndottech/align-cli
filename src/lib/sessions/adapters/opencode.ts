import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalSession, SessionAdapter, SessionToolCall, SessionTurn } from '../types.js';

/** opencode stores every session in one shared SQLite database, so a "session file" here is
 *  a composite `<dbPath>#<sessionId>` identifier rather than a real file - the split point
 *  every function in this module agrees on. */
function splitCompositeId(id: string): { dbPath: string; sessionId: string } | null {
  const hash = id.indexOf('#');
  if (hash === -1) return null;
  return { dbPath: id.slice(0, hash), sessionId: id.slice(hash + 1) };
}

export function locateSessionFilesUnder(dbPath: string, cwd: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      'SELECT id FROM session WHERE directory = ? ORDER BY time_created DESC',
    ).all(cwd) as Array<{ id: string }>;
    return rows.map(r => `${dbPath}#${r.id}`);
  } finally {
    db.close();
  }
}

interface MessageData {
  role?: string;
}

interface PartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
}

function parsePart(raw: string): PartData | null {
  try {
    return JSON.parse(raw) as PartData;
  } catch {
    return null;
  }
}

function parseOpencodeSession(compositeId: string): CanonicalSession | null {
  const split = splitCompositeId(compositeId);
  if (!split) return null;
  const { dbPath, sessionId } = split;
  if (!existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessionRow = db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId) as { directory: string } | undefined;
    if (!sessionRow) return null;

    const messages = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created',
    ).all(sessionId) as Array<{ id: string; data: string }>;

    const turns: SessionTurn[] = [];
    for (const msg of messages) {
      let msgData: MessageData;
      try {
        msgData = JSON.parse(msg.data) as MessageData;
      } catch {
        continue;
      }
      const role = msgData.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const parts = db.prepare(
        'SELECT data FROM part WHERE message_id = ? ORDER BY time_created',
      ).all(msg.id) as Array<{ data: string }>;

      let text = '';
      const toolCalls: SessionToolCall[] = [];
      const toolResults: Record<string, string> = {};
      for (const partRow of parts) {
        const part = parsePart(partRow.data);
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          text += (text ? '\n' : '') + part.text;
        } else if (part.type === 'tool' && typeof part.callID === 'string' && typeof part.tool === 'string') {
          // Unlike the JSONL agents, opencode records a call and its result in ONE row
          // (state.input / state.output) - no separate pending-result step needed.
          toolCalls.push({ id: part.callID, name: part.tool, arguments: part.state?.input });
          const output = part.state?.output;
          if (output !== undefined) {
            toolResults[part.callID] = typeof output === 'string' ? output : JSON.stringify(output);
          }
        }
        // step-start / step-finish / reasoning: internal bookkeeping, not a turn's content.
      }

      turns.push({ role, text, toolCalls, toolResults, timestamp: null });
    }

    if (turns.length === 0) return null;
    return { agent: 'opencode', sessionId, cwd: sessionRow.directory, turns };
  } finally {
    db.close();
  }
}

export const opencodeAdapter: SessionAdapter = {
  agent: 'opencode',
  fixtureVerified: true,
  locateSessionFiles(cwd: string): string[] {
    const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
    return locateSessionFilesUnder(dbPath, cwd);
  },
  parseSession: parseOpencodeSession,
};
