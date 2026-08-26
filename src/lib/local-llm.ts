export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'mistral' | 'grok';

export interface LocalLlmOptions {
  provider?: AiProvider;
  apiKey?: string;
}

export interface CallChatOptions {
  /** Explicitly configured provider (e.g. written by `align setup`); takes priority. */
  provider?: AiProvider;
  apiKey?: string;
  maxTokens?: number;
  /**
   * Sampling temperature. Omit for the provider default; pass 0 for deterministic
   * output (relationship classification, where the same pair must type the same
   * way every run). See ALI-218.
   */
  temperature?: number;
}

/**
 * Exported so its contract is pinned by test (local-llm.test.ts), the way a
 * render contract is. What each line is FOR, so a rewrite keeps the point:
 *
 * - The abstention sentence is the load-bearing one. Measured 2026-08-25
 *   (ollama-vet eval): without it, llama3.2, deepseek-r1 and WhiteRabbitNeo
 *   ALL invented a database-sharding decision on 6/6 runs when the context
 *   held no answer - ALI-414's fail-open shape on the synthesis surface.
 * - "authoritative" is gone on purpose: it was the licence the models were
 *   obeying when they confabulated. Direct != authoritative-about-nothing.
 * - The relationship and conflict sentences target the other two measured
 *   failures: invented links between unrelated decisions, and an invented
 *   winner between contradicting ones.
 */
export const SYNTHESIS_SYSTEM_PROMPT =
  'You are a technical assistant helping a developer understand their team\'s past decisions. ' +
  'Answer the question in 2-4 concise sentences based only on the provided context. ' +
  'If the context does not answer the question, say exactly that - never guess and never invent decisions or details. ' +
  'Attribute details only to the decision they came from, and only state relationships between decisions that the context itself states. ' +
  'If two decisions contradict each other, say they conflict - do not pick a winner the context does not name. ' +
  'Be direct. Synthesise the context into a clear explanation - do not list decisions.';

function buildUserPrompt(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): string {
  const ctx = decisions.map(d => `- ${d.title}: ${d.summary}`).join('\n');
  return `Question: ${question}\n\nDecision context:\n${ctx}`;
}

// --- Provider adapters: each takes a generic (system, user) chat and returns a
// classified outcome (ALI-692). The three kinds carry the whole fallback policy:
//   answer      - usable text from the model that was asked
//   unavailable - nothing answered, or an availability-class rejection; the chain
//                 may advance, because this provider can never answer here
//   failed      - the chosen provider DID respond and the response is unusable
//                 (or a non-availability status like 429/5xx); the chain must STOP,
//                 or a weaker model silently answers in the chosen one's place
type AdapterOutcome =
  | { kind: 'answer'; text: string }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'failed'; model: string; detail: string };

/** Classify a non-2xx response: availability-class advances, anything else stops. */
async function classifyHttpFailure(
  res: { status?: number; text?: () => Promise<string> },
  model: string,
): Promise<AdapterOutcome> {
  let body = '';
  try {
    body = await res.text!();
  } catch {
    // No readable body; the status alone decides.
  }
  const status = res.status ?? 0;
  const detail = `HTTP ${status}`;
  return isAvailabilityFailure(status, body)
    ? { kind: 'unavailable', detail }
    : { kind: 'failed', model, detail };
}

// OpenAI-compatible Chat Completions API (OpenAI, Groq, Mistral, xAI/Grok, and any
// ALIGN_LLM_BASE_URL endpoint - OpenRouter, Together, DeepSeek, LM Studio, vLLM, ...).
async function tryOpenAiCompatible(
  system: string,
  user: string,
  endpoint: string,
  model: string,
  key: string,
  maxTokens = 256,
  timeoutMs = 15000,
  temperature?: number,
): Promise<AdapterOutcome> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Nothing answered (network, DNS, timeout): the provider is absent here.
    return { kind: 'unavailable', detail: String(err) };
  }
  if (!res.ok) return classifyHttpFailure(res, model);
  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = await res.json() as typeof data;
  } catch {
    return { kind: 'failed', model, detail: 'malformed response body' };
  }
  const text = data.choices?.[0]?.message?.content?.trim();
  return text ? { kind: 'answer', text } : { kind: 'failed', model, detail: 'empty response' };
}

async function tryAnthropic(
  system: string,
  user: string,
  key: string,
  maxTokens = 256,
  temperature?: number,
): Promise<AdapterOutcome> {
  const model = process.env['ALIGN_ANTHROPIC_MODEL'] || 'claude-haiku-4-5-20251001';
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { kind: 'unavailable', detail: String(err) };
  }
  if (!res.ok) return classifyHttpFailure(res, model);
  let data: { content?: Array<{ text?: string }> };
  try {
    data = await res.json() as typeof data;
  } catch {
    return { kind: 'failed', model, detail: 'malformed response body' };
  }
  const text = data.content?.[0]?.text?.trim();
  return text ? { kind: 'answer', text } : { kind: 'failed', model, detail: 'empty response' };
}

