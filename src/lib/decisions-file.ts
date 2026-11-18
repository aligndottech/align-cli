/**
 * Read a committed decisions file (the one `align up --out DECISIONS.md` writes) back into decisions,
 * for `align check --decisions-file`.
 *
 * A parser, not a model: which lines are decisions has one right answer, and the renderer
 * (`renderDecisionsFile` in decisions-context.ts) is the only writer of the format. Each bullet is
 * `- title (cite) - url [decider label]`, optionally followed by an indented `Why: reason` line.
 * The pieces are peeled from the right, so a title that holds " - " or parentheses stays whole.
 *
 * A file that yields no decision is an ERROR. A gate that checks against an empty set passes every
 * change, and "the file had nothing in it" must never look like "the change conflicts with nothing".
 */
import { readFileSync } from 'node:fs';

export interface FileDecision {
  kind: 'rule' | 'decision';
  title: string;
  /** `repo#12`, `owner/repo#12` or `repo@sha`: the forms `align up` writes. Anything else in parentheses ("(draft)", "(@acme/auth)") is part of the title. */
  cite?: string;
  url?: string;
  why?: string;
}

export type DecisionsFileFailure = 'decisions_file_unreadable' | 'decisions_file_empty';

export class DecisionsFileError extends Error {
  constructor(readonly reason: DecisionsFileFailure, message: string) {
    super(message);
    this.name = 'DecisionsFileError';
  }
}

const RULES_HEADING = /^##\s+Rules written in this repo\s*$/i;
// An agent's unratified claim is not something a human decided, and the file itself says not to treat it as governing.
const UNRATIFIED_HEADING = /^##\s+Agent-decided, not yet ratified/i;
const LABEL = /\s\[(agent-decided[^\]]*)\]$/;
const URL_TAIL = /\s-\s(https?:\/\/\S+)$/;
const CITE_TAIL = /\s\(((?:[\w.-]+\/)?[\w.-]+#\d+|[\w.-]+@[0-9a-f]{7,40})\)$/;
const WHY = /^\s+Why:\s*(.*)$/;

function decisionFromBullet(text: string, kind: FileDecision['kind']): FileDecision {
  let rest = text.trim().replace(LABEL, '');
  const url = URL_TAIL.exec(rest)?.[1];
  if (url) rest = rest.replace(URL_TAIL, '');
  const cite = CITE_TAIL.exec(rest)?.[1];
  if (cite) rest = rest.replace(CITE_TAIL, '');
  return { kind, title: rest.trim(), ...(cite ? { cite } : {}), ...(url ? { url } : {}) };
}

export function parseDecisionsFile(text: string, label = 'the decisions file'): FileDecision[] {
  const decisions: FileDecision[] = [];
  let kind: FileDecision['kind'] = 'decision';
  let skipping = false;
  let current: FileDecision | null = null;
  let why = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(raw)) {
      skipping = UNRATIFIED_HEADING.test(raw);
      kind = RULES_HEADING.test(raw) ? 'rule' : 'decision';
      current = null;
      why = false;
      continue;
    }
    if (skipping) continue;
    if (raw.startsWith('- ')) {
      current = decisionFromBullet(raw.slice(2), kind);
      if (current.title) decisions.push(current);
      why = false;
      continue;
    }
    const w = current ? WHY.exec(raw) : null;
    if (current && w) {
      current.why = w[1]!.trim();
      why = true;
      continue;
    }
    // A wrapped reason: indented, after a Why line, before the next bullet or blank line.
    if (current && why && /^\s+\S/.test(raw)) {
      current.why = `${current.why ?? ''} ${raw.trim()}`.trim();
      continue;
    }
    why = false;
    if (raw.trim() === '') continue;
    // Prose between bullets (the header, the "left out" line) is not a decision and ends the one above it.
    current = null;
  }
  if (decisions.length === 0) {
    throw new DecisionsFileError(
      'decisions_file_empty',
      `Found no decisions in ${label}. Expected bullet lines ("- title") as \`align up --out\` writes them. ` +
        'A check against no decisions would pass every change, so this is an error, not a clean check.',
    );
  }
  return decisions;
}

export function readDecisionsFile(path: string): FileDecision[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new DecisionsFileError('decisions_file_unreadable', `Could not read the decisions file ${path}: ${(err as Error).message}`);
  }
  return parseDecisionsFile(text, path);
}
