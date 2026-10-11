import { describe, expect, it } from 'vitest';
import { envFlag, validateDestinationName } from '../lib/destination-name.js';

describe('validateDestinationName', () => {
  it.each(['acme', 'acme-eu', 'a1', 'x'.repeat(32)])('accepts %s', (n) => {
    expect(validateDestinationName(n)).toBeNull();
  });

  it.each([
    ['a:b', 'colon'],
    ['Acme', 'uppercase'],
    ['-x', 'leading hyphen'],
    ['1acme', 'leading digit'],
    ['a', 'one character'],
    ['x'.repeat(33), 'too long'],
    ['', 'empty'],
    ['acme corp', 'space'],
    ['acme\n', 'trailing newline'],
  ])('rejects %j (%s)', (n) => {
    expect(validateDestinationName(n)).not.toBeNull();
  });

  it.each(['prod', 'local', 'preview', 'default', 'all', 'none', 'team', 'align', 'demo'])('rejects reserved name %s', (n) => {
    expect(validateDestinationName(n)).toMatch(/reserved/);
  });

  it('a name that merely contains a reserved word is fine', () => {
    expect(validateDestinationName('prod-eu')).toBeNull();
    expect(validateDestinationName('myprod')).toBeNull();
  });
});

describe('envFlag: the --env argument that goes into a command someone will paste', () => {
  it('prod is the default and adds nothing; preview and a team destination add --env <name>', () => {
    expect(envFlag('prod')).toBe('');
    expect(envFlag('preview')).toBe(' --env preview');
    expect(envFlag('local')).toBe(' --env local');
    expect(envFlag('acme')).toBe(' --env acme');
  });
  it.each(['a;b', 'x y', '$(id)', 'acme`id`', "a'b", 'a|b', '', 'Acme', 'a\nb'])('refuses %j rather than print it into a shell line', (bad) => {
    expect(() => envFlag(bad)).toThrow(/not a safe/);
  });
});
