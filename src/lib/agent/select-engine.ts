/**
 * Which engine bare `align` runs behind Align's UI.
 *
 * An explicit `--engine` is obeyed or refused, never swapped for the other: a person who typed
 * `--engine claude` and got a different model would not know which one answered. A remembered
 * choice is softer, because the machine may have changed since it was saved (Claude Code
 * uninstalled, a key removed), so it falls back to the default. The default prefers Align's own
 * engine when a model is configured, then the user's own Claude Code, which keeps a subscription
 * user on their subscription with no key to buy.
 */
export type EngineName = 'align' | 'claude';

export interface EngineFacts {
  flag?: EngineName;
  remembered?: EngineName;
  /** A model the Align engine can run on: a saved or exported key, or a reachable Ollama. */
  hasModel: boolean;
  claudeOnPath: boolean;
}

export type EngineChoice = { engine: 'align' } | { engine: 'claude-code' } | { engine: 'none'; unavailable?: EngineName };

function runnable(name: EngineName, f: EngineFacts): EngineChoice | undefined {
  if (name === 'align') return f.hasModel ? { engine: 'align' } : undefined;
  return f.claudeOnPath ? { engine: 'claude-code' } : undefined;
}

export function selectEngine(f: EngineFacts): EngineChoice {
  if (f.flag) return runnable(f.flag, f) ?? { engine: 'none', unavailable: f.flag };
  const remembered = f.remembered && runnable(f.remembered, f);
  if (remembered) return remembered;
  return runnable('align', f) ?? runnable('claude', f) ?? { engine: 'none' };
}
