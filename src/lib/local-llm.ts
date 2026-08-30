export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'mistral' | 'grok';

export interface CallChatOptions {
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
  | { kind: 'unavailable'; detail: string; unrecognisedModels?: string[] }
  | { kind: 'failed'; model: string; detail: string };

/** Classify a non-2xx response: availability-class advances, anything else stops. */
async function classifyHttpFailure(res: Response, model: string): Promise<AdapterOutcome> {
  const detail = `HTTP ${res.status}`;
  // 401/403/404 decide on the status alone, so do not download a body to ignore it -
  // behind a proxy the 401 body is an HTML page, and a dead key is the common case.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { kind: 'unavailable', detail };
  }
  let body = '';
  try {
    body = await res.text();
  } catch {
    // No readable body; the status alone decides.
  }
  return isAvailabilityFailure(res.status, body)
    ? { kind: 'unavailable', detail }
    : { kind: 'failed', model, detail };
}

/**
 * Classify a thrown fetch. An ABORT is not an absence: we chose this provider and gave
 * up waiting on it, which is the same event as a 429 from the caller's point of view
 * and must stop the chain. Slow is not absent - otherwise the same overloaded provider
 * stops the chain when it answers 429 and demotes to a weaker model when it answers
 * nothing, which is the harder failure to notice. A connection or DNS error genuinely
 * means nothing answered, so that advances.
 */
function classifyThrownFetch(err: unknown, model: string): AdapterOutcome {
  const name = (err as { name?: string } | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'failed', model, detail: 'timed out' };
  }
  return { kind: 'unavailable', detail: String(err) };
}

// A reasoning model (the deepseek-r family) prefixes its answer with a <think> block.
// It is a monologue, not prose for a human, and `align ask` prints the response
// verbatim while parseRelationship's brace match would span a brace inside it.
function stripReasoningBlock(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * The shared tail every adapter needs: read the body, extract the model's text, and
 * decide answer-or-stop. One owner, because this IS the response policy - four copies
 * drift, and the Gemini copy had already grown its own shape.
 */
async function parseAdapterResponse<T>(
  res: Response,
  model: string,
  extract: (data: T) => string | undefined,
): Promise<AdapterOutcome> {
  let data: T;
  try {
    data = await res.json() as T;
  } catch {
    return { kind: 'failed', model, detail: 'malformed response body' };
  }
  const text = stripReasoningBlock(extract(data)?.trim() ?? '');
  return text ? { kind: 'answer', text } : { kind: 'failed', model, detail: 'empty response' };
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
    return classifyThrownFetch(err, model);
  }
  if (!res.ok) return classifyHttpFailure(res, model);
  return parseAdapterResponse<{ choices?: Array<{ message?: { content?: string } }> }>(
    res, model, d => d.choices?.[0]?.message?.content);
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
    return classifyThrownFetch(err, model);
  }
  if (!res.ok) return classifyHttpFailure(res, model);
  // First block with text, not content[0]: a thinking or tool-use block can lead, and
  // reading index 0 blindly calls a correct answer an empty response - which now STOPS
  // the chain rather than merely falling through it.
  return parseAdapterResponse<{ content?: Array<{ text?: string }> }>(
    res, model, d => d.content?.find(b => b.text?.trim())?.text);
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
    return classifyThrownFetch(err, geminiModel);
  }
  if (!res.ok) return classifyHttpFailure(res, geminiModel);
  // First part with text, for the same reason as Anthropic's blocks above.
  return parseAdapterResponse<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(
    res, geminiModel, d => d.candidates?.[0]?.content?.parts?.find(p => p.text?.trim())?.text);
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
  /^llama[\d.:-]/i,
  /^mistral[\d.:-]/i,
  /^gemma[\d.:-]/i,
  /^phi[\d.:-]/i,
  /^qwen[\d.:-]/i,
  /^deepseek-r[\d.:-]/i,
];

