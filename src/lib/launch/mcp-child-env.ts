import { NAMED_PROVIDERS, PROVIDER_ENV_VARS } from '../llm-providers.js';
import { absoluteXdg, XDG_VARS } from '../xdg.js';

/*
 * The `env` block of the align-local entry Align hands to an agent that loads a repo `.env`
 * (cn, Cline). Those agents spawn their MCP servers with their own environment, and that
 * environment holds the repo's `.env` (Cline's long-lived hub holds the `.env` of the repo it was
 * first started in). Seen with a stand-in server dumping its env: NODE_OPTIONS=--require ./x.js,
 * NODE_PATH, ALIGN_LLM_BASE_URL, OLLAMA_HOST, a proxy, a CA file, LD_PRELOAD and a provider key
 * from the repo all reached `align mcp`. An entry env block overrides the inherited value, and an
 * empty value is honoured (checked on cn 1.5.47 and Cline 3.0.70); every align reader treats empty
 * as unset.
 *
 * WHAT THIS COVERS, stated narrowly: the names below. A variable NOT named here (one align does
 * not read, or one listed in CHILD_ENV_NOT_PINNED) still reaches the server from a repo `.env`.
 */

/** Every ALIGN_* variable align reads from its environment (src/, outside tests). A parity test keeps this complete. */
const ALIGN_READS = [
  'ALIGN_DEBUG', 'ALIGN_ENV', 'ALIGN_GATEWAY_URL', 'ALIGN_HEAD_SHA', 'ALIGN_INGEST_CONCURRENCY', 'ALIGN_INTERNAL',
  'ALIGN_LAUNCH_DRY_RUN', 'ALIGN_LAUNCH_TRACE', 'ALIGN_LLM_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_PROVIDER',
  'ALIGN_LLM_TIMEOUT_MS', 'ALIGN_MODEL_CACHE', 'ALIGN_NO_LAUNCH', 'ALIGN_OLLAMA_MODEL', 'ALIGN_PLATFORM',
  'ALIGN_SUBJECT_KEY', 'ALIGN_TELEMETRY', 'ALIGN_TENANT_ID', 'ALIGN_TOKEN', 'ALIGN_WRAPPED',
] as const;

/**
 * Other variables align reads: where it sends data (local-llm.ts), and CI (telemetry-ci.ts: a
 * repo's CI=false would otherwise turn CI detection off, and with it telemetry's CI default).
 */
const OTHER_READS = ['OLLAMA_HOST', 'OLLAMA_CONTEXT_LENGTH', 'CI'] as const;

/** Where Node sends traffic, and which certificates it trusts: the user's own value is kept (a corporate proxy), unless credentialed. */
const NETWORK = [
  'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;
/** Certificate files: kept only as an absolute path. */
const CERT_PATHS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;
/** Node debug and module-resolution switches that change nothing about trust: the user's own value. */
const NODE_PLAIN = ['NODE_DEBUG', 'NODE_PRESERVE_SYMLINKS'] as const;

/** Code loading or trust switches: always empty, whatever the user has. */
const ALWAYS_EMPTY = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
];

/** Never written into an agent's config with a value: always empty in the block. */
export const CHILD_ENV_SECRETS: readonly string[] = [
  ...new Set([...NAMED_PROVIDERS.flatMap((p) => p.keyEnv), ...PROVIDER_ENV_VARS.filter((v) => /KEY|TOKEN|SECRET|PASSWORD/.test(v)), 'ALIGN_TOKEN', 'ALIGN_LLM_API_KEY']),
].sort();

export const CHILD_ENV_KEYS: readonly string[] = [
  ...new Set([...XDG_VARS, ...ALWAYS_EMPTY, ...ALIGN_READS, ...OTHER_READS, ...NETWORK, ...CERT_PATHS, ...NODE_PLAIN, ...PROVIDER_ENV_VARS, ...CHILD_ENV_SECRETS]),
].sort();

/**
 * Names src/ reads that are deliberately NOT in the block, each with the reason. The parity test
 * fails on a read that is in neither list.
 */
