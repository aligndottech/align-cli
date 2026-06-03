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
}

const SYSTEM_PROMPT =
  'You are a technical assistant helping a developer understand their team\'s past decisions. ' +
  'Answer the question in 2-4 concise sentences based only on the provided context. ' +
  'Be direct and authoritative. Synthesise the context into a clear explanation - do not list decisions.';

function buildUserPrompt(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): string {
  const ctx = decisions.map(d => `- ${d.title}: ${d.summary}`).join('\n');
  return `Question: ${question}\n\nDecision context:\n${ctx}`;
}

// --- Provider adapters: each takes a generic (system, user) chat and returns text or null ---

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
): Promise<string | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function tryAnthropic(
  system: string,
  user: string,
  key: string,
  maxTokens = 256,
): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env['ALIGN_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function tryGemini(
  system: string,
  user: string,
  key: string,
  maxTokens = 256,
): Promise<string | null> {
  try {
    const geminiModel = process.env['ALIGN_GEMINI_MODEL'] ?? 'gemini-1.5-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function tryOllama(system: string, user: string): Promise<string | null> {
  const host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';

  let model: string;
  try {
    const tagsRes = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!tagsRes.ok) return null;
    const tags = await tagsRes.json() as { models?: Array<{ name: string }> };
    const models = (tags.models ?? []).map(m => m.name);
    if (!models.length) return null;
    const preferred = ['llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2', 'phi3'];
    model = models.find(m => preferred.some(p => m.startsWith(p))) ?? models[0]!;
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
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
): Promise<string | null> {
  switch (provider) {
    case 'anthropic':
      return tryAnthropic(system, user, key, maxTokens);
    case 'openai':
      return tryOpenAiCompatible(system, user, 'https://api.openai.com/v1/chat/completions', process.env['ALIGN_OPENAI_MODEL'] ?? 'gpt-4o-mini', key, maxTokens);
    case 'gemini':
      return tryGemini(system, user, key, maxTokens);
    case 'groq':
      return tryOpenAiCompatible(system, user, 'https://api.groq.com/openai/v1/chat/completions', process.env['ALIGN_GROQ_MODEL'] ?? 'llama-3.1-8b-instant', key, maxTokens);
    case 'mistral':
      return tryOpenAiCompatible(system, user, 'https://api.mistral.ai/v1/chat/completions', process.env['ALIGN_MISTRAL_MODEL'] ?? 'mistral-small-latest', key, maxTokens);
    case 'grok':
      return tryOpenAiCompatible(system, user, 'https://api.x.ai/v1/chat/completions', process.env['ALIGN_GROK_MODEL'] ?? 'grok-2-latest', key, maxTokens);
  }
}

const ALL_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'gemini', 'groq', 'mistral', 'grok'];

/**
 * Provider-agnostic chat call. Resolution order:
 *   1. explicitly configured provider+key (e.g. from `align setup`)
 *   2. ALIGN_LLM_BASE_URL  - any OpenAI-compatible endpoint (Grok, OpenRouter,
 *      Together, DeepSeek, LM Studio, vLLM, ...) via ALIGN_LLM_MODEL/ALIGN_LLM_API_KEY
 *   3. named providers by env key (Anthropic, OpenAI, Gemini, Groq, Mistral, Grok)
 *   4. local Ollama (no key)
 * Returns the model's text, or null if nothing is available (callers fall back).
 */
export async function callChat(
  system: string,
  user: string,
  opts?: CallChatOptions,
): Promise<string | null> {
  const maxTokens = opts?.maxTokens;

  // 1. configured provider (from align setup) takes priority
  if (opts?.provider && opts.apiKey) {
    const result = await callProvider(opts.provider, opts.apiKey, system, user, maxTokens);
    if (result) return result;
  }

  // 2. generic OpenAI-compatible escape hatch - covers any provider
  const baseUrl = process.env['ALIGN_LLM_BASE_URL'];
  if (baseUrl) {
    const key = process.env['ALIGN_LLM_API_KEY'] ?? '';
    const model = process.env['ALIGN_LLM_MODEL'] ?? 'gpt-4o-mini';
    const result = await tryOpenAiCompatible(system, user, chatCompletionsUrl(baseUrl), model, key, maxTokens);
    if (result) return result;
  }

  // 3. named providers via env keys, in priority order
  for (const provider of ALL_PROVIDERS) {
    if (opts?.provider === provider) continue; // already tried above
    const key = keyForProvider(provider);
    if (key) {
      const result = await callProvider(provider, key, system, user, maxTokens);
      if (result) return result;
    }
  }

  // 4. local Ollama as last resort
  return tryOllama(system, user);
}

/** Synthesise a natural-language answer from retrieved decisions, using any configured provider. */
export async function synthesiseLocally(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  options?: LocalLlmOptions,
): Promise<string | null> {
  const user = buildUserPrompt(question, decisions);
  return callChat(SYSTEM_PROMPT, user, { provider: options?.provider, apiKey: options?.apiKey });
}
