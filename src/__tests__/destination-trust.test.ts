import { describe, expect, it } from 'vitest';
import { assertTransport, describeHost, needsTypeBack, parseJoinLink, slugOrgName, TransportError } from '../lib/destination-trust.js';

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

const TOKEN = 'ab'.repeat(32);

describe('needsTypeBack (S1: label boundary, never a substring)', () => {
  it.each([
    ['api.align.tech', 'app.align.tech'],
    ['api.preview.align.tech', 'app.preview.align.tech'],
    ['align.tech', 'app.align.tech'],
  ])('no type-back when both %s and %s are Align hosts', (gw, app) => {
    expect(needsTypeBack(gw, app)).toBe(false);
  });

  it.each([
    ['api.align.tech.evil.example', 'app.align.tech', 'a lookalike gateway'],
    ['api.align-tech.co', 'app.align.tech', 'a different domain'],
    ['evilalign.tech', 'app.align.tech', 'a suffix without the dot'],
    ['api.align.tech', 'app.align.tech.evil.example', 'a lookalike app host, real gateway'],
    ['api.acme.example', 'align.acme.example', 'a self-host'],
    ['localhost', 'localhost', 'the loopback'],
  ])('type-back for %s / %s (%s)', (gw, app) => {
    expect(needsTypeBack(gw, app)).toBe(true);
  });

  it('is case-insensitive about the host', () => {
    expect(needsTypeBack('API.ALIGN.TECH', 'App.Align.Tech')).toBe(false);
  });
});

describe('describeHost', () => {
  it('an ASCII host is shown once, with no warning', () => {
    expect(describeHost('api.acme.example')).toEqual({ text: 'api.acme.example', warning: null });
  });
  it('a punycode host shows the decoded and the raw form, and warns', () => {
    const d = describeHost('xn--pple-43d.example');
    expect(d.text).toContain('xn--pple-43d.example');
    expect(d.text).toContain('аpple.example');
    expect(d.warning).toMatch(/non-ASCII/);
  });
  it('a port stays attached to the host', () => {
    expect(describeHost('api.acme.example:8443').text).toBe('api.acme.example:8443');
  });
});

describe('parseJoinLink', () => {
  const link = (q: string, base = 'https://align.acme.example/join') => `${base}?${q}`;

  it('reads the token, the gateway and the app origin', () => {
    const r = parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('https://api.acme.example/')}`));
    expect(r).toEqual({ token: TOKEN, gatewayUrl: 'https://api.acme.example', appHost: 'align.acme.example', gatewayFromLink: true });
  });

  it('--gateway stands in for a link with no gw, and is not reported as the link\'s own', () => {
    const r = parseJoinLink(link(`token=${TOKEN}`), { gateway: 'https://api.acme.example' });
    expect(r.gatewayUrl).toBe('https://api.acme.example');
    expect(r.gatewayFromLink).toBe(false);
  });

  it('a link with no gw and no --gateway is refused naming --gateway', () => {
    expect(() => parseJoinLink(link(`token=${TOKEN}`))).toThrow(/--gateway/);
  });

  it('a gw and a different --gateway is refused', () => {
    expect(() => parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('https://api.acme.example')}`), { gateway: 'https://api.other.example' })).toThrow(/differ/);
  });

  it('the same gw and --gateway (trailing slash apart) is fine', () => {
    expect(parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('https://api.acme.example')}`), { gateway: 'https://api.acme.example/' }).gatewayUrl)
      .toBe('https://api.acme.example');
  });

  it('refuses an http gateway, accepts http://localhost:8080', () => {
    expect(() => parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('http://api.acme.example')}`))).toThrow(/https/);
    expect(parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('http://localhost:8080')}`, 'http://localhost:5173/join')).gatewayUrl)
      .toBe('http://localhost:8080');
  });

  it('refuses an http link to a remote app host', () => {
    expect(() => parseJoinLink(link(`token=${TOKEN}&gw=${encodeURIComponent('https://api.acme.example')}`, 'http://align.acme.example/join'))).toThrow(/https/);
  });

  it.each([
    ['', 'no token'],
    ['token=short', 'a short token'],
    [`token=${'AB'.repeat(32)}`, 'uppercase hex'],
    [`token=${TOKEN}0`, 'a 65 character token'],
    [`token=${'zz'.repeat(32)}`, 'non-hex'],
  ])('refuses %j (%s)', (q) => {
    expect(() => parseJoinLink(link(`${q}&gw=${encodeURIComponent('https://api.acme.example')}`))).toThrow(/token/);
  });

  it('refuses text that is not a URL', () => {
    expect(() => parseJoinLink('not a link')).toThrow(/link/);
  });
});

describe('slugOrgName', () => {
  it('turns a claimed name into a destination name', () => {
    expect(slugOrgName('Acme Platform')).toBe('acme-platform');
    expect(slugOrgName('  Acme, Inc. (EU)  ')).toBe('acme-inc-eu');
  });
  it('gives up (null) when nothing usable is left, or the result is reserved', () => {
    expect(slugOrgName('日本語')).toBeNull();
    expect(slugOrgName('Prod')).toBeNull();
    expect(slugOrgName('1234 Co')).toBeNull();
    expect(slugOrgName('')).toBeNull();
  });
  it('caps the length at 32', () => {
    const s = slugOrgName('a'.repeat(80));
    expect(s).toHaveLength(32);
  });
});
