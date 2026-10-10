import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../lib/local-db.js';
import { buildSharePayload } from '../lib/share/payload.js';
import { renderPreview } from '../lib/share/preview.js';
import { visible } from '../lib/share/visible.js';

/**
 * Erasing a user on the server KEEPS the decisions they shared and removes the person (name and judgements) from them. The CLI says so:
 * - the preview carries one line saying it, above "Nothing is sent until you say yes.", so the destination stays the last line before the question;
 * - SECURITY.md and docs/commands.md say it, and say that --retract works while you are on the team and a share stays once you have left;
 * - the --retract option description says it.
 */
const LINE = "A shared decision stays with your team, as the team's record. If you leave and your account is erased, your name and your judgements are removed from it and the decision stays.";
const root = path.resolve(__dirname, '../..');
const read = (f: string): string => fs.readFileSync(path.join(root, f), 'utf8');

const row: DecisionRow = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Use sqlite', summary: 'because node', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github',
  createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, repo: null, deciderKind: 'human', confirmedBy: null, confirmedAt: null, ratifiedBy: 'me@x', ratifiedAt: '2026-09-03T10:00:00.000Z',
};
const preview = renderPreview([buildSharePayload({ row, judgements: [], remoteIdOf: () => undefined, titleOf: () => null, clientKey: 'k', salt: 's', alreadySent: new Set() })], { workspace: 'Acme', env: 'prod', email: 'me@x' });

describe('the preview', () => {
  it('says a share stays with the team, once, directly above "Nothing is sent until you say yes."', () => {
    const lines = preview.split('\n');
    expect(lines.filter((l) => l === visible(LINE))).toHaveLength(1);
    const at = lines.indexOf(visible(LINE));
    expect(lines[at + 1]).toBe('Nothing is sent until you say yes.');
    expect(lines[lines.length - 1]).toMatch(/^To: Acme \(prod\) as me@x$/);
  });
});

describe('the docs', () => {
  it('SECURITY.md carries the erasure bullet after the attribution bullet', () => {
    const s = read('SECURITY.md');
    const bullet = 'A share stays on the team graph after you leave. If an admin erases your account, Align removes your name and your judgements from every decision you shared. The decisions stay as the team\'s record and other people\'s judgements on them stay. Erasure does not edit the decision text; if it names you or holds your personal data, ask your admin for a separate content removal, which does not exist yet.';
    expect(s.replace(/\n>\s+/g, ' ')).toContain(bullet);
    expect(s.indexOf('A share is always attributed')).toBeLessThan(s.replace(/\n>\s+/g, ' ').indexOf(bullet));
  });
  it('docs/commands.md says --retract undoes it only while you are on the team', () => {
    const d = read('docs/commands.md').replace(/\s+/g, ' ');
    expect(d).toContain('`align share --retract <id>` undoes it while you are on the team; once you have left, a share stays as the team\'s record.');
    expect(d).not.toContain('`align share --retract <id>` undoes it.');
  });
  it('the --retract option says a share stays with the team after you leave (the generated reference lists commands, not options, so it carries no copy of this)', () => {
    expect(read('src/commands/share.ts')).toContain("'Archive what you shared for this decision on your team graph (a share stays with the team after you leave)'");
  });
});
