/**
 * Which detector a LOCAL Ollama model runs when the user has not chosen one (ALI-1564).
 *
 * v1 is the default detector everywhere, but only qwen2.5 at its default size or 7B and above passed the
 * preregistered rule locally (align-stack addendum 7: recall 90.2%, precision 65.7%). llama3.2 (3B) did
 * not (30 of 51 conflicts), and three attempts to fix its output failed. A model that was never measured
 * is treated as not passing: v0 is the safe default, and an explicit choice (ALIGN_DETECTOR or
 * `align config detector`) always wins over this.
 *
 * Matches the model name only. qwen2.5's default tag (`qwen2.5`, `qwen2.5:latest`) is the 7B build, which
 * is why an unsized tag counts. Other families (`qwen2.5-coder`, `qwen3`) are separate models and are not
 * matched.
 */
export function defaultDetectorForLocalModel(model: string | null): 'v0' | 'v1' {
  if (!model) return 'v0';
  const match = /^qwen2\.5(?::(.*))?$/i.exec(model.trim());
  if (!match) return 'v0';
  const tag = match[1];
  if (tag === undefined || tag === '' || tag.toLowerCase().startsWith('latest')) return 'v1';
  const size = /^(\d+(?:\.\d+)?)b/i.exec(tag);
  return size !== null && Number(size[1]) >= 7 ? 'v1' : 'v0';
}
