import { hardenGitEnv } from './git-safe-env.js';

/*
 * Imported by index.ts after the startup-env snapshot, so the snapshot still holds the shell's
 * own environment, and before any command runs git.
 */
hardenGitEnv();
