import { describe, expect, it } from 'vitest';
import { describeFatal } from '../lib/fatal.js';
import { UnknownEnvError } from '../lib/resolve-env.js';

describe('describeFatal', () => {
  it('an unknown environment is a usage error: exit 2, the message alone, no bug-report footer', () => {
    const r = describeFatal(new UnknownEnvError('acme', []), false);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toContain('Unknown environment "acme"');
    expect(r.lines.join('\n')).not.toContain('issues');
  });

  it('any other error still exits 1 with the report footer', () => {
    const r = describeFatal(new Error('boom'), false);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('align: boom');
    expect(r.lines.join('\n')).toContain('https://github.com/aligndottech/align-cli/issues');
  });

  it('a non-Error throw is wrapped and exits 1', () => {
    expect(describeFatal('plain', false).code).toBe(1);
  });
});
