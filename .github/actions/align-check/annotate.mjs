#!/usr/bin/env node
/**
 * Render Align conflicts as GitHub workflow annotations, anchored to the files that produced
 * them.
 *
 * Reads the CLI's `--ci` JSON on stdin, writes workflow commands on stdout. It exists as its
 * own file for the same reason decide.sh does: inline in a `run:` block the only way to
 * exercise it is to push to a real repository, which is how a stray `esac` once shipped.
 *
 * The anchor comes from `conflicts[].matched_files`, which the gateway populates with the
 * files whose segment retrieved the conflicting decision (align-stack#1652). Before that the
 * only available output was a bare conflict title in the job log, with nothing tying it to a
 * line a reviewer could open.
 *
 * This NEVER decides the gate. decide.sh owns pass/fail; everything here is presentation, and
 * a failure to render must not turn a real verdict into a broken build.
 */

import { pathToFileURL } from 'node:url';

/** align-stack#1420: reasons are capped, with the full text living in the check summary. */
const MAX_REASON_CHARS = 400;

/**
 * Workflow commands are line-oriented, so a raw newline in a decision title silently truncates
 * the annotation and leaves the remainder to be interpreted as further commands. GitHub's
 * documented escapes are the only safe way to carry arbitrary text.
 */
function escapeData(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Property values additionally sit inside a comma-separated, colon-terminated list, so a
 * decision title containing either character would otherwise break out of its property.
 * Applied AFTER escapeData, whose output (%25, %0D, %0A) contains neither.
 */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

const COULD_NOT_RENDER =
  '::warning::Align check ran, but its output could not be parsed, so no file annotations were ' +
  'rendered. The gate result itself is unaffected - see the job summary for the verdict.';

/**
 * ALI-728: the four false-positive causes a human can give `/align feedback no <cause>`.
 *
 * Authoritative source is align-stack's FP_CAUSE_VALUES
 * (connectors/mcp-github/src/application/utils/conflictFeedbackCauses.ts) - a Zod enum the
 * gateway's /alignment/conflicts/:eventId/feedback route also enforces. This is a SECOND
 * writer, unavoidable across two repos with no shared package for four string literals, and
 * it is named as one rather than left implicit: if either list widens, this one goes stale
 * silently (no test here can see the other repo's file), so keep them in sync by hand.
 */
const FP_CAUSES = ['stale_decision', 'not_actually_conflicting', 'wrong_scope', 'duplicate'];

/**
 * The remedy for a wrong flag, named on the PR rather than left to be found in a job log.
 *
 * Measured 2026-08-28/29 (align-stack, three PRs in one session): the only way to find the
 * check_event_id a wrong conflict needed to be rated against was to grep it out of raw CI job
 * logs, because the required Gate emits annotations only - no comment, no event id, no
 * remedy. The advisory App's Align Report DOES carry this, on the surface that is retiring
 * (ALI-600) and that a Marketplace-only adopter never has at all. The annotation is the one
 * surface guaranteed to be in front of whoever was just blocked, with no App required.
 *
 * A worked template, not an adjective telling the model to "explain how to fix it"
 * (writing-voice.md: a template with placeholders beats prose about clarity every time).
 *
 * One line for the whole check, not per-conflict/file: it names ONE event, and repeating the
 * same four commands per file would be exactly the wall-of-text writing-voice.md's rendering
 * contracts exist to prevent.
 */
function remedyNotice(checkEventId) {
  const causes = FP_CAUSES.join(', ');
  const body = escapeData(
    `Wrong? Reply on this PR: \`/align feedback yes\` if this is a real conflict, ` +
      `\`/align feedback no <cause>\` if not (${causes}), or \`/align accept supersession\` if ` +
      `this deliberately replaces the decision it names. event: ${checkEventId}. ` +
      `Re-run with \`/align check\` after. Needs the Align GitHub App installed - a ` +
      `Marketplace-Action-only repo has no listener for these yet (ALI-728).`,
  );
  return `::notice title=${escapeProperty('Align: how to clear this if it is wrong')}::${body}`;
}

/**
 * @param {string} raw the CLI's JSON result
 * @returns {string[]} workflow command lines, one per annotation
 */
export function annotationsFor(raw) {
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    // Distinguishable from "no conflicts", deliberately. A renderer that silently emits
    // nothing on malformed input is indistinguishable from one that is working and has
    // nothing to say, so it can rot for months without anyone noticing.
    return [COULD_NOT_RENDER];
  }
  if (result === null || typeof result !== 'object') return [COULD_NOT_RENDER];

  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  const lines = [];

  for (const conflict of conflicts) {
    // Per conflict, never from the overall status. align-stack#1572 was exactly this bug in
    // the comment renderer: a header that said Warning above a body holding a Critical.
    const critical = conflict?.severity === 'critical';
    const level = critical ? 'error' : 'warning';
    const severity = critical ? 'CRITICAL' : 'WARNING';

    // Severity spelled out, no emoji (align-stack#1419).
    const title = escapeProperty(`Align: ${severity} conflict with a recorded decision`);
    const reason = String(conflict?.reason ?? '').slice(0, MAX_REASON_CHARS);
    const url = conflict?.url ? ` (${conflict.url})` : '';
    const body = escapeData(
      `${severity}: conflicts with "${conflict?.title ?? 'a recorded decision'}". ${reason}${url}`,
    );

    const files = Array.isArray(conflict?.matched_files)
      ? conflict.matched_files.filter((f) => typeof f === 'string' && f.length > 0)
      : [];

    if (files.length === 0) {
      // No anchor available: non-diff content has no file, and a gateway older than
      // align-stack#1652 sends no matched_files at all. Emit it unanchored rather than drop
      // it - a conflict nobody is told about is worse than one in the wrong place.
      lines.push(`::${level} title=${title}::${body}`);
      continue;
    }

    // line=1 because the attribution is file-level: the segment that retrieved the decision
    // is a whole file's hunks, not a line. GitHub requires a line to place the annotation on
    // the diff, and 1 is the conventional choice for a file-scoped finding.
    for (const file of files) {
      lines.push(`::${level} file=${escapeProperty(file)},line=1,title=${title}::${body}`);
    }
  }

  // ALI-728: ONE remedy line for the whole check, appended after every per-conflict line so
  // it reads last - a human opens the Files Changed tab for the findings and the job summary
  // for what to do about them, and this is the second half of that sentence. Nothing to
  // reference (no id, no conflicts) is nothing to promise, so it stays silent rather than
  // printing a command that cannot be completed.
  if (typeof result.check_event_id === 'string' && result.check_event_id && conflicts.length > 0) {
    lines.push(remedyNotice(result.check_event_id));
  }

  return lines;
}

/* c8 ignore start - the stdin wrapper is exercised by running the script, not by importing it */
// pathToFileURL, not a string comparison on the basename. Splitting argv[1] on '/' finds no
// separator on Windows, so the whole backslashed path became the "basename", never matched
// import.meta.url, and the script silently produced nothing. It would have been inert on
// every windows-latest runner using this action, and no test caught it because the tests
// imported the function directly rather than running the file.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    for (const line of annotationsFor(raw)) process.stdout.write(`${line}\n`);
    // Always 0. Rendering is presentation; decide.sh owns the verdict.
    process.exit(0);
  });
}
/* c8 ignore stop */
