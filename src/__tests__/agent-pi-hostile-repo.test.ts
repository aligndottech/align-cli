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