async function tryGemini(
  system: string,
  user: string,
  key: string,
  maxTokens = 256,
  temperature?: number,
): Promise<AdapterOutcome> {
  const geminiModel = process.env['ALIGN_GEMINI_MODEL'] || 'gemini-1.5-flash';
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(temperature !== undefined ? { temperature } : {}),
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch (err) {
    return { kind: 'unavailable', detail: String(err) };
  }
  if (!res.ok) return classifyHttpFailure(res, geminiModel);
  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    data = await res.json() as typeof data;
  } catch {
    return { kind: 'failed', model: geminiModel, detail: 'malformed response body' };
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text ? { kind: 'answer', text } : { kind: 'failed', model: geminiModel, detail: 'empty response' };
}

/**
 * Ollama model families recognised for decision synthesis, in OUR preference order
 * (never /api/tags order - ALI-420). Family-level and version-free on purpose: the
 * old exact-version list (llama3.2, llama3.1, llama3, mistral, gemma2, phi3) went
 * stale the moment a new version shipped, and the 2026-08-25 vetting eval showed the
 * quality lever is SYNTHESIS_SYSTEM_PROMPT, not which mainstream family answers. The
 * list's remaining job is "is something recognisable installed" - matched against the
 * LIVE /api/tags registry, and the newest installed version wins within a family.
 * (ALI-692)
 */
export const OLLAMA_MODEL_FAMILIES: readonly RegExp[] = [
  /^llama\d/,
  /^mistral([:\-.]|\d|$)/,
  /^gemma\d/,
  /^phi\d/,
  /^qwen\d/,
  /^deepseek-r\d/,
];

/**
 * Static fallback for the "pull one" hint only - version-pinned so it is
 * copy-pasteable, therefore stale by design. Resolution never consults it:
 * resolveOllamaModel picks from what the live registry actually has.
 */
export const RECOMMENDED_OLLAMA_PULL = 'llama3.2';

export type OllamaModelChoice =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_models' | 'no_recognised_model' };

/** Numeric version segments from a tag name ('llama3.10:latest' -> [3, 10]). */
function modelVersionSegments(name: string): number[] {
  const base = name.split(':')[0] ?? '';
  const m = base.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1]!.split('.').map(Number) : [0];
}

// Segment-wise, so 3.10 > 3.9 (a float parse or string sort gets it backwards).
function compareVersionSegments(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function resolveOllamaModel(installed: string[], override?: string): OllamaModelChoice {
  // Named by the user, so it is their call - the contract every other provider here
  // already has via ALIGN_<PROVIDER>_MODEL.
  if (override) return { ok: true, model: override };
  if (!installed.length) return { ok: false, reason: 'no_models' };
  // Iterate OUR family order, not the installed list: `/api/tags` order is Ollama's,
  // and letting it pick among recognised families is the same defect one line over.
  for (const family of OLLAMA_MODEL_FAMILIES) {
    const matches = installed.filter(m => family.test(m));
    if (!matches.length) continue;
    matches.sort((a, b) => compareVersionSegments(modelVersionSegments(b), modelVersionSegments(a)));
    return { ok: true, model: matches[0]! };
  }
  return { ok: false, reason: 'no_recognised_model' };
}

let unvettedOllamaModels: string[] | null = null;

/**
 * The models Ollama had when it declined to answer for want of a vetted one (ALI-420),
 * or null when that did not happen. Read it on the failure branch to say WHY there was
 * no answer, the same way `hasConfiguredProvider()` is read there.
 *
 * Recorded rather than re-probed: `tryOllama` has already fetched `/api/tags`.
 * Cleared at every callChat entry (a chain stop can end the run before step 4 - see
 * ALI-692), so whenever a caller asks, the recording is from this run.
 */
export function getUnvettedOllamaModels(): string[] | null {
  return unvettedOllamaModels;
}

/**
 * The provider/model the fallback chain STOPPED on, and why (ALI-692), or null when
 * the last call answered or every failure was availability-class. Same recorded-not-
 * re-probed contract as getUnvettedOllamaModels above: cleared at each callChat entry,
 * so whenever a caller asks, the recording is from this run.
 */
export interface LlmFailure {
  provider: string;
  model: string;
  detail: string;
}

let llmFailure: LlmFailure | null = null;

export function getLlmFailure(): LlmFailure | null {
  return llmFailure;
}

// The error-body shapes that strongly imply the model or key can never work here.
// Deliberately conservative: generic task failures must NOT match, or the chain is
// back to demoting on anything.
const AVAILABILITY_BODY_PATTERNS = [
  /unauthor[iz]ed/i,
  /authentication[\s_-]+failed/i,
  /forbidden/i,
  /\binvalid[\s_-]+api[\s_-]?key\b/i,
  /\bunknown\s+(model|provider)\b/i,
  /\binvalid\s+(model|provider)\b/i,
  /\bmodel\s+not\s+(found|available|registered|supported)\b/i,
  /\bno\s+such\s+(model|provider)\b/i,
  /not a valid model/i,
  /\bmodel_not_found\b/i,
];

/**
 * Only failures on this allowlist may advance the fallback chain: they mean the chosen
 * model can NEVER answer in this environment (bad key, no such model), so trying the
 * next provider loses nothing. Anything else - a malformed body, an empty answer, a
 * rate limit, a 5xx - came from the provider the user chose, and silently demoting to
 * a weaker model would launder that failure into an answer the caller trusts as if the
 * chosen model wrote it. Deliberately conservative (ALI-692).
 */
export function isAvailabilityFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  return AVAILABILITY_BODY_PATTERNS.some(p => p.test(body));
}