/**
 * A family match says who trained it, never what it was trained FOR, and the ALI-420
 * floor is about the second: llama2-uncensored is in the llama family and is the same
 * category as the pentest model from that ticket, while a coder or embedding model is
 * not a synthesis model at all. So a tuning marker disqualifies a tag even when its
 * family is recognised - a user can still name one explicitly via ALIGN_OLLAMA_MODEL.
 */
const OLLAMA_TUNING_DISQUALIFIERS = /(coder|code|math|uncensored|embed|guard|vision|dolphin)/i;

/**
 * A tag is recognised by its LAST path segment, because `ollama pull hf.co/<user>/<repo>`
 * prefixes the name - anchoring at the start of the whole string refuses every model
 * installed that mainstream way.
 */
function ollamaTagBase(name: string): string {
  return name.split('/').pop() ?? name;
}

function isRecognisedOllamaModel(name: string, family: RegExp): boolean {
  const base = ollamaTagBase(name);
  return family.test(base) && !OLLAMA_TUNING_DISQUALIFIERS.test(base);
}

/**
 * Static fallback for the "pull one" hint only - version-pinned so it is
 * copy-pasteable, therefore stale by design. Resolution never consults it:
 * resolveOllamaModel picks from what the live registry actually has.
 */
export const RECOMMENDED_OLLAMA_PULL = 'llama3.2';

export type OllamaModelChoice =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_models' | 'no_recognised_model' };

/**
 * Numeric version segments from a tag name ('llama3.10:latest' -> [3, 10]).
 *
 * A PARAMETER SIZE is not a version, and community tags put one in the name: taking
 * the first digit run makes `mistral-7b-instruct` look newer than `mistral-small3.1`,
 * so any `-7b` / `_7x8b` token comes out before the version is read.
 */
function modelVersionSegments(name: string): number[] {
  const base = (name.split(':')[0] ?? '').replace(/[-_]\d+(\.\d+)?x?\d*b\b/gi, '');
  const m = base.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1]!.split('.').map(Number) : [0];
}

/** Parameter count in billions from a tag ('llama3.2:3b' -> 3), 0 when absent. */
function modelParameterBillions(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)b\b/i);
  return m ? Number(m[1]) : 0;
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
    const matches = installed.filter(m => isRecognisedOllamaModel(m, family));
    if (!matches.length) continue;
    // Newest version, then the larger model, then the name. The last two exist so the
    // result cannot depend on `/api/tags` order: llama3.2:1b and llama3.2:3b tie on
    // version, and a stable sort would hand that choice straight back to Ollama.
    matches.sort((a, b) =>
      compareVersionSegments(modelVersionSegments(b), modelVersionSegments(a))
      || modelParameterBillions(b) - modelParameterBillions(a)
      || a.localeCompare(b));
    return { ok: true, model: matches[0]! };
  }
  return { ok: false, reason: 'no_recognised_model' };
}

/**
 * Why a chat produced no answer. RETURNED to the caller, never stashed in module
 * state: the previous design recorded it in a module variable cleared at each
 * `callChat` entry, so "the recording describes THIS call" held only while nothing
 * ran concurrently, and it was enforced by a comment. Two overlapping calls (parallel
 * MCP request handlers, a `Promise.all` over candidates) had one clearing the other's
 * diagnosis, so a caller could read a sibling's failure or none at all. Returning it
 * makes the guarantee structural - a value on the call stack cannot be clobbered.
 *
 *  - `no_provider` - nothing was configured and nothing local answered.
 *  - `unrecognised_local_models` - Ollama is running and no installed model is
 *    recognised for synthesis (ALI-420). Carries the models, so a caller can name them.
 *  - `provider_stopped` - a provider WAS reached and its response was unusable, so the
 *    chain stopped rather than demoting to a weaker model (ALI-692).
 */
