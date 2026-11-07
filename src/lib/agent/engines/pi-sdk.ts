import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from '../../../../package.json' with { type: 'json' };
import type { PiSdk } from './pi.js';

/**
 * Where Align's own engine comes from.
 *
 * The engine is Pi's SDK plus the provider SDKs it pulls in, about 110 MB, so it is not in the
 * npm install (install-smoke caps that at 100 MB; the UI library, ~3 MB, is). It is used from
 * the bundle where there is one (the compiled binary, a dev checkout), else from a copy
 * downloaded earlier, else downloaded once now with the person's yes - the same shape as the
 * on-device embedding runtime. Users on their own Claude Code never download it.
 */

export const PI_ENGINE_PACKAGES = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'] as const;

/** The exact versions this CLI was tested against: the devDependencies pins, one writer of each. */
function pinned(name: string): string {
  const version = (pkg.devDependencies as Record<string, string | undefined>)[name];
  if (!version) throw new Error(`package.json pins no version of ${name}`);
  return version;
}
export const PI_ENGINE_VERSION = pinned(PI_ENGINE_PACKAGES[0]);

export interface PiSdkDeps {
  engineDir: string;
  /** The engine bundled with this build, and its version when it can be read. */
  importBundled: () => Promise<{ sdk: PiSdk; version?: string }>;
  importInstalled: (engineDir: string) => Promise<PiSdk>;
  confirm: (message: string) => Promise<boolean>;
  runNpm: (args: string[]) => Promise<number>;
  out: (line: string) => void;
}

const attempt = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
  try { return await load(); } catch { return undefined; }
};

export async function loadPiSdk(deps: PiSdkDeps): Promise<PiSdk> {
  // A bundled Pi of another version (one installed beside Align, say) may lack what the engine
  // uses, so only the pinned version counts. A build that cannot report its version (the compiled
  // binary) counts when it has the API, so binary users are not sent to download what they have.
  const bundled = await attempt(deps.importBundled);
  const usable = bundled && (bundled.version === PI_ENGINE_VERSION || (bundled.version === undefined && typeof bundled.sdk.ModelRuntime === 'function'));
  const ready = (usable ? bundled.sdk : undefined) ?? (await attempt(() => deps.importInstalled(deps.engineDir)));
  if (ready) return ready;

  const yes = await deps.confirm('Align\'s own engine is a one-time download, about 110 MB. Download it now?');
  if (!yes) throw new Error('Align\'s own engine was not downloaded. Run align again to download it, or use --engine claude.');
  deps.out(`Downloading Align's engine into ${deps.engineDir} ...`);
  const code = await deps.runNpm(['install', '--prefix', deps.engineDir, '--no-audit', '--no-fund', '--loglevel=error',
    ...PI_ENGINE_PACKAGES.map((name) => `${name}@${pinned(name)}`)]);
  if (code !== 0) throw new Error(`The engine download failed (npm exited ${code}). Check your connection and run align again.`);
  return deps.importInstalled(deps.engineDir);
}

/** The ESM entry of a package installed under `engineDir`, read from its own exports map. */
function installedEntry(engineDir: string, name: string): string {
  const dir = join(engineDir, 'node_modules', ...name.split('/'));
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: unknown; main?: string };
  const root = (manifest.exports as Record<string, unknown> | undefined)?.['.'];
  const entry = typeof root === 'string' ? root
    : (root as Record<string, unknown> | undefined)?.['import'] ?? (root as Record<string, unknown> | undefined)?.['default'] ?? manifest.main;
  const file = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | undefined)?.['default'];
  if (typeof file !== 'string') throw new Error(`${name} in ${engineDir} has no entry point`);
  return join(dir, file);
}

/** The version of the bundled engine, read from its package.json; undefined when it cannot be found. */
function bundledVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(PI_ENGINE_PACKAGES[0])));
    for (let i = 0; i < 6; i++) {
      try {
        const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (m.name === PI_ENGINE_PACKAGES[0]) return m.version;
      } catch { /* keep walking up */ }
      dir = dirname(dir);
    }
  } catch { /* not resolvable here */ }
  return undefined;
}

/**
 * How to run npm. On Windows npm is npm.cmd, which needs a shell, and cmd.exe splits an unquoted
 * argument at a space - a home directory like "Jo Smith" would break the install path.
 */
export function npmCommand(platform: string, args: string[]): { cmd: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { cmd: 'npm', args, shell: false };
  return { cmd: 'npm.cmd', args: args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)), shell: true };
}

export function defaultPiSdkDeps(o: { engineDir: string; confirm: (message: string) => Promise<boolean> }): PiSdkDeps {
  return {
    engineDir: o.engineDir,
    // A literal specifier, so the compiled binary bundles the engine and never downloads it.
    importBundled: async () => ({ sdk: await import('@earendil-works/pi-coding-agent'), version: bundledVersion() }),
    importInstalled: async (dir) => (await import(pathToFileURL(installedEntry(dir, PI_ENGINE_PACKAGES[0])).href)) as PiSdk,
    confirm: o.confirm,
    runNpm: (args) => new Promise((resolve) => {
      const npm = npmCommand(process.platform, args);
      const child = spawn(npm.cmd, npm.args, { stdio: 'inherit', shell: npm.shell });
      child.on('error', () => resolve(127));
      child.on('exit', (code) => resolve(code ?? 1));
    }),
    out: (l) => process.stderr.write(`${l}\n`),
  };
}
