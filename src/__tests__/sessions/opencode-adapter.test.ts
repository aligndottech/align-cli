/**
 * ALI-808 opencode adapter, backed by a real `opencode run` session fixture (see
 * fixtures/sessions/README.md). opencode's real storage is SQLite (since v1.2.0), not a
 * text format - so unlike the other three adapters, one database file holds many sessions.
 * locateSessionFiles therefore returns composite identifiers (`<dbPath>#<sessionId>`), and
 * the fixture is a SQL dump loaded into a throwaway `node:sqlite` database per test.
 *
 * Test List:
 * 1. parseSession reads the real fixture: right agent/sessionId/cwd (from session.directory)
 * 2. the user turn's text is the real prompt
 * 3. the tool part is captured as both a toolCall AND its result on the SAME turn - unlike
 *    the JSONL agents, opencode records a call and its output in one row (state.input /
 *    state.output), so there is no pending-result carry-forward here
 * 4. internal bookkeeping parts (step-start, step-finish, reasoning) are not toolCalls
 * 5. parseSession returns null for a session id that is not in the database
 * 6. locateSessionFilesUnder matches sessions whose directory equals the target cwd
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locateSessionFilesUnder, opencodeAdapter } from '../../lib/sessions/adapters/opencode.js';

const FIXTURE_SQL = join(__dirname, '..', 'fixtures', 'sessions', 'opencode', 'retry-policy-decision.sql');

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'align-opencode-'));
  dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  const sql = readFileSync(FIXTURE_SQL, 'utf8');
  for (const stmt of sql.split(';\n').map(s => s.trim()).filter(Boolean)) {
    db.exec(`${stmt};`);
  }
  db.close();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('opencodeAdapter.parseSession', () => {
  it('reads the real fixture into the canonical shape', () => {
    const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`);
    expect(session).not.toBeNull();
    expect(session!.agent).toBe('opencode');
    expect(session!.sessionId).toBe('ses_f98790161ffeMW7hbl2WkjJUPP');
    expect(session!.cwd).toBe('/home/user/webhook-service');
  });

  it("the user turn's text is the real prompt", () => {
    const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`)!;
    expect(session.turns[0].role).toBe('user');
    expect(session.turns[0].text).toMatch(/Decide the retry count/);
  });

  it('captures a tool part as a toolCall AND its result on the same turn', () => {
    const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`)!;
    const withTool = session.turns.find(t => t.toolCalls.length > 0);
    expect(withTool).toBeDefined();
    expect(withTool!.toolCalls[0]).toMatchObject({ name: 'read' });
    const id = withTool!.toolCalls[0].id;
    expect(withTool!.toolResults[id]).toMatch(/NOTES\.md/);
  });

  it('does not turn step-start/step-finish/reasoning parts into toolCalls', () => {
    const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`)!;
    const allToolNames = session.turns.flatMap(t => t.toolCalls.map(c => c.name));
    expect(allToolNames).toEqual(['read']);
  });

  it('the final assistant turn carries the real decision text', () => {
    const session = opencodeAdapter.parseSession(`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`)!;
    expect(session.turns.some(t => t.text.includes('5 retries'))).toBe(true);
  });

  it('returns null for a session id that is not in the database', () => {
    expect(opencodeAdapter.parseSession(`${dbPath}#ses_does_not_exist`)).toBeNull();
  });
});

describe('locateSessionFilesUnder (opencode)', () => {
  it('matches sessions whose directory equals the target cwd, as composite ids', () => {
    const found = locateSessionFilesUnder(dbPath, '/home/user/webhook-service');
    expect(found).toEqual([`${dbPath}#ses_f98790161ffeMW7hbl2WkjJUPP`]);
  });

  it('a non-matching cwd finds nothing', () => {
    expect(locateSessionFilesUnder(dbPath, '/nowhere')).toEqual([]);
  });

  it('a database file that does not exist yields no sessions', () => {
    expect(locateSessionFilesUnder(join(dir, 'missing.db'), '/anything')).toEqual([]);
  });
});
