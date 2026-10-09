/**
 * `align ask` offers an AI key the first time it has nothing to write prose with - on a
 * terminal only, and only when nothing at all is available (no env key, no saved key, no
 * Ollama). "Nothing available" is read off synthesis's own `no_provider` result, which is
 * already decided after the chain's cheap Ollama probe, so the offer adds no probe of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// A real spinner on a forced TTY reaches for cursor control a test stdout does not have.
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop: vi.fn(), fail: vi.fn() }) }));
vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

const dismissed = vi.hoisted(() => ({ value: false }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ mode: 'local-embedded' })),
    getConnectorFields: vi.fn(() => null),
    isAskKeyOfferDismissed: () => dismissed.value,
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('local') }));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn() }));
vi.mock('../lib/git.js', () => ({
  getGitIdentities: async () => ({ email: null, name: null }),
  hasOtherCommitters: async () => false,
}));

const synthesiseDetailed = vi.hoisted(() => vi.fn());
vi.mock('../lib/local-llm.js', () => ({
  synthesiseDetailed,
  RECOMMENDED_OLLAMA_PULL: 'llama3.2',
  ABSTENTION_SENTINEL: '<<NO_ANSWER>>',
  isAbstention: () => false,
  explainAbstention: (t: string) => t,
  noProviderHintLines: () => ['No answer written: no LLM configured.'],
}));

const offerAskProviderKey = vi.hoisted(() => vi.fn());
vi.mock('../lib/ask-key-offer.js', () => ({ offerAskProviderKey }));

const searchDecisions = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions, listDecisions: vi.fn().mockResolvedValue([]) })),
}));

import { registerAskCommand } from '../commands/why.js';

const output: string[] = [];

async function ask(...extra: string[]) {
  output.length = 0;
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', 'why postgres', ...extra]);
  return output.join('\n');
}

const setTTY = (v: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
};

const NO_PROVIDER = { ok: false, failure: { kind: 'no_provider' } };

beforeEach(() => {
  dismissed.value = false;
  offerAskProviderKey.mockReset();
  synthesiseDetailed.mockReset();
  searchDecisions.mockResolvedValue({
    results: [{ id: '1', title: 'Chose Postgres', summary: 'for jsonb', platform: 'git', similarity: 0.8, source_url: null }],
    count: 1,
    strategy: 'semantic',
    scope: null,
  });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output.push(String(s)); return true; }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  setTTY(false);
});

describe('the first `align ask` with nothing configured, on a terminal', () => {
  it('offers the choice before answering, and "Not now" falls through to the ranked list', async () => {
    setTTY(true);
    synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
    offerAskProviderKey.mockResolvedValue('dismissed');
    const out = await ask();
    expect(offerAskProviderKey).toHaveBeenCalledTimes(1);
    expect(out).toContain('Chose Postgres');
    expect(out).toMatch(/1 matching decision/);
  });

  it('a key saved at the offer answers THIS question, with prose', async () => {
    setTTY(true);
    synthesiseDetailed.mockResolvedValueOnce(NO_PROVIDER).mockResolvedValueOnce({ ok: true, text: 'Postgres won for jsonb.' });
    offerAskProviderKey.mockResolvedValue('configured');
    const out = await ask();
    expect(synthesiseDetailed).toHaveBeenCalledTimes(2);
    expect(out).toContain('Postgres won for jsonb.');
    expect(out).not.toMatch(/matching decision/);
  });

  it('after "Not now" was chosen once, it does not ask again', async () => {
    setTTY(true);
    dismissed.value = true;
    synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
    const out = await ask();
    expect(offerAskProviderKey).not.toHaveBeenCalled();
    expect(out).toContain('Chose Postgres');
  });
});

describe('no offer', () => {
  it('without a terminal - the ranked list, exactly as before', async () => {
    setTTY(false);
    synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
    const out = await ask();
    expect(offerAskProviderKey).not.toHaveBeenCalled();
    expect(out).toContain('No answer written: no LLM configured.');
  });

  it('L1: inside a launched agent (ALIGN_WRAPPED), where a prompt would block the agent\'s shell', async () => {
    setTTY(true);
    vi.stubEnv('ALIGN_WRAPPED', '1');
    synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
    const out = await ask();
    vi.unstubAllEnvs();
    expect(offerAskProviderKey).not.toHaveBeenCalled();
    expect(out).toContain('Chose Postgres');
  });

  it('L1 control: the same terminal without ALIGN_WRAPPED does offer', async () => {
    setTTY(true);
    vi.stubEnv('ALIGN_WRAPPED', '');
    synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
    offerAskProviderKey.mockResolvedValue('dismissed');
    await ask();
    vi.unstubAllEnvs();
    expect(offerAskProviderKey).toHaveBeenCalledTimes(1);
  });

  it('under --json, even on a terminal', async () => {
    setTTY(true);
    await ask('--json');
    expect(offerAskProviderKey).not.toHaveBeenCalled();
    expect(synthesiseDetailed).not.toHaveBeenCalled();
  });

  it('when a provider answered (one is configured: it is used silently)', async () => {
    setTTY(true);
    synthesiseDetailed.mockResolvedValue({ ok: true, text: 'An answer.' });
    await ask();
    expect(offerAskProviderKey).not.toHaveBeenCalled();
  });

  it('when a configured provider FAILED - that needs the failure named, not a key offer', async () => {
    setTTY(true);
    synthesiseDetailed.mockResolvedValue({ ok: false, failure: { kind: 'providers_unavailable', tried: [{ provider: 'openai', detail: 'HTTP 401' }] } });
    await ask();
    expect(offerAskProviderKey).not.toHaveBeenCalled();
  });
});
