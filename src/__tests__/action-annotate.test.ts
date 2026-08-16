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
import { dirname, join } from 'node:path';

import { annotationsFor } from '../../.github/actions/align-check/annotate.mjs';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.github/actions/align-check/annotate.mjs',
);

// A missing subject is FATAL, not a quietly passing suite: every assertion below is satisfied
// by an empty world, so an absent script would read as green.
if (!existsSync(SCRIPT)) throw new Error(`FATAL: ${SCRIPT} is missing`);

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

describe('annotationsFor', () => {
  it('anchors a critical conflict to its file as an error', () => {
    const [line, ...rest] = annotationsFor(conflicting([CRITICAL]));

    expect(rest).toEqual([]);
    expect(line).toContain('::error file=services/gateway/src/db/pool.ts,line=1');
    expect(line).toContain('CRITICAL: conflicts with "Set PG_POOL_MAX to 40 in prod gitops"');
    expect(line).toContain('pull/1538');
  });

  // Second example for the severity rule. align-stack#1572 was this exact bug one surface
  // over: a header severity taken from the overall status rather than from the conflict.
  it('renders a warning conflict as a warning, not an error', () => {
    const [line] = annotationsFor(conflicting([{ ...CRITICAL, severity: 'warning' }]));

    expect(line).toContain('::warning file=');
    expect(line).toContain('WARNING: conflicts with');
    expect(line).not.toContain('::error');
  });

  it('emits one annotation per matched file', () => {
    const files = ['services/gateway/src/db/pool.ts', 'services/gateway/src/routes/alignment.ts'];

    const lines = annotationsFor(conflicting([{ ...CRITICAL, matched_files: files }]));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`file=${files[0]},`);
    expect(lines[1]).toContain(`file=${files[1]},`);
  });

  // Both reasons this happens are real: non-diff content has no file, and a gateway older
  // than align-stack#1652 sends no matched_files at all.
  it('still reports a conflict that has no file to anchor to', () => {
    const lines = annotationsFor(conflicting([{ ...CRITICAL, matched_files: [] }]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('::error title=');
    expect(lines[0]).not.toContain('file=');
    // Positive control: it is the real finding that survived, not an empty placeholder.
    expect(lines[0]).toContain('Set PG_POOL_MAX to 40 in prod gitops');
  });

  it('still reports a conflict when matched_files is absent entirely', () => {
    const { matched_files: _omitted, ...noFiles } = CRITICAL;

    const lines = annotationsFor(conflicting([noFiles]));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Set PG_POOL_MAX to 40 in prod gitops');
  });

  // A raw newline ends the workflow command, so the rest of a decision title would be
  // interpreted as further commands. This is the injection surface of the renderer itself.
  it('escapes newlines, carriage returns and percent signs in the message', () => {
    const nasty = { ...CRITICAL, reason: 'line one\nline two\rdone 100% sure' };

    const [line] = annotationsFor(conflicting([nasty]));

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

    const [line] = annotationsFor(conflicting([odd]));

    const properties = line.slice(0, line.indexOf('::', 2));
    expect(properties).toContain('src/weird%2Cname%3Afile.ts');
    // Positive control: the property section really was the part inspected, and it still
    // carries the anchor rather than having been emptied by the escaping.
    expect(properties).toContain('file=');
    expect(properties).toContain('line=1');
  });

  it('renders nothing for a check that found no conflicts', () => {
    const aligned = JSON.stringify({ status: 'aligned', relevant_decisions: [], message: 'ok' });

    expect(annotationsFor(aligned)).toEqual([]);
  });

  it('renders nothing for a check that could not run', () => {
    const unknown = JSON.stringify({ status: 'unknown', reason: 'brain_timeout', message: 'x' });

    expect(annotationsFor(unknown)).toEqual([]);
  });

  // Distinguishable from "no conflicts" on purpose. A renderer that emits nothing on garbage
  // is indistinguishable from one that is working and has nothing to say, so it can rot
  // silently - which is the failure this whole file exists to avoid one layer down.
  it('says so when the output cannot be parsed, rather than going quiet', () => {
    const lines = annotationsFor('not json at all');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('::warning::');
    expect(lines[0]).toContain('could not be parsed');
  });

  it('says so for valid JSON that is not an object', () => {
    expect(annotationsFor('null')[0]).toContain('could not be parsed');
    expect(annotationsFor('"a string"')[0]).toContain('could not be parsed');
  });
});

describe('annotate.mjs as the action runs it', () => {
  // The import-based cases above never touch the stdin wrapper, which is the part the action
  // actually invokes. Proving the function works is not proving the entry point does.
  //
  // execFileSync, not the promisified execFile: only the sync form takes `input`. Passing it
  // to the async one is silently ignored, so the child waits on a stdin nobody closes and the
  // test dies on a timeout rather than on its assertion.
  it('reads the result on stdin and writes annotations on stdout', () => {
    const stdout = execFileSync('node', [SCRIPT], {
      input: conflicting([CRITICAL]),
      encoding: 'utf8',
    });

    expect(stdout.trim()).toContain('::error file=services/gateway/src/db/pool.ts,line=1');
  });

  it('exits 0 even on garbage, so rendering can never fail the gate', () => {
    // execFileSync THROWS on a non-zero exit, so reaching the assertion at all is itself the
    // exit-code check.
    const stdout = execFileSync('node', [SCRIPT], { input: 'garbage', encoding: 'utf8' });

    expect(stdout).toContain('could not be parsed');
  });
});