export type LlmFailure =
  | { kind: 'no_provider' }
  | { kind: 'unrecognised_local_models'; models: string[] }
  | { kind: 'provider_stopped'; provider: string; model: string; detail: string }
  /**
   * Every provider the user CONFIGURED was unavailable, so the chain ran out (ALI-766).
   *
   * Distinct from `no_provider`, which now means only "nothing was configured". They need
   * opposite remedies - "set a key" against "your endpoint is unreachable or your key is
   * dead" - and collapsing them told anyone who had pointed the CLI at DeepSeek, OpenRouter,
   * LM Studio or vLLM and typo'd the URL to go and set ANTHROPIC_API_KEY. That reads as
   * "your provider is not supported", which is false.
   */
  | { kind: 'providers_unavailable'; tried: Array<{ provider: string; detail: string }> };

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; failure: LlmFailure };

/**
 * Error-body wordings that mean PERMANENT: this key or this model cannot answer here
 * however many times we ask. Providers report several of these on statuses outside
 * 401/403/404 - Gemini says 400 for a bad key, OpenAI says 429 for a dead account -
 * and each one, misread as transient, permanently disables every provider behind it
 * in the chain. Every entry is a real provider phrasing.
 *
 * A TRANSIENT failure must never appear here: a real rate limit, a 529 overload or a
 * 5xx is the chosen provider having a bad minute, and advancing past it is the silent
 * demotion this whole mechanism exists to prevent.
 */
const AVAILABILITY_BODY_PATTERNS = [
  /unauthori[sz]ed/i,
  /authentication[\s_-]+(failed|error)/i,
  /permission[\s_-]+denied/i,
  /\binvalid[\s_-]+api[\s_-]?key\b/i,
  /\bapi[\s_-]?key[\s_-]+not[\s_-]+valid\b/i,
  /\bunknown\s+(model|provider)\b/i,
  /\binvalid\s+(model|provider)\b/i,
  /\bmodel\s+not\s+(found|available|registered|supported)\b/i,
  /\bno\s+such\s+(model|provider)\b/i,
  /not a valid model/i,
  /\bmodel_not_found\b/i,
  /\binsufficient_quota\b/i,
  /credit balance is too low/i,
  /\bunsupported (parameter|value)\b/i,
];

/**
 * The body text a provider's error carries, WITHOUT any part of the request it may
 * have echoed back. `classifyRelationship` sends a 2,000-character diff as the user
 * prompt, and endpoints routinely quote the offending request in a 4xx body - so
 * matching prose against the whole body lets the decision text under review decide
 * whether to demote to a weaker model. Reading only the error member closes that.
 *
 * A non-JSON body has no error member to read, so it falls back to the raw text: the
 * boundary of this defence is "the provider replied in JSON", which is all of them.
 */
function providerErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return body;
    const err = (parsed as { error?: unknown }).error;
    if (err === undefined) return body;
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return body;
  }
}

/**
 * Only failures on this allowlist may advance the fallback chain: they mean the chosen
 * model can NEVER answer in this environment (bad key, no such model, no credit), so
 * trying the next provider loses nothing. Anything else - a malformed body, an empty
 * answer, a real rate limit, a 5xx - came from the provider the user chose, and
 * silently demoting to a weaker model would launder that failure into an answer the
 * caller trusts as if the chosen model wrote it. Deliberately conservative (ALI-692).
 */
export function isAvailabilityFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  const text = providerErrorText(body);
  return AVAILABILITY_BODY_PATTERNS.some(p => p.test(text));
}


