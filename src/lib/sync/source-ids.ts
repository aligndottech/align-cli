/**
 * The sources a sync can read, in a module with no imports so the launch path may name them
 * (mcp-backfill.ts re-exports it; localConnectorIds() equals it by test). One list: the launcher
 * filters a summary file's ids against it, and the sync command refuses (or, in the background,
 * skips) anything else.
 */
export const KNOWN_SOURCES = ['github', 'jira', 'confluence', 'slack', 'teams', 'gitlab', 'linear', 'notion'] as const;
export type KnownSource = (typeof KNOWN_SOURCES)[number];
export const isKnownSource = (id: string): id is KnownSource => (KNOWN_SOURCES as readonly string[]).includes(id);
