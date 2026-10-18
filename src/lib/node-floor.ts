import { MIN_NODE, nodeMeetsFloor } from './doctor.js';

/**
 * What to tell a person on a Node older than the floor, or null when the runtime is fine.
 * Pure, and it must stay free of imports that reach node:sqlite: it runs before the CLI loads.
 */
export function nodeFloorMessage(version: string): string | null {
  if (nodeMeetsFloor(version)) return null;
  return [
    `align needs Node ${MIN_NODE} or newer, and this is Node ${version}.`,
    'Install a current Node from https://nodejs.org, open a new terminal, and run align again.',
    'No Node to hand? The binary needs none: curl -fsSL https://align.tech/install.sh | sh',
  ].join('\n');
}
