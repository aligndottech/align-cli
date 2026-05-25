export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'mistral';

export interface LocalLlmOptions {
  provider?: AiProvider;
  apiKey?: string;
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

// Shared helper for OpenAI-compatible APIs (OpenAI, Groq, Mistral)
async function tryOpenAiCompatible(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  endpoint: string,
  model: string,
  key: string,
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
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(question, decisions) },
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
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  key: string,
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
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(question, decisions) }],
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
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  key: string,
): Promise<string | null> {
  try {
    const geminiModel = process.env['ALIGN_GEMINI_MODEL'] ?? 'gemini-1.5-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: buildUserPrompt(question, decisions) }] }],
          generationConfig: { maxOutputTokens: 256 },
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

async function tryOllama(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): Promise<string | null> {
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(question, decisions) },
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

function keyForProvider(provider: AiProvider): string | undefined {
  switch (provider) {
    case 'anthropic': return process.env['ANTHROPIC_API_KEY'];
    case 'openai':    return process.env['OPENAI_API_KEY'];
    case 'gemini':    return process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    case 'groq':      return process.env['GROQ_API_KEY'];
    case 'mistral':   return process.env['MISTRAL_API_KEY'];
  }
}

async function callProvider(
  provider: AiProvider,
  key: string,
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
): Promise<string | null> {
  switch (provider) {
    case 'anthropic':
      return tryAnthropic(question, decisions, key);
    case 'openai':
      return tryOpenAiCompatible(question, decisions, 'https://api.openai.com/v1/chat/completions', process.env['ALIGN_OPENAI_MODEL'] ?? 'gpt-4o-mini', key);
    case 'gemini':
      return tryGemini(question, decisions, key);
    case 'groq':
      return tryOpenAiCompatible(question, decisions, 'https://api.groq.com/openai/v1/chat/completions', process.env['ALIGN_GROQ_MODEL'] ?? 'llama-3.1-8b-instant', key);
    case 'mistral':
      return tryOpenAiCompatible(question, decisions, 'https://api.mistral.ai/v1/chat/completions', process.env['ALIGN_MISTRAL_MODEL'] ?? 'mistral-small-latest', key);
  }
}

const ALL_PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'gemini', 'groq', 'mistral'];

export async function synthesiseLocally(
  question: string,
  decisions: Array<{ id: string; title: string; summary: string }>,
  options?: LocalLlmOptions,
): Promise<string | null> {
  // Configured provider (from align setup) takes priority
  if (options?.provider && options.apiKey) {
    const result = await callProvider(options.provider, options.apiKey, question, decisions);
    if (result) return result;
  }

  // Fall through to env vars for any provider
  for (const provider of ALL_PROVIDERS) {
    if (options?.provider === provider) continue; // already tried above
    const key = keyForProvider(provider);
    if (key) {
      const result = await callProvider(provider, key, question, decisions);
      if (result) return result;
    }
  }

  // Local Ollama as last resort
  return tryOllama(question, decisions);
}
