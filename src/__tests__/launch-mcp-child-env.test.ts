import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHILD_ENV_KEYS, CHILD_ENV_SECRETS, isCanonicalChildEnv, mcpChildEnv } from '../lib/launch/mcp-child-env.js';

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
    const e = mcpChildEnv({ ALIGN_ENV: 'local', ALIGN_LLM_BASE_URL: 'http://127.0.0.1:1234', XDG_CONFIG_HOME: path.resolve('/c'), XDG_DATA_HOME: './d' });
    expect(e['ALIGN_ENV']).toBe('local');
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
  it('accepts the block it writes (any of the user\'s own values); refuses a block missing a key', () => {
    expect(isCanonicalChildEnv(mcpChildEnv({ ALIGN_ENV: 'local' }))).toBe(true);
    expect(isCanonicalChildEnv(mcpChildEnv({}))).toBe(true);
    const { ALIGN_LLM_BASE_URL: _drop, ...partial } = mcpChildEnv({});
    expect(isCanonicalChildEnv(partial)).toBe(false);
    expect(isCanonicalChildEnv({ ALIGN_ENV: 'prod' })).toBe(false);
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
