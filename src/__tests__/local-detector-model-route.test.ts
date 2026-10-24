// On a local route (no hosted key) the DEFAULT detector follows the local model; an explicit choice wins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LocalLlm from '../lib/local-llm.js';

let probed: string | null = null;
let hosted = false;
vi.mock('../lib/local-llm.js', async (orig) => ({
  ...(await orig<typeof LocalLlm>()),
  hasConfiguredProvider: () => hosted,
  probeOllama: async () => probed,
}));

const SUBJECT = { title: 'Use Postgres', summary: 'We use Postgres', platform: 'github', sourceUrl: 'https://example.test/1', decidedAt: null } as never;
const CANDIDATES = [{ id: 'a', title: 'Use Redis', summary: 'We use Redis', platform: 'github', sourceUrl: 'https://example.test/2', decidedAt: null }] as never;

async function runWith(model: string | null, deps: { env?: Record<string, string> } = {}) {
  vi.resetModules();
  probed = model;
  for (const [k, v] of Object.entries(deps.env ?? {})) vi.stubEnv(k, v);
  const { classifyCandidates } = await import('../lib/local-candidate-classify.js');
  const set = vi.fn(async () => ({ ok: true as const, verdicts: [{ relation: 'relates', confidence: 0.5 }] }));
  const pair = vi.fn(async () => ({ ok: true as const, relationship: { type: 'relates', confidence: 0.5 } }));
  const out = await classifyCandidates(SUBJECT, CANDIDATES, 'subject-first', { set: set as never, pair: pair as never });
  return { version: out.version, setCalls: set.mock.calls.length, pairCalls: pair.mock.calls.length };
}

beforeEach(() => { hosted = false; vi.stubEnv('ALIGN_DETECTOR', ''); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('the default detector on a local route follows the local model', () => {
  it('qwen2.5:7b runs v1 (the model that passed)', async () => {
    expect(await runWith('qwen2.5:7b')).toMatchObject({ version: 'v1', setCalls: 1, pairCalls: 0 });
  });

  it('llama3.2 runs v0 (it did not pass), so it keeps finding conflicts as before', async () => {
    expect(await runWith('llama3.2:latest')).toMatchObject({ version: 'v0', setCalls: 0, pairCalls: 1 });
  });

  it('no local model at all runs v0', async () => {
    expect((await runWith(null)).version).toBe('v0');
  });

  it('an explicit ALIGN_DETECTOR=v1 wins even on llama3.2', async () => {
    expect((await runWith('llama3.2:latest', { env: { ALIGN_DETECTOR: 'v1' } })).version).toBe('v1');
  });

  it('a hosted key means the model is not local, so the default stays v1', async () => {
    hosted = true;
    expect((await runWith('llama3.2:latest')).version).toBe('v1');
  });
});
