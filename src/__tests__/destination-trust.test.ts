import { describe, expect, it } from 'vitest';
import { assertTransport, TransportError } from '../lib/destination-trust.js';

describe('assertTransport', () => {
  it.each([
    ['https://api.acme.example', 'https://api.acme.example'],
    ['https://api.acme.example/', 'https://api.acme.example'],
    ['https://API.Acme.Example:8443', 'https://api.acme.example:8443'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
  ])('accepts %s as %s', (input, out) => {
    expect(assertTransport(input)).toBe(out);
  });

  it.each([
    ['http://api.acme.example', 'plain http to a remote host'],
    ['http://localhost.evil.example', 'a host that only starts with localhost'],
    ['http://127.0.0.1.evil.example', 'a host that only starts with 127.0.0.1'],
    ['ftp://api.acme.example', 'another scheme'],
    ['api.acme.example', 'no scheme'],
    ['https://user:pw@api.acme.example', 'credentials in the URL'],
    ['https://api.align.tech@evil.example', 'a trusted-looking userinfo before the real host'],
    ['https://api.acme.example/v1', 'a path'],
    ['https://api.acme.example/?x=1', 'a query'],
    ['https://api.acme.example/#f', 'a fragment'],
    ['', 'empty'],
  ])('refuses %j (%s)', (input) => {
    expect(() => assertTransport(input)).toThrow(TransportError);
  });
});
