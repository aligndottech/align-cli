import { describe, expect, it } from 'vitest';

import { TOOL_SCHEMAS } from '../commands/mcp.js';
import {
  DECISION_RATIONALE_TOOL,
  MAX_ACCEPTANCE_CRITERIA_CHARS,
  MAX_ACTION_CHARS,
  MAX_ACTIONS,
  shapeDecisionRationale,
} from '../lib/mcp-timeline-tools.js';

/**
 * ALI-1426, the align-cli half. Measured on AlignBench v11 (gh-token item), which runs this
 * server through `align mcp`: the decision stores its goals, acceptance criteria and actions
 * under `decision_json.ai`. `shapeDecisionRationale` read goals from the top level only, so
 * they came back `[]`, and never returned acceptance criteria or actions at all - so the
 * prescribed fix never reached the agent.
 *
 * The hosted connector carried the same defect and was fixed in align-stack#3049. The
 * semantics here mirror that fix exactly (deployment-mode parity).
 *
 * Test list:
 *  goals - from ai.goals; an empty top level yields to ai; a populated top level wins; a
 *          non-array top level is treated as empty.
 *  acceptance_criteria - from ai verbatim; absent when not stored or blank; top level wins;
 *          whitespace does not count toward the cap; capped with a flag; exactly-at-cap is
 *          not flagged.
 *  actions - object and string entries become text; absent when none; unusable entries are
 *          dropped; an unusable top-level list yields to ai; a populated top level wins; the
 *          count cap and the length cap each set the flag alone; exactly-at-both caps is not
 *          flagged.
 *
 * Every fixture value is distinct from every other field, so a mapping that reads the wrong
 * key cannot pass by coincidence.
 */

const AI = {
  rationale: 'An empty GH_TOKEN falls back to the active account, which is not the align one.',
  goals: ['Every documented gh call runs as tom-at-align'],
  risks: ['A public repo answers a narrower question as a non-collaborator'],
  acceptance_criteria:
    'Solution: Replace all 7 occurrences with ALIGN_GH_TOKEN=$(gh auth token --user tom-at-align) || exit 1 / GH_TOKEN="$ALIGN_GH_TOKEN" gh ...',
  actions: [
    { text: 'Add check-gh-token-form.sh to Repo Guards', owner: 'tom', due: '2026-09-20' },
    'Rewrite the AGENTS.md one-liner',
  ],
};

const run = (decisionJson: Record<string, unknown>) =>
  shapeDecisionRationale(
    {
      id: 'd-gh',
      title: 'Resolve the align account token before every gh call',
      summary: 'Seven documented gh one-liners ran as the active keyring account.',
      status: 'active',
      platform: 'github',
      created_at: '2026-09-13T10:00:00.000Z',
      decision_json: decisionJson,
    },
    'd-gh',
  );

describe('decision rationale goals (ALI-1426)', () => {
  it('returns goals stored only under decision_json.ai', () => {
    expect(run({ ai: AI })['goals']).toEqual(['Every documented gh call runs as tom-at-align']);
  });

  it('lets an empty top-level goals yield to a populated ai.goals', () => {
    expect(run({ goals: [], ai: AI })['goals']).toEqual([
      'Every documented gh call runs as tom-at-align',
    ]);
  });

  it('keeps a populated top-level goals ahead of ai.goals', () => {
    expect(run({ goals: ['Top-level goal'], ai: AI })['goals']).toEqual(['Top-level goal']);
  });

  it('treats a non-array top-level goals as empty', () => {
    expect(run({ goals: 'not a list', ai: AI })['goals']).toEqual([
      'Every documented gh call runs as tom-at-align',
    ]);
  });
});

