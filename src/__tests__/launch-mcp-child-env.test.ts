import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHILD_ENV_KEYS, CHILD_ENV_NOT_PINNED, CHILD_ENV_SECRETS, classifyChildEnv, isCanonicalChildEnv, mcpChildEnv } from '../lib/launch/mcp-child-env.js';

/*
 * cn and Cline hand their MCP children the agent's whole environment, and both load a repo
 * `.env` into it (Cline's long-lived hub inherits the `.env` of the repo it was first started in).
 * Seen with a stand-in server dumping its env: NODE_OPTIONS=--require ./x.js, NODE_PATH,
 * ALIGN_LLM_BASE_URL and a provider key from the repo all reached `align mcp`. So the align-local
 * entry carries an explicit `env` block that names each variable align reads and sets it: the
 * user's own value, or empty (which every align reader treats as unset). Secrets are always
 * empty: a key is never written into an agent's config file.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('mcpChildEnv: the block', () => {
  it('covers XDG_*, NODE_OPTIONS, NODE_PATH, every ALIGN_* align reads, and every provider key', () => {
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'NODE_OPTIONS', 'NODE_PATH', 'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_PROVIDER', 'ALIGN_ENV', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ALIGN_TOKEN']) {
      expect(CHILD_ENV_KEYS, k).toContain(k);
    }
    expect(Object.keys(mcpChildEnv({})).sort()).toEqual([...CHILD_ENV_KEYS].sort());
  });
  it('unset: every value empty', () => {
    expect(Object.values(mcpChildEnv({})).every((v) => v === '')).toBe(true);
  });
  it('the user\'s own non-secret values are kept; an absolute XDG is kept, a relative one is not', () => {
    const e = mcpChildEnv({ ALIGN_ENV: 'local', ALIGN_LLM_BASE_URL: 'http://127.0.0.1:1234', XDG_CONFIG_HOME: path.resolve('/c'), XDG_DATA_HOME: './d', CI: 'true' });
    expect(e['ALIGN_ENV']).toBe('local');
    expect(e['CI']).toBe('true');
    expect(mcpChildEnv({})['CI']).toBe('');
    expect(e['ALIGN_LLM_BASE_URL']).toBe('http://127.0.0.1:1234');
    expect(e['XDG_CONFIG_HOME']).toBe(path.resolve('/c'));
    expect(e['XDG_DATA_HOME']).toBe('');
  });
  it('NODE_OPTIONS and NODE_PATH are always empty, even when the user has them', () => {
    const e = mcpChildEnv({ NODE_OPTIONS: '--max-old-space-size=4096', NODE_PATH: '/x' });
    expect([e['NODE_OPTIONS'], e['NODE_PATH']]).toEqual(['', '']);
  });
  it('secrets are always empty: a key is never written into an agent config (two examples)', () => {
    const e = mcpChildEnv({ ANTHROPIC_API_KEY: 'sk-real', ALIGN_TOKEN: 'tok', ALIGN_LLM_API_KEY: 'k' });
    expect([e['ANTHROPIC_API_KEY'], e['ALIGN_TOKEN'], e['ALIGN_LLM_API_KEY']]).toEqual(['', '', '']);
    expect(CHILD_ENV_SECRETS).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ALIGN_TOKEN', 'ALIGN_LLM_API_KEY']));
  });
});

describe('isCanonicalChildEnv: a re-run reads the written block as Align\'s own', () => {
  it('accepts the block it writes (any of the user\'s own values) and an older, smaller key set Align wrote', () => {
    expect(isCanonicalChildEnv(mcpChildEnv({ ALIGN_ENV: 'local' }))).toBe(true);
    expect(isCanonicalChildEnv(mcpChildEnv({}))).toBe(true);
    const { ALIGN_LLM_BASE_URL: _drop, ...partial } = mcpChildEnv({});
    expect(isCanonicalChildEnv(partial)).toBe(true);
  });
  it('refuses a key outside the block, a non-empty secret, a non-empty NODE_OPTIONS, a relative XDG, or a non-string', () => {
    expect(isCanonicalChildEnv({ ...mcpChildEnv({}), EXTRA: '1' })).toBe(false);
    expect(isCanonicalChildEnv({ ...mcpChildEnv({}), ANTHROPIC_API_KEY: 'x' })).toBe(false);
    expect(isCanonicalChildEnv({ ...mcpChildEnv({}), NODE_OPTIONS: '--require ./x.js' })).toBe(false);
    expect(isCanonicalChildEnv({ ...mcpChildEnv({}), XDG_CONFIG_HOME: './evil' })).toBe(false);
    expect(isCanonicalChildEnv({ ...mcpChildEnv({}), ALIGN_ENV: 1 })).toBe(false);
    expect(isCanonicalChildEnv([])).toBe(false);
  });
});

describe('parity: every ALIGN_* variable src/ reads from the environment is in the block', () => {
  it('a source read of process.env[\'ALIGN_X\'] / env[\'ALIGN_X\'] / env.ALIGN_X, outside tests, is covered', () => {
    const out = execFileSync('git', ['grep', '-ohE', String.raw`(process\.env|env)(\[['"]|\.)ALIGN_[A-Z0-9_]+`, '--', '.', ':(exclude)__tests__'], { cwd: SRC, encoding: 'utf8' });
    const read = [...new Set(out.split('\n').map((l) => /ALIGN_[A-Z0-9_]+/.exec(l)?.[0]).filter((v): v is string => Boolean(v)))];
    // Positive control: the scan finds names known to be read.
    expect(read).toEqual(expect.arrayContaining(['ALIGN_ENV', 'ALIGN_LLM_BASE_URL', 'ALIGN_WRAPPED']));
    expect(read.filter((v) => !CHILD_ENV_KEYS.includes(v))).toEqual([]);
  });
});

describe('the block also covers where Align sends data and what code or trust it loads', () => {
  const NAMES = ['OLLAMA_HOST', 'OLLAMA_CONTEXT_LENGTH', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
    'NODE_REPL_EXTERNAL_MODULE', 'NODE_DEBUG', 'NODE_PRESERVE_SYMLINKS'];
  it.each(NAMES)('%s is in the block', (k) => {
    expect(CHILD_ENV_KEYS).toContain(k);
  });
  it('code and trust switches are always empty, even when the user has them (LD_*, DYLD_*, NODE_TLS_REJECT_UNAUTHORIZED, NODE_REPL_EXTERNAL_MODULE)', () => {
    const e = mcpChildEnv({ LD_PRELOAD: '/x.so', LD_LIBRARY_PATH: '/l', DYLD_INSERT_LIBRARIES: '/d', DYLD_LIBRARY_PATH: '/d', DYLD_FRAMEWORK_PATH: '/f', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_REPL_EXTERNAL_MODULE: '/m' });
    expect(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE'].map((k) => e[k])).toEqual(['', '', '', '', '', '', '']);
  });
  it('a corporate proxy and CA bundle the user set are kept: proxies, NO_PROXY, an absolute CA path', () => {
    const e = mcpChildEnv({ HTTPS_PROXY: 'http://proxy.corp:8080', no_proxy: 'localhost,.corp', NODE_EXTRA_CA_CERTS: path.resolve('/etc/ca.pem'), SSL_CERT_DIR: path.resolve('/etc/ssl'), NODE_USE_ENV_PROXY: '1' });
    expect([e['HTTPS_PROXY'], e['no_proxy'], e['NODE_EXTRA_CA_CERTS'], e['SSL_CERT_DIR'], e['NODE_USE_ENV_PROXY']]).toEqual(['http://proxy.corp:8080', 'localhost,.corp', path.resolve('/etc/ca.pem'), path.resolve('/etc/ssl'), '1']);
  });
  it('a relative CA path is not kept', () => {
    expect(mcpChildEnv({ NODE_EXTRA_CA_CERTS: './ca.pem', SSL_CERT_FILE: 'ca.pem' })).toMatchObject({ NODE_EXTRA_CA_CERTS: '', SSL_CERT_FILE: '' });
  });
  it('a URL carrying a user name, a password or a query string is a secret: empty (proxy, OLLAMA_HOST, ALIGN_LLM_BASE_URL)', () => {
    const e = mcpChildEnv({ HTTPS_PROXY: 'http://bob:pw@proxy:8080', OLLAMA_HOST: 'http://h:11434/?token=x', ALIGN_LLM_BASE_URL: 'https://u:p@llm.example/v1', ALIGN_GATEWAY_URL: 'https://gw.example/?key=1' });
    expect([e['HTTPS_PROXY'], e['OLLAMA_HOST'], e['ALIGN_LLM_BASE_URL'], e['ALIGN_GATEWAY_URL']]).toEqual(['', '', '', '']);
    expect(mcpChildEnv({ OLLAMA_HOST: 'http://127.0.0.1:11434' })['OLLAMA_HOST']).toBe('http://127.0.0.1:11434');
  });
});

describe('parity: every non-ALIGN variable src/ reads is in the block or knowingly left out', () => {
  it('a new read fails here until it is pinned or listed with a reason', () => {
    const out = execFileSync('git', ['grep', '-ohE', String.raw`(process\.env|env)(\[['"]|\.)[A-Z][A-Za-z0-9_]*`, '--', '.', ':(exclude)__tests__'], { cwd: SRC, encoding: 'utf8' });
    const read = [...new Set(out.split('\n').map((l) => /([A-Z][A-Za-z0-9_]*)$/.exec(l)?.[1]).filter((v): v is string => Boolean(v)))].filter((v) => !v.startsWith('ALIGN_'));
    // Positive control: the scan sees reads known to exist.
    expect(read).toEqual(expect.arrayContaining(['OLLAMA_HOST', 'XDG_CONFIG_HOME', 'HOME']));
    expect(read.filter((v) => !CHILD_ENV_KEYS.includes(v) && !Object.hasOwn(CHILD_ENV_NOT_PINNED, v))).toEqual([]);
  });
});

describe('classifyChildEnv: current, stale (Align\'s own, to refresh) or foreign', () => {
  const now = { ALIGN_ENV: 'local' };
  it('the block written today is current', () => {
    expect(classifyChildEnv(mcpChildEnv(now), now)).toEqual({ kind: 'current' });
  });
  it('an older key set (a subset, canonical values) is stale; so is a block whose values have since changed', () => {
    const { OLLAMA_HOST: _a, LD_PRELOAD: _b, ...older } = mcpChildEnv(now);
    expect(classifyChildEnv(older, now)).toEqual({ kind: 'stale' });
    expect(classifyChildEnv(mcpChildEnv({ ALIGN_ENV: 'prod' }), now)).toEqual({ kind: 'stale' });
  });
  it('a foreign key, a non-empty secret or LD_PRELOAD, or a credentialed URL is foreign, naming the key', () => {
    expect(classifyChildEnv({ ...mcpChildEnv(now), EVIL: '1' }, now)).toEqual({ kind: 'foreign', key: 'EVIL' });
    expect(classifyChildEnv({ ...mcpChildEnv(now), LD_PRELOAD: '/x.so' }, now)).toEqual({ kind: 'foreign', key: 'LD_PRELOAD' });
    expect(classifyChildEnv({ ...mcpChildEnv(now), ALIGN_LLM_BASE_URL: 'https://u:p@x/' }, now)).toEqual({ kind: 'foreign', key: 'ALIGN_LLM_BASE_URL' });
  });
});
