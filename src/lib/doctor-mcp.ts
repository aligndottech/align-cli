/**
 * ALI-1740: the one real `tools/call` `align doctor` makes, through the same `align mcp` an agent
 * would start, spawned the way an agent's config spawns it (alignServerEntry, so on Windows that is
 * `cmd /c align mcp`, the form a client can actually launch).
 *
 * The child gets ALIGN_DOCTOR=1 (telemetry-env.ts DOCTOR_ENV), which the telemetry gate reads as "send
 * nothing, store nothing": without it the server's own first-useful-answer ping would leave the
 * machine. It is not DO_NOT_TRACK, because an env opt-out is stored as a permanent opt-out in the
 * user's config and a preflight must not change a stored choice.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { alignServerEntry } from './mcp-setup.js';
import { DOCTOR_ENV } from './telemetry-env.js';
import pkg from '../../package.json' with { type: 'json' };

export const DOCTOR_QUESTION = 'What decisions have been made about this project?';
export const ASK_TIMEOUT_MS = 60_000;
/** A local graph's first question may download and start the embedding model. */
export const LOCAL_ASK_TIMEOUT_MS = 180_000;

export async function askViaMcp(alignBin: string, envName: string, timeoutMs: number = ASK_TIMEOUT_MS): Promise<{ text: string }> {
  const entry = alignServerEntry('mcpServers', envName, { trustedBin: alignBin }) as { command: string; args: string[] };
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') childEnv[k] = v;
  childEnv[DOCTOR_ENV] = '1';

  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: childEnv, stderr: 'pipe' });
  let stderrTail = '';
  const client = new Client({ name: 'align-doctor', version: pkg.version });
  // Before connect: a server that dies at startup says why on stderr, and the SDK drops what arrives before a listener.
  transport.stderr?.on('data', (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-400); });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const result = await client.callTool({ name: 'align_ask', arguments: { question: DOCTOR_QUESTION } }, undefined, { timeout: timeoutMs });
    const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (result.isError === true) throw new Error(text.trim() || 'the tool call reported an error with no message');
    return { text };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(stderrTail.trim() && /closed|exit/i.test(m) ? `${m} (align mcp said: ${stderrTail.trim().split('\n').pop()})` : m);
  } finally {
    await client.close().catch(() => undefined);
  }
}
