import { describe, expect, it } from 'vitest';
import { buildAdvisoryOutput } from '../commands/check.js';

const conflict = (severity: string, title = 'Use Postgres, not Mongo') => ({
  decision_id: 'd1',
  title,
  severity,
  reason: 'This change introduces MongoDB',
  url: 'https://example.test/d1',
});

const critical = [conflict('critical')];
const warning = [conflict('warning')];

// One engine, N hosts. Each host reads a different output shape off stdout; these
// pin the exact field names each one requires, taken from its published schema.
describe('buildAdvisoryOutput - claude (default)', () => {
  it('enriches context on PreToolUse without a permission decision', () => {
    const out = buildAdvisoryOutput(warning, { pre: true, format: 'claude', blockOnCritical: false }) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Use Postgres, not Mongo');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('denies on PreToolUse only when blockOnCritical is set AND a conflict is critical', () => {
    const out = buildAdvisoryOutput(critical, { pre: true, format: 'claude', blockOnCritical: true }) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('does not deny a non-critical conflict even with blockOnCritical set', () => {
    const out = buildAdvisoryOutput(warning, { pre: true, format: 'claude', blockOnCritical: true }) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toBeTruthy();
  });
});

// Gemini's BeforeTool has NO additionalContext channel - `decision`/`reason` is the
// only field it reads - so a non-blocking pre-check must stay silent there and let
// AfterTool carry the context. Emitting nothing is the correct behaviour, not a gap.
describe('buildAdvisoryOutput - gemini', () => {
  it('emits nothing on BeforeTool when not blocking, so the edit is not denied', () => {
    expect(buildAdvisoryOutput(warning, { pre: true, format: 'gemini', blockOnCritical: false })).toBeNull();
  });

  it('uses decision/reason to deny on BeforeTool when blocking a critical conflict', () => {
    const out = buildAdvisoryOutput(critical, { pre: true, format: 'gemini', blockOnCritical: true }) as any;
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('Use Postgres, not Mongo');
  });

  it('uses hookSpecificOutput.additionalContext on AfterTool', () => {
    const out = buildAdvisoryOutput(warning, { pre: false, format: 'gemini', blockOnCritical: false }) as any;
    expect(out.hookSpecificOutput.additionalContext).toContain('Use Postgres, not Mongo');
    expect(out.decision).toBeUndefined();
  });
});

// pi's tool_call can ONLY block; its non-blocking channel is the tool_result content
// patch. So the pre-check emits {context} for the extension to stash and replay.
describe('buildAdvisoryOutput - pi', () => {
  it('emits context (not block) on tool_call when not blocking', () => {
    const out = buildAdvisoryOutput(warning, { pre: true, format: 'pi', blockOnCritical: false }) as any;
    expect(out.block).toBeUndefined();
    expect(out.context).toContain('Use Postgres, not Mongo');
  });

  it('emits block plus reason on tool_call for a critical conflict when blocking', () => {
    const out = buildAdvisoryOutput(critical, { pre: true, format: 'pi', blockOnCritical: true }) as any;
    expect(out.block).toBe(true);
    expect(out.reason).toContain('Use Postgres, not Mongo');
  });

  it('never blocks on tool_result - the edit has already happened', () => {
    const out = buildAdvisoryOutput(critical, { pre: false, format: 'pi', blockOnCritical: true }) as any;
    expect(out.block).toBeUndefined();
    expect(out.context).toBeTruthy();
  });
});

describe('buildAdvisoryOutput - text (universal fallback)', () => {
  it('emits the plain conflict text for a host with no JSON contract', () => {
    const out = buildAdvisoryOutput(warning, { pre: false, format: 'text', blockOnCritical: false });
    expect(typeof out).toBe('string');
    expect(out as string).toContain('Use Postgres, not Mongo');
    expect(out as string).toContain('https://example.test/d1');
  });
});

describe('buildAdvisoryOutput - shared body', () => {
  it('names every conflict and its severity regardless of host', () => {
    const many = [conflict('critical', 'A'), conflict('warning', 'B')];
    for (const format of ['claude', 'gemini', 'pi', 'text'] as const) {
      const out = buildAdvisoryOutput(many, { pre: false, format, blockOnCritical: false });
      const body = JSON.stringify(out);
      expect(body, format).toContain('A');
      expect(body, format).toContain('B');
    }
  });
});

// OpenCode has the same two channels as pi, reached differently: `tool.execute.before`
// blocks by THROWING (it runs before item.execute, so a throw prevents the call), and
// `tool.execute.after` mutates the result object the caller then returns to the model.
// Same output contract, so it shares pi's renderer branch rather than duplicating it.
describe('buildAdvisoryOutput - opencode', () => {
  it('emits context (not block) when not blocking', () => {
    const out = buildAdvisoryOutput(warning, { pre: true, format: 'opencode', blockOnCritical: false }) as any;
    expect(out.block).toBeUndefined();
    expect(out.context).toContain('Use Postgres, not Mongo');
  });

  it('emits block plus reason for a critical conflict when blocking', () => {
    const out = buildAdvisoryOutput(critical, { pre: true, format: 'opencode', blockOnCritical: true }) as any;
    expect(out.block).toBe(true);
    expect(out.reason).toContain('Use Postgres, not Mongo');
  });

  it('never blocks after the edit has already been applied', () => {
    const out = buildAdvisoryOutput(critical, { pre: false, format: 'opencode', blockOnCritical: true }) as any;
    expect(out.block).toBeUndefined();
    expect(out.context).toBeTruthy();
  });
});
