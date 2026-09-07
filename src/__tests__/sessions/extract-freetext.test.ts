/**
 * ALI-809 Pass B, heuristic half: a HUMAN turn whose own words redirect or settle on an
 * approach mid-session ("let's use X instead", "go with Y", "decided to Z"). Never a tool-call
 * answer (that's Pass A, extract-structured.ts) and never assistant text scanned for the
 * trigger phrase - the assistant turn immediately after is attached as CONTEXT only, per the
 * ALI-538 decider-authored-statements principle (the graph decision, not this ticket, but the
 * same shape: don't let bot content pass as the thing being reviewed).
 *
 * The phrase list and every "yields no candidate" case below is calibrated against the four
 * REAL captured sessions in fixtures/sessions/ (not invented) - see the end-to-end describe
 * block. verification.md: a plausible construction is not data.
 *
 * Test List:
 * 1. a human turn containing "instead of" yields one candidate, humanText verbatim
 * 2. a human turn with no decision language yields no candidate
 * 3. an assistant turn containing decision language yields no candidate (human turns only)
 * 4. a candidate captures the immediately-following assistant turn's text as context
 * 5. when the following turn is not an assistant turn (or there isn't one), context is null
 * 6. two qualifying human turns in one session yield two candidates with distinct messageIds
 * 7. real fixture (codex): "We're deciding the retry count..." yields one candidate
 * 8. real fixture (opencode): "Decide the retry count..." yields one candidate
 * 9. real fixture (claude-code): a bug-report question yields no candidate (Pass A's job)
 * 10. real fixture (pi): a bash-command turn yields no candidate
 */
import { describe, expect, it } from 'vitest';
import { findFreeTextCandidates } from '../../lib/sessions/extract-freetext.js';
import type { CanonicalSession, SessionTurn } from '../../lib/sessions/types.js';

function userTurn(text: string, timestamp: string | null = '2026-09-03T00:00:00.000Z'): SessionTurn {
  return { role: 'user', text, toolCalls: [], toolResults: {}, timestamp };
}
function assistantTurn(text: string, timestamp: string | null = '2026-09-03T00:00:05.000Z'): SessionTurn {
  return { role: 'assistant', text, toolCalls: [], toolResults: {}, timestamp };
}

describe('findFreeTextCandidates: heuristic phrase matching', () => {
  it('a human turn containing "instead of" yields one candidate with the verbatim text', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [userTurn('Let\'s cap retries at 3 instead of 5, that is plenty for transient failures.')],
    };
    const candidates = findFreeTextCandidates(session);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      agent: 'codex', sessionId: 's1', messageId: 'turn-0',
      humanText: 'Let\'s cap retries at 3 instead of 5, that is plenty for transient failures.',
      contextText: null,
    });
  });

  it('a human turn with no decision language yields no candidate', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [userTurn('What does this function return on an empty array?')],
    };
    expect(findFreeTextCandidates(session)).toEqual([]);
  });

  it('an assistant turn with decision language yields no candidate - only human turns count', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [assistantTurn('Decided: let\'s go with 5 retries instead of 3.')],
    };
    expect(findFreeTextCandidates(session)).toEqual([]);
  });

  it('captures the immediately-following assistant turn as context', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [
        userTurn('Let\'s go with option B instead.'),
        assistantTurn('Done - option B is now the default.'),
      ],
    };
    expect(findFreeTextCandidates(session)[0].contextText).toBe('Done - option B is now the default.');
  });

  it('context is null when the next turn is not an assistant turn', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [
        userTurn('Let\'s go with option B instead.'),
        userTurn('Actually never mind, ignore that.'),
      ],
    };
    expect(findFreeTextCandidates(session)[0].contextText).toBeNull();
  });

  it('context is null when there is no following turn at all', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [userTurn('Let\'s go with option B instead.')],
    };
    expect(findFreeTextCandidates(session)[0].contextText).toBeNull();
  });

  it('two qualifying human turns yield two candidates with distinct messageIds', () => {
    const session: CanonicalSession = {
      agent: 'codex', sessionId: 's1', cwd: null,
      turns: [
        userTurn('Let\'s go with option B instead.'),
        assistantTurn('Done.'),
        userTurn('Actually, decided to switch to option C after all.'),
      ],
    };
    const candidates = findFreeTextCandidates(session);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(c => c.messageId)).toEqual(['turn-0', 'turn-2']);
  });
});

describe('findFreeTextCandidates: end-to-end against the real fixtures', () => {
  it('the real codex fixture yields one candidate from the imperative "deciding" turn', async () => {
    const { codexAdapter } = await import('../../lib/sessions/adapters/codex.js');
    const { join } = await import('node:path');
    const fixture = join(__dirname, '..', 'fixtures', 'sessions', 'codex', 'retry-policy-decision.jsonl');
    const session = codexAdapter.parseSession(fixture)!;
    const candidates = findFreeTextCandidates(session);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].humanText).toMatch(/deciding the retry count/i);
    expect(candidates[0].contextText).toMatch(/3 retries/i);
  });

  it('the real opencode fixture yields one candidate from the "Decide the retry count" turn', async () => {
    // opencode's real storage is one shared SQLite database (see opencode-adapter.test.ts's
    // own docstring) - the fixture is a SQL dump loaded into a throwaway db, exactly as that
    // suite does, not a file parseSession can read directly.
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { opencodeAdapter } = await import('../../lib/sessions/adapters/opencode.js');

    const dir = mkdtempSync(join(tmpdir(), 'align-freetext-opencode-'));
    try {
      const dbPath = join(dir, 'opencode.db');
      const db = new DatabaseSync(dbPath);
      const sql = readFileSync(join(__dirname, '..', 'fixtures', 'sessions', 'opencode', 'retry-policy-decision.sql'), 'utf8');
      for (const stmt of sql.split(';\n').map(s => s.trim()).filter(Boolean)) db.exec(`${stmt};`);
      db.close();

      const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`)!;
      const candidates = findFreeTextCandidates(session);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].humanText).toMatch(/decide the retry count/i);
      expect(candidates[0].contextText).toMatch(/5 retries/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real claude-code fixture (a bug report, no free-text decision language) yields no candidate', async () => {
    const { claudeCodeAdapter } = await import('../../lib/sessions/adapters/claude-code.js');
    const { join } = await import('node:path');
    const fixture = join(__dirname, '..', 'fixtures', 'sessions', 'claude-code', 'main-red-fix-decision.jsonl');
    const session = claudeCodeAdapter.parseSession(fixture)!;
    expect(findFreeTextCandidates(session)).toEqual([]);
  });

  it('the real pi fixture (a bash command, no free-text decision language) yields no candidate', async () => {
    const { piAdapter } = await import('../../lib/sessions/adapters/pi.js');
    const { join } = await import('node:path');
    const fixture = join(__dirname, '..', 'fixtures', 'sessions', 'pi', 'kubectl-guard-check.jsonl');
    const session = piAdapter.parseSession(fixture)!;
    expect(findFreeTextCandidates(session)).toEqual([]);
  });
});
