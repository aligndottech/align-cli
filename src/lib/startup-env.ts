/**
 * The environment as the user's shell handed it to align, captured before any align module
 * runs (index.ts imports this first). The launcher restores every LLM provider variable to
 * this snapshot before starting a coding agent, so a key align put into its own environment
 * can never reach the agent, while a key the user exported always does.
 */
export const STARTUP_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });
