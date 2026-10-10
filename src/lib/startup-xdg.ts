import { dropRelativeXdg } from './xdg.js';

/*
 * Imported second by index.ts, right after the startup-env snapshot and before any module that
 * computes a directory (`conf`, env-paths, local-mode): a relative XDG_* is invalid per the XDG
 * spec, and in the MCP child of an agent that loads a repo `.env` it would point align's config,
 * cache and local.db into that repo.
 */
dropRelativeXdg(process.env);