/** Test seam: clears both recordings above between cases. */
export function resetLlmDiagnostics(): void {
  unvettedOllamaModels = null;
  llmFailure = null;
}

async function tryOllama(
  system: string,
  user: string,
  temperature?: number,
): Promise<AdapterOutcome> {
  const host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';

  // Clear first, so the recording always describes THIS attempt. Without it a refusal
  // from an earlier call in the same process outlives its cause, and a later failure
  // with a different cause inherits the wrong diagnosis.
  unvettedOllamaModels = null;

  // The /api/tags probe is discovery, not a model answering: every way it can fail
  // (not running, no models, nothing recognised) means "no usable model here".
  let model: string;
  try {
    const tagsRes = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!tagsRes.ok) return { kind: 'unavailable', detail: 'tags probe failed' };
    const tags = await tagsRes.json() as { models?: Array<{ name: string }> };
    const models = (tags.models ?? []).map(m => m.name);
    if (!models.length) return { kind: 'unavailable', detail: 'no models installed' };
    const choice = resolveOllamaModel(models, process.env['ALIGN_OLLAMA_MODEL']);
    if (!choice.ok) {
      if (choice.reason === 'no_recognised_model') unvettedOllamaModels = models;
      return { kind: 'unavailable', detail: choice.reason };
    }
    model = choice.model;
  } catch (err) {
    return { kind: 'unavailable', detail: String(err) };
  }

  let res: Response;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        ...(temperature !== undefined ? { options: { temperature } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { kind: 'unavailable', detail: String(err) };
  }
  if (!res.ok) return classifyHttpFailure(res, model);
  let data: { message?: { content?: string } };
  try {
    data = await res.json() as typeof data;
  } catch {
    return { kind: 'failed', model, detail: 'malformed response body' };
  }
  const text = data.message?.content?.trim();
  return text ? { kind: 'answer', text } : { kind: 'failed', model, detail: 'empty response' };
}

/** Normalize a base URL into a full Chat Completions endpoint. */
function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function keyForProvider(provider: AiProvider): string | undefined {
  switch (provider) {
    case 'anthropic': return process.env['ANTHROPIC_API_KEY'];
    case 'openai':    return process.env['OPENAI_API_KEY'];
    case 'gemini':    return process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    case 'groq':      return process.env['GROQ_API_KEY'];
    case 'mistral':   return process.env['MISTRAL_API_KEY'];
    case 'grok':      return process.env['GROK_API_KEY'] ?? process.env['XAI_API_KEY'];
  }
}

async function callProvider(
  provider: AiProvider,
  key: string,
  system: string,
  user: string,
  maxTokens?: number,
  temperature?: number,
): Promise<AdapterOutcome> {
  switch (provider) {
    case 'anthropic':
      return tryAnthropic(system, user, key, maxTokens, temperature);
    case 'openai':
      return tryOpenAiCompatible(system, user, 'https://api.openai.com/v1/chat/completions', process.env['ALIGN_OPENAI_MODEL'] || 'gpt-4o-mini', key, maxTokens, undefined, temperature);
    case 'gemini':
      return tryGemini(system, user, key, maxTokens, temperature);
    case 'groq':
      return tryOpenAiCompatible(system, user, 'https://api.groq.com/openai/v1/chat/completions', process.env['ALIGN_GROQ_MODEL'] || 'llama-3.1-8b-instant', key, maxTokens, undefined, temperature);
    case 'mistral':
      return tryOpenAiCompatible(system, user, 'https://api.mistral.ai/v1/chat/completions', process.env['ALIGN_MISTRAL_MODEL'] || 'mistral-small-latest', key, maxTokens, undefined, temperature);
    case 'grok':
      return tryOpenAiCompatible(system, user, 'https://api.x.ai/v1/chat/completions', process.env['ALIGN_GROK_MODEL'] || 'grok-2-latest', key, maxTokens, undefined, temperature);
  }
}

