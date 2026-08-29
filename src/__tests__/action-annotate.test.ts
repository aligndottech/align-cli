/**
 * The annotation renderer: conflicts anchored to the files that produced them.
 *
 * Before align-stack#1652 the gateway had no per-file attribution to give, so the only
 * available output was a bare conflict title in the job log. `conflicts[].matched_files` now
 * names the files whose segment retrieved the conflicting decision, which is what lets a
 * finding land on the Files Changed tab instead of at the top of a job nobody opens.
 *
 * This renderer must never decide the gate. decide.sh owns pass/fail; a rendering failure that
 * turned a real verdict into a broken build would be strictly worse than no annotations.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.github/actions/align-check/annotate.mjs',
);

// A missing subject is FATAL, not a quietly passing suite: every assertion below is satisfied
// by an empty world, so an absent script would read as green.
if (!existsSync(SCRIPT)) throw new Error(`FATAL: ${SCRIPT} is missing`);

/**
 * Render by RUNNING the script, never by importing it.
 *
 * The import form was fine on macOS and Linux and failed to load at all under Vite on
 * Windows, and worse, it meant every case exercised the exported function while the stdin
 * wrapper the action actually invokes went untested - which is where a real cross-platform
 * bug was hiding. A subprocess per case costs milliseconds and tests the entry point.
 *
 * execFileSync throws on a non-zero exit, so every call is also an exit-code assertion:
 * rendering must never fail the gate.
 */
function render(raw: string): string[] {
  const stdout = execFileSync('node', [SCRIPT], { input: raw, encoding: 'utf8' });
  return stdout.split('\n').filter((l) => l.length > 0);
}

function conflicting(conflicts: unknown[]): string {
  return JSON.stringify({ status: 'conflicting', relevant_decisions: [], conflicts, message: 'x' });
}

const CRITICAL = {
  decision_id: 'd1',
  title: 'Set PG_POOL_MAX to 40 in prod gitops',
  reason: 'Existing sets 40, this sets 60.',
  url: 'https://github.com/aligndottech/align-stack/pull/1538',
  severity: 'critical',
  matched_files: ['services/gateway/src/db/pool.ts'],
};

