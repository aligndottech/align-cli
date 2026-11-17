import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The skill-only plugin (plugins/align-skill) is the listing for Anthropic's plugin directory.
// Since 17 Nov 2026 the directory refuses command hooks and local MCP servers from organizations
// it has not marked Verified, and there is no application for that. So this folder holds only what
// an unverified publisher may ship: Markdown, JSON and an image. The full plugin (plugins/align,
// hooks and MCP server) is still what this repo's own marketplace installs.
const root = fileURLToPath(new URL('../../', import.meta.url));
const DIR = 'plugins/align-skill';
const PLUGIN_JSON = `${DIR}/.claude-plugin/plugin.json`;
const SKILL = `${DIR}/skills/check-decisions/SKILL.md`;
const COMMAND = `${DIR}/commands/check.md`;
const text = (rel: string) => readFileSync(root + rel, 'utf8');
const json = (rel: string) => JSON.parse(text(rel)) as Record<string, any>;

function listFiles(dir: string): string[] {
  return readdirSync(root + dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}

const frontmatter = (md: string): string => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error('no YAML frontmatter');
  return m[1]!;
};

describe('skill-only plugin: only what the plugin directory accepts from an unverified publisher', () => {
  it('holds exactly the manifest, the icon, one skill and one command', () => {
    expect(listFiles(DIR).sort()).toEqual([
      `${DIR}/.claude-plugin/icon.png`,
      `${DIR}/.claude-plugin/plugin.json`,
      COMMAND,
      SKILL,
    ]);
  });

  it('declares no hooks and no MCP servers, in the manifest or as files', () => {
    const m = json(PLUGIN_JSON);
    expect(m).not.toHaveProperty('hooks');
    expect(m).not.toHaveProperty('mcpServers');
    expect(m).not.toHaveProperty('modules');
    expect(listFiles(DIR).some((f) => /hooks|\.mcp\.json$/.test(f))).toBe(false);
  });

  it('uses names the directory does not reserve for another publisher', () => {
    const m = json(PLUGIN_JSON);
    // "align" and "Align" belong to an existing directory connector that this repo does not own.
    expect(m['name']).toBe('align-cli');
    expect(m['displayName']).toBe('Align CLI');
    expect(m['author'].name).toBe('Align Tech Ltd');
    for (const v of [m['name'], m['displayName'], m['author'].name]) expect(String(v).toLowerCase()).not.toBe('align');
  });

  it('carries the release version, kept in step by release-please', () => {
    expect(json(PLUGIN_JSON)['version']).toBe(json('package.json')['version']);
    const extra = json('release-please-config.json')['packages']['.']['extra-files'] as Array<{ path: string; jsonpath: string }>;
    expect(extra.some((e) => e.path === PLUGIN_JSON && e.jsonpath === '$.version')).toBe(true);
  });

  it('is not in this repo\'s own marketplace, which still installs the full plugin', () => {
    const plugins = json('.claude-plugin/marketplace.json')['plugins'] as Array<{ source: string }>;
    expect(plugins.map((p) => p.source)).toEqual(['./plugins/align']);
  });
});

describe('skill and command: instructions only', () => {
  for (const rel of [SKILL, COMMAND]) {
    it(`${rel}: no tool grants, no shell run at load time, no script header`, () => {
      const md = text(rel);
      const fm = frontmatter(md);
      expect(fm).toMatch(/^description: .{20,}/m);
      // The directory refuses allowed-tools beyond Read/Grep/Glob/LS, so grant none at all.
      expect(fm).not.toMatch(/allowed-tools/);
      // "!`cmd`" runs a command when the file loads. That is inline shell, which is refused.
      expect(md).not.toMatch(/!`/);
      expect(md.startsWith('#!')).toBe(false);
      expect(md).not.toContain('\u2014');
    });
  }

  it('the skill is named and tells Claude which two commands to run', () => {
    const md = text(SKILL);
    expect(frontmatter(md)).toMatch(/^name: check-decisions$/m);
    expect(md).toContain('`align ask');
    expect(md).toContain('`align check');
  });

  it('the skill never installs anything: a missing CLI is reported to the person', () => {
    const md = text(SKILL);
    expect(md).toMatch(/do not install/i);
    expect(md).toContain('github.com/aligndottech/align-cli');
    // A plugin that tells an agent to fetch and run a package is the pattern the directory refuses.
    expect(md).not.toMatch(/\bnpx\b|npm i(nstall)? -g/);
  });

  it('the skill treats a conflict as a stop, and never as something to override quietly', () => {
    const md = text(SKILL);
    expect(md).toMatch(/stop/i);
    expect(md).toMatch(/ask the person/i);
  });
});