const ALL_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'gemini', 'groq', 'mistral', 'grok'];

/**
 * Is any LLM provider configured by environment? (ALI-414)
 *
 * `callChat` returns null for a missing key, a timeout and a non-2xx alike, so a
 * caller that needs to tell "never configured" from "configured but failed" has to
 * ask first. Deliberately synchronous and env-only: it does NOT probe Ollama, so a
 * machine whose only provider is a broken local Ollama reads as unconfigured. The
 * remedy that points at - configure a provider - is still the right one.
 */
export function hasConfiguredProvider(): boolean {
  if (process.env['ALIGN_LLM_BASE_URL']) return true;
  return ALL_PROVIDERS.some(p => Boolean(keyForProvider(p)));
}

/**
 * Provider-agnostic chat call. Resolution order:
 *   1. explicitly configured provider+key (e.g. from `align setup`)
 *   2. ALIGN_LLM_BASE_URL  - any OpenAI-compatible endpoint (Grok, OpenRouter,
 *      Together, DeepSeek, LM Studio, vLLM, ...) via ALIGN_LLM_MODEL/ALIGN_LLM_API_KEY
 *   3. named providers by env key (Anthropic, OpenAI, Gemini, Groq, Mistral, Grok)
 *   4. local Ollama (no key)
 * Returns the model's text, or null if nothing is available (callers fall back).
 *
 * ALI-692: only an availability-class failure advances that chain (see
 * isAvailabilityFailure). Anything else - the chosen model answering unusably, a
 * rate limit, a 5xx - stops it, returns null, and is recorded on getLlmFailure()
 * so the caller can name the model instead of a weaker one answering in its place.
 */
export async function callChat(
  system: string,
  user: string,
  opts?: CallChatOptions,
): Promise<string | null> {
  const maxTokens = opts?.maxTokens;
  const temperature = opts?.temperature;

  // Each call describes itself: cleared here so a caller reading the diagnostics
  // after a null sees THIS run's stop. The Ollama recording must clear here too, not
  // only inside tryOllama - a stop earlier in the chain means step 4 never runs, and
  // an earlier call's refusal would outlive its cause and misdiagnose this one.
  llmFailure = null;
  unvettedOllamaModels = null;

  // An answer or a stop returns a value; availability returns undefined = advance.
  const settle = (outcome: AdapterOutcome, provider: string): string | null | undefined => {
    if (outcome.kind === 'answer') return outcome.text;
    if (outcome.kind === 'failed') {
      llmFailure = { provider, model: outcome.model, detail: outcome.detail };
      return null;
    }
    return undefined;
  };

  // 1. configured provider (from align setup) takes priority
  if (opts?.provider && opts.apiKey) {
    const settled = settle(
      await callProvider(opts.provider, opts.apiKey, system, user, maxTokens, temperature),
      opts.provider,
    );
    if (settled !== undefined) return settled;
  }

  // 2. generic OpenAI-compatible escape hatch - covers any provider
  const baseUrl = process.env['ALIGN_LLM_BASE_URL'];
  if (baseUrl) {
    const key = process.env['ALIGN_LLM_API_KEY'] ?? '';
    const model = process.env['ALIGN_LLM_MODEL'] || 'gpt-4o-mini';
    const settled = settle(
      await tryOpenAiCompatible(system, user, chatCompletionsUrl(baseUrl), model, key, maxTokens, undefined, temperature),
      'custom',
    );
    if (settled !== undefined) return settled;
  }

  // 3. named providers via env keys, in priority order
  for (const provider of ALL_PROVIDERS) {
    if (opts?.provider === provider) continue; // already tried above
    const key = keyForProvider(provider);
    if (key) {
      const settled = settle(
        await callProvider(provider, key, system, user, maxTokens, temperature),
        provider,
      );
      if (settled !== undefined) return settled;
    }
  }

  // 4. local Ollama as last resort
  return settle(await tryOllama(system, user, temperature), 'ollama') ?? null;
}

/** Synthesise a natural-language answer from retrieved decisions, using any configured provider. */
export async function synthesiseLocally(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  options?: LocalLlmOptions,
): Promise<string | null> {
  const user = buildUserPrompt(question, decisions);
  return callChat(SYNTHESIS_SYSTEM_PROMPT, user, { provider: options?.provider, apiKey: options?.apiKey });
}