describe('annotate.mjs, run the way the action runs it', () => {
  it('anchors a critical conflict to its file as an error', () => {
    const [line, ...rest] = render(conflicting([CRITICAL]));

    expect(rest).toEqual([]);
    expect(line).toContain('::error file=services/gateway/src/db/pool.ts,line=1');
    expect(line).toContain('CRITICAL: conflicts with "Set PG_POOL_MAX to 40 in prod gitops"');
    expect(line).toContain('pull/1538');
  });

  // Second example for the severity rule. align-stack#1572 was this exact bug one surface
  // over: a header severity taken from the overall status rather than from the conflict.
  it('renders a warning conflict as a warning, not an error', () => {
    const [line] = render(conflicting([{ ...CRITICAL, severity: 'warning' }]));

    expect(line).toContain('::warning file=');
    expect(line).toContain('WARNING: conflicts with');
    expect(line).not.toContain('::error');
  });

  it('emits one annotation per matched file', () => {
    const files = ['services/gateway/src/db/pool.ts', 'services/gateway/src/routes/alignment.ts'];

    const lines = render(conflicting([{ ...CRITICAL, matched_files: files }]));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`file=${files[0]},`);
    expect(lines[1]).toContain(`file=${files[1]},`);
  });

  // Both reasons this happens are real: non-diff content has no file, and a gateway older
  // than align-stack#1652 sends no matched_files at all.
  it('still reports a conflict that has no file to anchor to', () => {
    const lines = render(conflicting([{ ...CRITICAL, matched_files: [] }]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('::error title=');
    expect(lines[0]).not.toContain('file=');
    // Positive control: it is the real finding that survived, not an empty placeholder.
    expect(lines[0]).toContain('Set PG_POOL_MAX to 40 in prod gitops');
  });

  it('still reports a conflict when matched_files is absent entirely', () => {
    const { matched_files: _omitted, ...noFiles } = CRITICAL;

    const lines = render(conflicting([noFiles]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Set PG_POOL_MAX to 40 in prod gitops');
  });

  // A raw newline ends the workflow command, so the rest of a decision title would be
  // interpreted as further commands. This is the injection surface of the renderer itself.
  it('escapes newlines, carriage returns and percent signs in the message', () => {
    const nasty = { ...CRITICAL, reason: 'line one\nline two\rdone 100% sure' };

    const [line] = render(conflicting([nasty]));

    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('%0A');
    expect(line).toContain('%0D');
    expect(line).toContain('100%25 sure');
  });

  // The only caller-controlled PROPERTY is the file path (a decision's title goes in the
  // message body, where commas and colons are harmless). Paths may legally contain both, and
  // either one unescaped ends the property early and corrupts the rest of the command.
  it('escapes commas and colons in the file path so it cannot break out of its property', () => {
    const odd = { ...CRITICAL, matched_files: ['src/weird,name:file.ts'] };

    const [line] = render(conflicting([odd]));

    const properties = line.slice(0, line.indexOf('::', 2));
    expect(properties).toContain('src/weird%2Cname%3Afile.ts');
    // Positive control: the property section really was the part inspected, and it still
    // carries the anchor rather than having been emptied by the escaping.
    expect(properties).toContain('file=');
    expect(properties).toContain('line=1');
  });

  it('renders nothing for a check that found no conflicts', () => {
    const aligned = JSON.stringify({ status: 'aligned', relevant_decisions: [], message: 'ok' });

    expect(render(aligned)).toEqual([]);
  });

  it('renders nothing for a check that could not run', () => {
    const unknown = JSON.stringify({ status: 'unknown', reason: 'brain_timeout', message: 'x' });

    expect(render(unknown)).toEqual([]);
  });

  // Distinguishable from "no conflicts" on purpose. A renderer that emits nothing on garbage
  // is indistinguishable from one that is working and has nothing to say, so it can rot
  // silently - which is the failure this whole file exists to avoid one layer down.
  it('says so when the output cannot be parsed, rather than going quiet', () => {
    const lines = render('not json at all');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('::warning::');
    expect(lines[0]).toContain('could not be parsed');
  });

  it('says so for valid JSON that is not an object', () => {
    expect(render('null')[0]).toContain('could not be parsed');
    expect(render('"a string"')[0]).toContain('could not be parsed');
  });
});
describe('the remedy notice (ALI-728)', () => {
  // Measured 2026-08-28/29: three PRs blocked on this gate in one session, and the ONLY way
  // to find the check_event_id a wrong flag needed to be rated against was to grep it out of
  // raw CI job logs. This is that fixed - the annotation is the one surface guaranteed to be
  // in front of whoever was just blocked (writing-voice.md's rendering-contract argument,
  // applied to a gate).
  function conflictingWithEvent(conflicts: unknown[], check_event_id?: string): string {
    return JSON.stringify({
      status: 'conflicting',
      relevant_decisions: [],
      conflicts,
      message: 'x',
      ...(check_event_id ? { check_event_id } : {}),
    });
  }

  const EVENT_ID = '6d0b3185-2645-4dee-ae8a-40b8a5b1c3ea';

  it('names the event id and every remedy command, once, alongside the per-conflict lines', () => {
    const lines = render(conflictingWithEvent([CRITICAL], EVENT_ID));

    // The per-conflict line is unaffected - this is additive, not a replacement.
    expect(lines[0]).toContain('::error file=');

    // Exactly one remedy line, not one per conflict/file - it names ONE event for the whole
    // check, and a per-file repeat would just be noise.
    const notices = lines.filter((l) => l.startsWith('::notice'));
    expect(notices).toHaveLength(1);

    const notice = notices[0];
    expect(notice).toContain(EVENT_ID);
    expect(notice).toContain('/align feedback yes');
    expect(notice).toContain('/align feedback no');
    expect(notice).toContain('/align accept supersession');
    expect(notice).toContain('/align check');
  });

  // Positive control on the cause vocabulary, which is exactly the four values
  // conflictFeedbackCauses.ts declares - drifting from that list is a defect the reader
  // would only discover after typing a rejected command.
  it('names all four false-positive cause codes', () => {
    const [notice] = render(conflictingWithEvent([CRITICAL], EVENT_ID)).filter((l) =>
      l.startsWith('::notice'),
    );

    for (const cause of ['stale_decision', 'not_actually_conflicting', 'wrong_scope', 'duplicate']) {
      expect(notice).toContain(cause);
    }
  });

  // Fails closed: an older gateway that sends no check_event_id must not print a command a
  // human cannot complete. Nothing to reference is nothing to promise.
  it('adds no remedy line when the gateway sent no check_event_id', () => {
    const lines = render(conflicting([CRITICAL]));

    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('::notice'))).toBe(false);
  });

  // A check_event_id with no conflicts is not a shape the gateway should ever send, but the
  // renderer must not promise a remedy for nothing surfaced.
  it('adds no remedy line when there are no conflicts to clear', () => {
    const lines = render(conflictingWithEvent([], EVENT_ID));

    expect(lines).toEqual([]);
  });

  // Same injection surface as the per-conflict body: an event id is server-issued and UUID
  // shaped today, but the renderer must not trust that forever.
  it('escapes a hostile check_event_id the same way conflict text is escaped', () => {
    const hostileId = `evil${String.fromCharCode(10)}id 100% ${String.fromCharCode(13)} sure`;
    const [notice] = render(conflictingWithEvent([CRITICAL], hostileId)).filter((l) =>
      l.startsWith('::notice'),
    );

    expect(notice.split(String.fromCharCode(10))).toHaveLength(1);
    expect(notice).toContain('100%25');
  });
});


describe('the script is invoked the way the action invokes it', () => {
  // Every case above now runs the file, so the stdin wrapper and the exit code are already
  // covered. What is NOT covered by them is the shape of the invocation: the action calls
  // `node "<action_path>/annotate.mjs"` with an ABSOLUTE path, and the direct-run guard
  // compares that path against import.meta.url. Comparing basenames split on '/' found no
  // separator on Windows, so the guard was false and the script printed nothing - inert on
  // every windows runner, with the old import-based tests passing throughout.
  it('produces output when run by absolute path, as the action does', () => {
    const absolute = resolve(SCRIPT);
    expect(isAbsolute(absolute)).toBe(true);

    const stdout = execFileSync('node', [absolute], {
      input: conflicting([CRITICAL]),
      encoding: 'utf8',
    });

    expect(stdout.trim()).toContain('::error file=');
  });
});
