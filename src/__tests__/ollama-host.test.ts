import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ollamaBaseUrl } from '../lib/ollama-host.js';
import { noProviderHintInline, noProviderHintLines, probeOllama } from '../lib/local-llm.js';

/**
 * A user's shell had OLLAMA_HOST=127.0.0.1:11434, which Ollama's own client reads as
 * http://127.0.0.1:11434. align built `127.0.0.1:11434/api/tags`, fetch threw, and the
 * result was "Ollama is not running" while it was. The rules below are Ollama's
 * (envconfig.Host in ollama/ollama): no "://" means http, a missing port means 11434 when
 * there is no scheme (80 for http://, 443 for https://), an empty host means 127.0.0.1,
 * and a path keeps its text minus the trailing slash.
 */
describe('ollamaBaseUrl', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'http://localhost:11434'],
    ['', 'http://localhost:11434'],
    ['   ', 'http://localhost:11434'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost:8080', 'http://localhost:8080'],
    ['myhost', 'http://myhost:11434'],
    ['0.0.0.0', 'http://0.0.0.0:11434'],
    ['0.0.0.0:9999', 'http://0.0.0.0:9999'],
    ['http://box:11434', 'http://box:11434'],
    ['http://box:11434/', 'http://box:11434'],
    ['http://box', 'http://box:80'],
    ['https://ollama.example.com', 'https://ollama.example.com:443'],
    ['https://ollama.example.com:8443/', 'https://ollama.example.com:8443'],
    ['http://box:1/proxy/', 'http://box:1/proxy'],
    ['[::1]', 'http://[::1]:11434'],
    ['::1', 'http://[::1]:11434'],
    ['[::1]:9', 'http://[::1]:9'],
    ['box:99999', 'http://box:11434'],
    ['  box:5  ', 'http://box:5'],
    // user:pass@ and ?query are dropped, as Ollama's client drops what it does not use
    ['http://u:p@box:11434', 'http://box:11434'],
    ['http://box:7?token=x', 'http://box:7'],
    ['box:11434#frag', 'http://box:11434'],
  ];
  it.each(cases)('%j -> %s', (raw, want) => {
    expect(ollamaBaseUrl(raw)).toBe(want);
  });
});

describe('every reader of OLLAMA_HOST goes through it', () => {
  const mockFetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'qwen2.5:7b' }] }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('probeOllama reaches a bare host:port as http', async () => {
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:11434');
    expect(await probeOllama()).toBe('qwen2.5:7b');
    expect(String(mockFetch.mock.calls[0]![0])).toBe('http://127.0.0.1:11434/api/tags');
  });

  // stubEnv(k, '') is NOT unset: the two must both land on the default.
  it.each([['empty string', ''], ['unset', undefined]])('%s falls back to the default host', async (_n, v) => {
    vi.stubEnv('OLLAMA_HOST', v);
    await probeOllama();
    expect(String(mockFetch.mock.calls[0]![0])).toBe('http://localhost:11434/api/tags');
  });
});

describe('the error names the host that was tried', () => {
  it('never prints a user name, a password or a query from OLLAMA_HOST', () => {
    vi.stubEnv('OLLAMA_HOST', 'http://bob:hunter2@box:7777/?token=sekret');
    const all = [noProviderHintInline('x'), noProviderHintLines().join('\n')].join('\n');
    expect(all).toContain('http://box:7777');
    for (const secret of ['bob', 'hunter2', 'sekret']) expect(all).not.toContain(secret);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('inline and block hints carry the OLLAMA_HOST value when it is set', () => {
    vi.stubEnv('OLLAMA_HOST', 'box:7777');
    expect(noProviderHintInline('x')).toContain('OLLAMA_HOST=box:7777');
    expect(noProviderHintInline('x')).toContain('http://box:7777');
    expect(noProviderHintLines().join('\n')).toContain('OLLAMA_HOST=box:7777');
  });

  it('says nothing about OLLAMA_HOST when it is unset or empty', () => {
    for (const v of [undefined, '']) {
      vi.stubEnv('OLLAMA_HOST', v);
      expect(noProviderHintInline('x')).not.toContain('OLLAMA_HOST');
      expect(noProviderHintLines().join('\n')).not.toContain('OLLAMA_HOST');
    }
  });
});