describe('decision rationale acceptance_criteria (ALI-1426)', () => {
  it('returns the stored ai.acceptance_criteria verbatim', () => {
    const out = run({ ai: AI });
    expect(out['acceptance_criteria']).toBe(AI.acceptance_criteria);
    expect('acceptance_criteria_truncated' in out).toBe(false);
  });

  it('omits the key when none was stored', () => {
    expect('acceptance_criteria' in run({ ai: { rationale: AI.rationale } })).toBe(false);
  });

  it('omits the key when the stored value is blank', () => {
    expect('acceptance_criteria' in run({ ai: { acceptance_criteria: '   ' } })).toBe(false);
  });

  it('keeps a top-level acceptance_criteria ahead of ai.acceptance_criteria', () => {
    expect(run({ acceptance_criteria: 'Top-level criteria', ai: AI })['acceptance_criteria']).toBe(
      'Top-level criteria',
    );
  });

  it('does not count surrounding whitespace toward the bound', () => {
    const out = run({
      ai: { acceptance_criteria: `  ${'f'.repeat(MAX_ACCEPTANCE_CRITERIA_CHARS)}  ` },
    });
    expect(out['acceptance_criteria']).toBe('f'.repeat(MAX_ACCEPTANCE_CRITERIA_CHARS));
    expect('acceptance_criteria_truncated' in out).toBe(false);
  });

  it('caps acceptance_criteria at the bound and says it did', () => {
    const out = run({
      ai: { acceptance_criteria: `${'a'.repeat(MAX_ACCEPTANCE_CRITERIA_CHARS)}TAIL-PAST-THE-CAP` },
    });
    expect(out['acceptance_criteria']).toHaveLength(MAX_ACCEPTANCE_CRITERIA_CHARS);
    expect(out['acceptance_criteria']).not.toContain('TAIL');
    expect(out['acceptance_criteria_truncated']).toBe(true);
  });

  it('does not flag a value exactly at the bound as truncated', () => {
    const out = run({ ai: { acceptance_criteria: 'b'.repeat(MAX_ACCEPTANCE_CRITERIA_CHARS) } });
    expect(out['acceptance_criteria']).toHaveLength(MAX_ACCEPTANCE_CRITERIA_CHARS);
    expect('acceptance_criteria_truncated' in out).toBe(false);
  });

  it('pins the bound at 1200 characters, matching the hosted connector', () => {
    expect(MAX_ACCEPTANCE_CRITERIA_CHARS).toBe(1200);
  });
});

describe('decision rationale actions (ALI-1426)', () => {
  it('returns stored ai.actions as text, from both object and string entries', () => {
    const out = run({ ai: AI });
    expect(out['actions']).toEqual([
      'Add check-gh-token-form.sh to Repo Guards',
      'Rewrite the AGENTS.md one-liner',
    ]);
    expect('actions_truncated' in out).toBe(false);
  });

  it('omits the key when no actions were stored', () => {
    expect('actions' in run({ ai: { rationale: AI.rationale } })).toBe(false);
  });

  it('drops entries with no usable text', () => {
    expect(run({ ai: { actions: [{ owner: 'tom' }, 42, '', null, 'Real action'] } })['actions']).toEqual([
      'Real action',
    ]);
  });

  it('lets a top-level list with no usable text yield to ai.actions', () => {
    expect(run({ actions: [{ owner: 'tom' }, null], ai: AI })['actions']).toEqual([
      'Add check-gh-token-form.sh to Repo Guards',
      'Rewrite the AGENTS.md one-liner',
    ]);
  });

  it('lets an empty top-level list yield to ai.actions', () => {
    expect(run({ actions: [], ai: AI })['actions']).toEqual([
      'Add check-gh-token-form.sh to Repo Guards',
      'Rewrite the AGENTS.md one-liner',
    ]);
  });

  it('keeps populated top-level actions ahead of ai.actions', () => {
    expect(run({ actions: ['Top-level action'], ai: AI })['actions']).toEqual(['Top-level action']);
  });

  it('flags truncation when one action is over the length cap, with the count under it', () => {
    const out = run({ ai: { actions: [`${'d'.repeat(MAX_ACTION_CHARS)}X`] } });
    expect((out['actions'] as string[])[0]).toHaveLength(MAX_ACTION_CHARS);
    expect(out['actions_truncated']).toBe(true);
  });

  it('flags truncation when the count is over the cap, with every action under the length cap', () => {
    const out = run({
      ai: { actions: Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => `a${i}`) },
    });
    expect(out['actions']).toHaveLength(MAX_ACTIONS);
    expect(out['actions']).not.toContain(`a${MAX_ACTIONS}`);
    expect(out['actions_truncated']).toBe(true);
  });

  it('does not flag exactly MAX_ACTIONS actions at exactly the length cap', () => {
    const out = run({
      ai: { actions: Array.from({ length: MAX_ACTIONS }, () => 'e'.repeat(MAX_ACTION_CHARS)) },
    });
    expect(out['actions']).toHaveLength(MAX_ACTIONS);
    expect('actions_truncated' in out).toBe(false);
  });

  it('pins the caps at 10 actions of 300 characters, matching the hosted connector', () => {
    expect([MAX_ACTIONS, MAX_ACTION_CHARS]).toEqual([10, 300]);
  });
});

describe('decision rationale tool description (ALI-1426)', () => {
  it('tells the agent the response can carry acceptance criteria and actions', () => {
    const tool = TOOL_SCHEMAS.find((t) => t.name === DECISION_RATIONALE_TOOL);
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/acceptance criteria/);
    expect(tool?.description).toMatch(/\bactions\b/);
  });
});
