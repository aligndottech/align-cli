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

// Read and parse the JSON payload Claude Code pipes to a hook command on stdin
// (hook_event_name, tool_name, tool_input). Returns null when there is no piped
// payload - a TTY (manual `align check --advisory` run), empty stdin, or invalid
// JSON - so callers fall back to their non-hook behaviour.
export async function readHookPayload(
  stream: Readable & { isTTY?: boolean } = process.stdin,
): Promise<HookPayload | null> {
  if (stream.isTTY) return null;
  const raw = await readAll(stream).catch(() => '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as HookPayload;
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
