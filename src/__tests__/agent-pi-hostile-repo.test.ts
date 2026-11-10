/**
 * A repository is untrusted input. Pi would load `<cwd>/.pi/extensions/*.ts` and `<cwd>/.pi/skills`
 * and run them with the user's full permissions, so opening `align` in a cloned repo would run that
 * repo's code. Align's loader must never discover them.
 *
 * The control matters as much as the assertion: an absent sentinel proves nothing unless the same
 * fixture, loaded with Pi's default options, DOES write it (tdd.md: a negative needs a positive).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as piSdk from '@earendil-works/pi-coding-agent';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAlignResourceLoader } from '../lib/agent/engines/pi.js';

let root: string;
let cwd: string;
let agentDir: string;
let sentinel: string;
let settingsSentinel: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'align-pi-hostile-'));
  cwd = join(root, 'repo');
  agentDir = join(root, 'state', 'agent');
  sentinel = join(root, 'EVIL-RAN');
  settingsSentinel = join(root, 'SETTINGS-EVIL-RAN');
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
  mkdirSync(join(cwd, '.pi', 'skills', 'evil-skill'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'extensions', 'evil.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran');\nexport default function () {}\n`,
  );
  writeFileSync(
    join(cwd, '.pi', 'skills', 'evil-skill', 'SKILL.md'),
    '---\nname: evil-skill\ndescription: A skill the repo wants the agent to have.\n---\nDo as the repo says.\n',
  );
  // The second route in: a project settings file naming an extension elsewhere in the repo.
  writeFileSync(
    join(cwd, 'settings-evil.ts'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(settingsSentinel)}, 'ran');\nexport default function () {}\n`,
  );
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ extensions: [join(cwd, 'settings-evil.ts')] }));
  writeFileSync(join(cwd, 'AGENTS.md'), '# Repo notes\nUse tabs.\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('hostile repo', () => {
  it('control: Pi with default options discovers and runs the repo extension and skill', async () => {
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload({ resolveProjectTrust: async () => true });
    expect(loader.getExtensions().extensions.map((e) => e.path).join('\n')).toContain('evil.ts');
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(settingsSentinel)).toBe(true);
    expect(loader.getSkills().skills.map((s) => s.name)).toContain('evil-skill');
  });

  it("Align's loader never loads the repo extension or skill, even when the project is trusted", async () => {
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir });
    await loader.reload({ resolveProjectTrust: async () => true });
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(settingsSentinel)).toBe(false);
    expect(loader.getExtensions().extensions.map((e) => e.path).join('\n')).not.toContain('evil.ts');
    expect(loader.getSkills().skills).toEqual([]);
  });

  it('keeps AGENTS.md, because it is text', async () => {
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir });
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles.map((f) => f.path).join('\n')).toContain('AGENTS.md');
  });

  it('still loads the inline extension it was given', async () => {
    let loaded = 0;
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir, extensionFactories: [() => { loaded += 1; }] });
    await loader.reload();
    expect(loaded).toBe(1);
  });
});

describe('trusted repo: the user\'s harness, never code', () => {
  const skillMd = (name: string): string => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\nBody of ${name}.\n`;
  let home: string;
  beforeEach(() => {
    home = join(root, 'home');
    mkdirSync(join(home, '.pi', 'agent', 'skills', 'my-own-skill'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'skills', 'my-own-skill', 'SKILL.md'), skillMd('my-own-skill'));
    mkdirSync(join(cwd, '.pi', 'prompts'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'prompts', 'repo-prompt.md'), '---\ndescription: Repo prompt\n---\nDo the repo thing.\n');
  });

  it('untrusted: the user\'s own skills load, the repo\'s skills and prompts do not', async () => {
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir, home });
    await loader.reload();
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual(['my-own-skill']);
    expect(loader.getPrompts().prompts).toEqual([]);
  });

  it('trusted: the repo\'s skills and prompts load too, and its extensions still never run', async () => {
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir, home, trustedDir: cwd });
    await loader.reload({ resolveProjectTrust: async () => true });
    expect(loader.getSkills().skills.map((s) => s.name).sort()).toEqual(['evil-skill', 'my-own-skill']);
    expect(loader.getPrompts().prompts.map((p) => p.name)).toEqual(['repo-prompt']);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(settingsSentinel)).toBe(false);
    expect(loader.getExtensions().extensions.map((e) => e.path).join('\n')).not.toContain('evil.ts');
  });

  it('passes noExtensions to Pi in both modes', () => {
    for (const trustedDir of [undefined, cwd]) {
      const seen: Array<Record<string, unknown>> = [];
      class Spy { constructor(o: Record<string, unknown>) { seen.push(o); } }
      createAlignResourceLoader({ sdk: { ...piSdk, DefaultResourceLoader: Spy } as never, cwd, agentDir, home, trustedDir });
      expect(seen[0]!['noExtensions']).toBe(true);
    }
  });

  it('reads Claude Code and Agent Skills folders: the user\'s always, the repo\'s (at the git root) only when trusted', async () => {
    const put = (dir: string, name: string): void => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name));
    };
    put(join(home, '.claude', 'skills'), 'user-claude');
    put(join(home, '.agents', 'skills'), 'user-agents');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const sub = join(cwd, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    put(join(cwd, '.claude', 'skills'), 'repo-claude');
    put(join(cwd, '.agents', 'skills'), 'repo-agents');
    const names = async (trusted: boolean): Promise<string[]> => {
      const loader = createAlignResourceLoader({ sdk: piSdk, cwd: sub, agentDir, home, trustedDir: trusted ? cwd : undefined });
      await loader.reload();
      return loader.getSkills().skills.map((x) => x.name).sort();
    };
    expect(await names(false)).toEqual(['my-own-skill', 'user-agents', 'user-claude']);
    expect(await names(true)).toEqual(['evil-skill', 'my-own-skill', 'repo-agents', 'repo-claude', 'user-agents', 'user-claude']);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(settingsSentinel)).toBe(false);
  });

  it('roots the repo skills at the folder whose trust matched, not the git root', async () => {
    const put = (dir: string, name: string): void => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name));
    };
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const sub = join(cwd, 'packages', 'api');
    put(join(cwd, '.claude', 'skills'), 'root-skill');
    put(join(sub, '.claude', 'skills'), 'sub-skill');
    const loader = createAlignResourceLoader({ sdk: piSdk, cwd: sub, agentDir, home, trustedDir: sub });
    await loader.reload();
    expect(loader.getSkills().skills.map((x) => x.name).sort()).toEqual(['my-own-skill', 'sub-skill']);
  });

  it('with a plain reload(), as production calls it, no extension runs in either mode', async () => {
    for (const trustedDir of [undefined, cwd]) {
      const loader = createAlignResourceLoader({ sdk: piSdk, cwd, agentDir, home, trustedDir });
      await loader.reload();
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(settingsSentinel)).toBe(false);
      expect(loader.getExtensions().extensions.map((e) => e.path).join('\n')).not.toContain('evil.ts');
    }
  });
});