export const CHILD_ENV_NOT_PINNED: Record<string, string> = {
  HOME: 'always set for the agent, so a repo .env cannot set it',
  USERPROFILE: 'always set on Windows, so a repo .env cannot set it',
  APPDATA: 'always set on Windows',
  LOCALAPPDATA: 'always set on Windows',
  ProgramData: 'always set on Windows; read by the launcher only',
  PATH: 'always set; dotenv never overrides it',
  Path: 'Windows spelling of PATH; always set',
  PATHEXT: 'always set on Windows',
  NO_COLOR: 'output colour only',
  COLORTERM: 'output colour only',
  COLORFGBG: 'output colour only',
  DO_NOT_TRACK: 'can only turn telemetry off; not pinned because the first align run that sees it stores the opt-out (storeEnvOptOut), so a trimmed MCP env needs no copy',
  COPILOT_ALLOW_ALL: 'read by the launcher about Copilot, not by align mcp',
  GEMINI_RESTRICTED_MODE: 'read by the launcher about Gemini folder trust, not by align mcp',
  ...Object.fromEntries([
    'QWEN_CODE_SYSTEM_DEFAULTS_PATH', 'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'QWEN_CODE_TRUSTED_FOLDERS_PATH', 'QWEN_HOME',
    'GEMINI_CLI_SYSTEM_DEFAULTS_PATH', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'GEMINI_CLI_HOME',
    'GROK_HOME', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'KIRO_HOME', 'GOOSE_PATH_ROOT', 'GOOSE_BIN_DIR',
    'FACTORY_RUNTIME_SETTINGS_PATH', 'FACTORY_HOME_OVERRIDE', 'COPILOT_HOME', 'CONTINUE_GLOBAL_DIR', 'CODEX_HOME',
    'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH', 'AMP_SETTINGS_FILE',
  ].map((v) => [v, 'read by the launcher to find another agent\'s config, never by align mcp'])),
};

/** A URL value carrying a user name, a password or a query string: treated as a secret. */
function credentialedUrl(v: string): boolean {
  for (const candidate of [v, `http://${v}`]) {
    try {
      const u = new URL(candidate);
      return u.username !== '' || u.password !== '' || u.search !== '';
    } catch {
      // not a URL in this spelling: try the next
    }
  }
  return /@|\?/.test(v);
}

const isAbsolutePath = (v: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(v);

/** The value Align writes for one key, given the user's environment. */
function valueFor(k: string, env: Record<string, string | undefined>): string {
  if (CHILD_ENV_SECRETS.includes(k) || ALWAYS_EMPTY.includes(k)) return '';
  if ((XDG_VARS as readonly string[]).includes(k)) return absoluteXdg(env, k) ?? '';
  const v = env[k] ?? '';
  if (v === '') return '';
  if ((CERT_PATHS as readonly string[]).includes(k)) return isAbsolutePath(v) ? v : '';
  if (/^NO_PROXY$|^no_proxy$/.test(k)) return v;
  if (credentialedUrl(v) && (/URL|HOST|PROXY/i.test(k))) return '';
  return v;
}

/** The block: for each key, the user's own value under the rules above, or empty. */
export function mcpChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) out[k] = valueFor(k, env);
  return out;
}

/** A value Align could have written for this key, whatever the user's environment was then. */
function canonicalValue(k: string, val: unknown): boolean {
  if (typeof val !== 'string') return false;
  if (CHILD_ENV_SECRETS.includes(k) || ALWAYS_EMPTY.includes(k)) return val === '';
  if (val === '') return true;
  if ((XDG_VARS as readonly string[]).includes(k)) return absoluteXdg({ [k]: val }, k) !== undefined;
  if ((CERT_PATHS as readonly string[]).includes(k)) return isAbsolutePath(val);
  if (/URL|HOST|PROXY/i.test(k) && !/^NO_PROXY$|^no_proxy$/.test(k)) return !credentialedUrl(val);
  return true;
}

/**
 * Whether a block is Align's, and up to date:
 *  - current: today's key set, and today's values;
 *  - stale: Align's own (a subset of today's keys, every value one Align could write) but an older
 *    key set or values that have changed since: Align refreshes it;
 *  - foreign: a key Align never writes, or a value it never would: not Align's.
 */
export function classifyChildEnv(v: unknown, env: Record<string, string | undefined>): { kind: 'current' } | { kind: 'stale' } | { kind: 'foreign'; key: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'foreign', key: 'env' };
  for (const [k, val] of Object.entries(v)) {
    if (!CHILD_ENV_KEYS.includes(k) || !canonicalValue(k, val)) return { kind: 'foreign', key: k };
  }
  const today = mcpChildEnv(env);
  const same = Object.keys(v).length === CHILD_ENV_KEYS.length && CHILD_ENV_KEYS.every((k) => (v as Record<string, unknown>)[k] === today[k]);
  return same ? { kind: 'current' } : { kind: 'stale' };
}

/** A block Align could have written (current or stale). */
export function isCanonicalChildEnv(v: unknown): boolean {
  return classifyChildEnv(v, {}).kind !== 'foreign';
}