async function tryOllama(
  system: string,
  user: string,
  temperature?: number,
): Promise<AdapterOutcome> {
  // `||`, not `??`: OLLAMA_HOST='' (a stock .env template, an unset compose variable)
  // would otherwise make every probe a relative URL that fetch cannot parse, so a
  // healthy local Ollama is never asked and the user is told to configure a key.
  const host = process.env['OLLAMA_HOST'] || 'http://localhost:11434';

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
      // The models travel WITH the outcome, so the caller that asked gets them - see
      // LlmFailure. A module variable here could be cleared by a concurrent call.
      return choice.reason === 'no_recognised_model'
        ? { kind: 'unavailable', detail: choice.reason, unrecognisedModels: models }
        : { kind: 'unavailable', detail: choice.reason };
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
    // Past selection, Ollama is a CHOSEN provider like any other, so every failure here
    // must be attributable: an unrecorded stop sends the caller to the generic "set a
    // key" hint, which is nonsense for a user whose local model just replied. A cold
    // 7B commonly exceeds the 30s budget on its first load, and that is the model's
    // failure to name, not an absent provider.
    const name = (err as { name?: string } | undefined)?.name;
    return { kind: 'failed', model, detail: name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'unreachable' };
  }
  if (!res.ok) return { kind: 'failed', model, detail: `HTTP ${res.status}` };
  return parseAdapterResponse<{ message?: { content?: string } }>(
    res, model, d => d.message?.content);
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
    // `||` on the aliases: an empty GEMINI_API_KEY must not shadow a real GOOGLE_API_KEY
    // (a stock .env template ships both names), which `??` would do silently.
    case 'gemini':    return process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'];
    case 'groq':      return process.env['GROQ_API_KEY'];
    case 'mistral':   return process.env['MISTRAL_API_KEY'];
    case 'grok':      return process.env['GROK_API_KEY'] || process.env['XAI_API_KEY'];
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
 * `callChat` returns null for a missing key and for a provider that answered unusably
 * alike, so a caller that needs to tell "never configured" from "configured but
 * failed" has to ask - this, then the failure `callChatDetailed` returned for the
 * second case, which is the one this function cannot see. Deliberately synchronous and
 * env-only: it does NOT probe Ollama, so a
 * machine whose only provider is a broken local Ollama reads as unconfigured. The
 * remedy that points at - configure a provider - is still the right one.
 */
export function hasConfiguredProvider(): boolean {
  if (process.env['ALIGN_LLM_BASE_URL']) return true;
  return ALL_PROVIDERS.some(p => Boolean(keyForProvider(p)));
}

/**
 * Provider-agnostic chat call. Resolution order:
 *   1. ALIGN_LLM_BASE_URL  - any OpenAI-compatible endpoint (Grok, OpenRouter,
 *      Together, DeepSeek, LM Studio, vLLM, ...) via ALIGN_LLM_MODEL/ALIGN_LLM_API_KEY
 *   2. named providers by env key (Anthropic, OpenAI, Gemini, Groq, Mistral, Grok)
 *   3. local Ollama (no key)
 * Returns the model's text, or the reason there is none - see LlmFailure. The reason
 * is RETURNED rather than recorded in module state, so concurrent calls cannot read
 * each other's diagnosis.
 *
 * ALI-692: only an availability-class failure advances that chain (see
 * isAvailabilityFailure). Anything else - the chosen model answering unusably, a rate
 * limit, a 5xx - stops it, so the caller can name the model that failed instead of a
 * weaker one answering in its place.
 */
