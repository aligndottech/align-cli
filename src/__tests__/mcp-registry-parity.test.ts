import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ALI-535: server.json (the MCP registry record) and package.json are two writers
// of one fact - the package identity and version. The registry rejects a publish
// whose npm package lacks a matching `mcpName`, and a stale server.json version
// publishes a record pointing at an npm version that is not the release. This
// suite pins the two files together so a release-please bump that moves one
// without the other goes red on the release PR, not at publish time.

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));

describe('MCP registry record parity (server.json <-> package.json)', () => {
  it('names the same registry server as package.json mcpName', () => {
    expect(pkg.mcpName).toBe('io.github.aligndottech/cli');
    expect(server.name).toBe(pkg.mcpName);
  });

  it('carries the package version in both version fields', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it('points at this npm package over stdio', () => {
    expect(server.packages[0].registryType).toBe('npm');
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].transport).toEqual({ type: 'stdio' });
  });

  it('is bumped by release-please, not by hand', () => {
    // Both version fields must be listed as extra-files JSONPaths, or the next
    // release bumps package.json and leaves server.json describing the old one.
    const rp = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
    const extras = rp.packages['.']['extra-files'] ?? [];
    const jsonpaths = extras
      .filter((e: { path?: string }) => e.path === 'server.json')
      .map((e: { jsonpath?: string }) => e.jsonpath);
    expect(jsonpaths).toContain('$.version');
    expect(jsonpaths).toContain('$.packages[0].version');
  });
});
