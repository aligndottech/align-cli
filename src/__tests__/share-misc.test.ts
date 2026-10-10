import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { registerShareCommand } from '../commands/share.js';
import { BOOK_CALL_URL, TEAM_SIGNUP_URL, teamCtaLine } from '../lib/team-cta.js';

/**
 * L9 Test List, small facts:
 * - `align push` is an alias of `align share` (one command, two names).
 * - The booking URL is a named constant, https, and the only place it is spelled in src (the TODO to confirm it lives beside it).
 * - The CTA names the booking link while signup is closed and the signup link when open.
 * - The share path never builds a request from the CLI's own telemetry: no new telemetry event or funnel stage is added by L9.
 */
describe('the command', () => {
  it('is share, with push as its alias', () => {
    const program = new Command(); registerShareCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'share')!;
    expect(cmd.aliases()).toEqual(['push']);
  });
});

describe('the team call to action', () => {
  it('names the right link for each state, and the booking constant is https', () => {
    expect(teamCtaLine(false)).toContain(BOOK_CALL_URL);
    expect(teamCtaLine(true)).toContain(TEAM_SIGNUP_URL);
    expect(BOOK_CALL_URL.startsWith('https://')).toBe(true);
  });
  it('spells the booking URL in exactly one source file', () => {
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (p.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes('align.tech/demo')) hits.push(path.basename(p));
      }
    };
    walk(path.join(__dirname, '..'));
    expect(hits).toEqual(['team-cta.ts']);
  });
  it('the share modules add no telemetry call', () => {
    for (const f of ['command.ts', 'run.ts', 'pending.ts', 'payload.ts']) {
      expect(fs.readFileSync(path.join(__dirname, '../lib/share', f), 'utf8')).not.toMatch(/usage-telemetry|recordFunnelStage/);
    }
    expect(fs.readFileSync(path.join(__dirname, '../lib/mcp/share-tool.ts'), 'utf8')).not.toMatch(/usage-telemetry|recordFunnelStage/);
  });
});
