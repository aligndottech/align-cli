// ALI-1494: an opt-in LOCAL trace of the chat calls align makes.
//
// Off unless ALIGN_LLM_TRACE_FILE names a file. When on, `callChatDetailed` appends one JSON
// line per call to that file: the system prompt, the user prompt as built, how long it took and
// the answer or the failure kind. It is written to that file and nowhere else, never sent, and
// adds no network call - the promise in docs/telemetry.md (no queries or content leave the
// machine) is unchanged. API keys are never part of a row: a row is built from fixed fields,
// not from the request.
//
// The file holds prompts, which can hold the text of the user's decisions, so it is created
// readable by its owner only (0600). That mode applies when the file is created; an existing
// file keeps whatever mode it already has.
//
// A failed write never breaks the call it describes: it prints one line to stderr and moves on.

import { appendFileSync } from 'node:fs';

export const TRACE_FILE_ENV = 'ALIGN_LLM_TRACE_FILE';

export function traceFilePath(env: Record<string, string | undefined> = process.env): string | null {
  const configured = env[TRACE_FILE_ENV]?.trim();
  return configured ? configured : null;
}

export interface ChatTraceRow {
  kind: 'chat';
  system: string;
  user: string | null;
  ok: boolean;
  text?: string;
  failure?: { kind: string };
  durationMs: number;
}

export function appendChatTrace(row: ChatTraceRow, env: Record<string, string | undefined> = process.env): void {
  const path = traceFilePath(env);
  if (path === null) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    console.error(`align: could not write ${TRACE_FILE_ENV} (${path}): ${(err as Error).message}`);
  }
}