export async function callChatDetailed(
  system: string,
  user: string,
  opts?: CallChatOptions,
): Promise<ChatResult> {
  const maxTokens = opts?.maxTokens;
  const temperature = opts?.temperature;

  // The most specific unavailability seen while walking the chain. Only Ollama can
  // produce one today, and it is a local (not module) variable, so a sibling call
  // cannot clear it mid-flight - which is the whole point of this shape.
  let unrecognised: string[] | undefined;

  // Every CONFIGURED provider that turned out to be unavailable, in the order tried. Local
  // for the same reason as `unrecognised`: a sibling call must not see this one's attempts.
  const tried: Array<{ provider: string; detail: string }> = [];

  // An answer or a stop settles the chain; availability advances it (undefined).
  //
  // `configured` says whether the USER asked for this provider. It is a parameter rather
  // than an `!== 'ollama'` test because the distinction is the whole point: the Ollama probe
  // runs on every machine, so counting its absence as a failed attempt would mean "set a
  // key" - the correct advice for someone who has configured nothing - is never shown again.
  const settle = (outcome: AdapterOutcome, provider: string, configured: boolean): ChatResult | undefined => {
    if (outcome.kind === 'answer') return { ok: true, text: outcome.text };
    if (outcome.kind === 'failed') {
      return { ok: false, failure: { kind: 'provider_stopped', provider, model: outcome.model, detail: outcome.detail } };
    }
    // Narrowed to `unavailable` by the two returns above, so reading its own field
    // needs no guard. Deliberately left to exhaustion rather than an explicit
    // `kind === 'unavailable'` check: a fourth AdapterOutcome variant would make this
    // line a type error, where an explicit check would silently route it to advance.
    if (outcome.unrecognisedModels) unrecognised = outcome.unrecognisedModels;
    if (configured) tried.push({ provider, detail: outcome.detail });
    return undefined;
  };

  // A "provider: ... from `align setup`" branch used to sit first here. Nothing ever
  // supplied it - setup never collected or stored a provider key - so it was tested,
  // documented (README and this file's own comment both claimed it), and unreachable.
  // Deleted rather than kept: a mechanism with no caller reads as a feature and becomes
  // documentation, which is exactly how it got into the README twice. If a future path
  // needs explicit provider injection, add it WITH its caller.

  // 1. generic OpenAI-compatible escape hatch - covers any provider
  const baseUrl = process.env['ALIGN_LLM_BASE_URL'];
  if (baseUrl) {
    const key = process.env['ALIGN_LLM_API_KEY'] ?? '';
    const model = process.env['ALIGN_LLM_MODEL'] || 'gpt-4o-mini';
    const settled = settle(
      await tryOpenAiCompatible(system, user, chatCompletionsUrl(baseUrl), model, key, maxTokens, undefined, temperature),
      'custom',
      true,
    );
    if (settled) return settled;
  }

  // 2. named providers via env keys, in priority order
  for (const provider of ALL_PROVIDERS) {
    const key = keyForProvider(provider);
    if (key) {
      const settled = settle(
        await callProvider(provider, key, system, user, maxTokens, temperature),
        provider,
        true,
      );
      if (settled) return settled;
    }
  }

  // 3. local Ollama as last resort
  // configured=false: the probe runs whether or not anyone asked for Ollama.
  const settled = settle(await tryOllama(system, user, temperature), 'ollama', false);
  if (settled) return settled;

  // Nothing answered. An unrecognised local model is the more specific diagnosis and
  // its remedy is the opposite of "configure a provider", so it wins (ALI-420).
  if (unrecognised) {
    return { ok: false, failure: { kind: 'unrecognised_local_models', models: unrecognised } };
  }
  // Something WAS configured and none of it answered. Saying "set a key" here is the wrong
  // signpost, and it lands on the one user who took the trouble to configure us (ALI-766).
  if (tried.length > 0) {
    return { ok: false, failure: { kind: 'providers_unavailable', tried } };
  }
  return { ok: false, failure: { kind: 'no_provider' } };
}

/** Text-only convenience wrapper. Use callChatDetailed when you need to say WHY. */
export async function callChat(
  system: string,
  user: string,
  opts?: CallChatOptions,
): Promise<string | null> {
  const result = await callChatDetailed(system, user, opts);
  return result.ok ? result.text : null;
}

/** Synthesise a natural-language answer from retrieved decisions, using any configured provider. */
export async function synthesiseDetailed(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): Promise<ChatResult> {
  const user = buildUserPrompt(question, decisions);
  return callChatDetailed(SYNTHESIS_SYSTEM_PROMPT, user);
}

/** Text-only wrapper on synthesiseDetailed, for callers that cannot use the reason. */
export async function synthesiseLocally(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): Promise<string | null> {
  const result = await synthesiseDetailed(question, decisions);
  return result.ok ? result.text : null;
}
