import { describe, expect, it } from 'vitest';
import { mcpChildEnv } from '../lib/launch/mcp-child-env.js';
import { syncChildEnv } from '../lib/sync/spawn-background.js';
import { ENV_FIELDS, fieldEnvName, tokenEnvName } from '../lib/token-env.js';
import { KNOWN_SOURCES } from '../lib/sync/source-ids.js';

const credentialNames = [
  ...KNOWN_SOURCES.map(tokenEnvName),
  ...Object.entries(ENV_FIELDS).flatMap(([source, fields]) => fields.map((f) => fieldEnvName(source, f))),
];

describe('the background sync child keeps what the credential store and the environment tokens need', () => {
  it.each(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'ALIGN_TOKEN_STORE'])('passes %s', (name) => {
    const env = syncChildEnv({ PATH: '/usr/bin', [name]: name === 'ALIGN_TOKEN_STORE' ? 'file' : '/run/user/1000/bus' });
    expect(env[name]).toBe(name === 'ALIGN_TOKEN_STORE' ? 'file' : '/run/user/1000/bus');
  });

  it('passes every ALIGN_<SOURCE>_TOKEN, _EMAIL and _DOMAIN, so an environment token keeps syncing', () => {
    const input = Object.fromEntries(credentialNames.map((n) => [n, `value-of-${n}`]));
    const out = syncChildEnv({ PATH: '/usr/bin', ...input });
    for (const n of credentialNames) expect(out[n]).toBe(`value-of-${n}`);
    // Positive control: the list really is the eight sources and the five extra fields.
    expect(credentialNames).toHaveLength(8 + 5);
  });

  it('still drops unrelated variables, and the cloud token', () => {
    const out = syncChildEnv({ PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', ALIGN_TOKEN: 'z', ALIGN_LLM_API_KEY: 'k', SSH_AUTH_SOCK: '/tmp/agent' });
    expect(out).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toHaveProperty('GITHUB_TOKEN');
    expect(out).not.toHaveProperty('ALIGN_TOKEN');
    expect(out).not.toHaveProperty('ALIGN_LLM_API_KEY');
    expect(out).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('omits an empty value', () => {
    expect(syncChildEnv({ PATH: '/usr/bin', ALIGN_GITHUB_TOKEN: '' })).not.toHaveProperty('ALIGN_GITHUB_TOKEN');
  });
});

describe('an agent-spawned MCP server never inherits a connector credential from a repo .env', () => {
  it('blanks every ALIGN_<SOURCE>_TOKEN, _EMAIL and _DOMAIN, whatever the environment holds', () => {
    const poisoned = Object.fromEntries(credentialNames.map((n) => [n, n.endsWith('_DOMAIN') ? 'evil.example' : 'x']));
    const block = mcpChildEnv(poisoned);
    for (const n of credentialNames) {
      expect(Object.hasOwn(block, n), `${n} is pinned in the block`).toBe(true);
      expect(block[n]).toBe('');
    }
  });

  it('names exactly the names the sync child forwards, from one list', () => {
    const block = mcpChildEnv({});
    for (const n of credentialNames) expect(Object.keys(block)).toContain(n);
  });
});
