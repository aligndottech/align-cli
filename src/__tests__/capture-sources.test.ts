import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPTURE_SOURCES } from '../lib/capture-sources.js';

/**
 * ALI-827: the label/unit table is keyed by connector id, and every `align import <id>`
 * command is a file of that name. Hold the two sets equal, so a connector added without
 * a noun (or a noun for a connector that does not exist) fails here rather than printing
 * "12 undefined" at the end of someone's import.
 */
describe('CAPTURE_SOURCES covers exactly the import commands', () => {
  const commandsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'import');
  const commandIds = readdirSync(commandsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();

  it('found the commands at all (the positive control for the parity below)', () => {
    expect(commandIds.length).toBeGreaterThan(5);
    expect(commandIds).toContain('slack');
  });

  it('has one entry per import command, and no entry without one', () => {
    expect(Object.keys(CAPTURE_SOURCES).sort()).toEqual(commandIds);
  });

  it('gives every entry a label and a unit noun', () => {
    for (const [id, source] of Object.entries(CAPTURE_SOURCES)) {
      expect(source.label, id).not.toBe('');
      expect(source.unit, id).not.toBe('');
    }
  });
});
