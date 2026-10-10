import { NAMED_PROVIDERS, PROVIDER_ENV_VARS } from '../llm-providers.js';
import { absoluteXdg, XDG_VARS } from '../xdg.js';

/*
 * The `env` block of the align-local entry Align hands to an agent that loads a repo `.env`
 * (cn, Cline). Those agents spawn their MCP servers with their own environment, and that
 * environment holds the repo's `.env` (Cline's long-lived hub holds the `.env` of the repo it was
 * first started in). Seen with a stand-in server dumping its env: NODE_OPTIONS=--require ./x.js,
 * NODE_PATH, ALIGN_LLM_BASE_URL and a provider key from the repo all reached `align mcp`. An entry
 * env block overrides the inherited value, and an empty value is honoured (checked on cn 1.5.47
 * and Cline 3.0.70), and every align reader treats empty as unset.
 */

/** Every ALIGN_* variable align reads from its environment (src/, outside tests). A parity test keeps this complete. */
const ALIGN_READS = [
  'ALIGN_DEBUG', 'ALIGN_ENV', 'ALIGN_GATEWAY_URL', 'ALIGN_HEAD_SHA', 'ALIGN_INGEST_CONCURRENCY', 'ALIGN_INTERNAL',
  'ALIGN_LAUNCH_DRY_RUN', 'ALIGN_LAUNCH_TRACE', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_PROVIDER',
  'ALIGN_LLM_TIMEOUT_MS', 'ALIGN_MODEL_CACHE', 'ALIGN_NO_LAUNCH', 'ALIGN_OLLAMA_MODEL', 'ALIGN_PLATFORM',
  'ALIGN_SUBJECT_KEY', 'ALIGN_TELEMETRY', 'ALIGN_TENANT_ID', 'ALIGN_TOKEN', 'ALIGN_WRAPPED',
] as const;

/** Never written into an agent's config with a value: always empty in the block. */
export const CHILD_ENV_SECRETS: readonly string[] = [
  ...new Set([...NAMED_PROVIDERS.flatMap((p) => p.keyEnv), ...PROVIDER_ENV_VARS.filter((v) => /KEY|TOKEN/.test(v)), 'ALIGN_TOKEN', 'ALIGN_LLM_API_KEY']),
].sort();

/** Always empty: code execution (`--require`) or module lookup inside Align's server. */
const ALWAYS_EMPTY = ['NODE_OPTIONS', 'NODE_PATH'];

export const CHILD_ENV_KEYS: readonly string[] = [...new Set([...XDG_VARS, ...ALWAYS_EMPTY, ...ALIGN_READS, ...PROVIDER_ENV_VARS, ...CHILD_ENV_SECRETS])].sort();

/**
 * The block: for each key, the user's own value (an XDG one only when absolute), or empty.
 * Secrets, NODE_OPTIONS and NODE_PATH are always empty.
 */
export function mcpChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    if (CHILD_ENV_SECRETS.includes(k) || ALWAYS_EMPTY.includes(k)) out[k] = '';
    else if ((XDG_VARS as readonly string[]).includes(k)) out[k] = absoluteXdg(env, k) ?? '';
    else out[k] = env[k] ?? '';
  }
  return out;
}

/**
 * Exactly a block Align writes: every key of CHILD_ENV_KEYS and no other, string values, secrets
 * and NODE_* empty, any XDG value empty or absolute. A partial block would let the agent's own
 * (repo `.env`) value through for the missing key, so it is not Align's. When a key is added
 * later, this must also accept the previous key set, or entries written by older Aligns turn
 * into conflicts.
 */
export function isCanonicalChildEnv(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (Object.keys(v).length !== CHILD_ENV_KEYS.length) return false;
  for (const [k, val] of Object.entries(v)) {
    if (!CHILD_ENV_KEYS.includes(k) || typeof val !== 'string') return false;
    if ((CHILD_ENV_SECRETS.includes(k) || ALWAYS_EMPTY.includes(k)) && val !== '') return false;
    if ((XDG_VARS as readonly string[]).includes(k) && val !== '' && absoluteXdg({ [k]: val }, k) === undefined) return false;
  }
  return true;
}
