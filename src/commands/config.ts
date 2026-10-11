import type { Command } from 'commander';
import { createConfigStore } from '../lib/config.js';
import { DETECTOR_VERSIONS, detectorSource, resolveDetectorVersion } from '../detector/detector-version.js';

/**
 * `align config detector [v0|v1]`: the saved choice of relationship detector. With no argument it
 * prints the detector in use and where that comes from; with one it saves the choice. ALIGN_DETECTOR
 * still overrides a saved choice, and the output says so rather than letting it look ignored.
 */
export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Change align settings');
  config
    .command('detector [version]')
    .description(`Which relationship detector runs: ${DETECTOR_VERSIONS.join(' or ')} (default v0)`)
    .action((version: string | undefined) => {
      const store = createConfigStore();
      if (version === undefined) {
        const active = resolveDetectorVersion(process.env, store.getDetector());
        console.log(`Detector: ${active} (${detectorSource(process.env, store.getDetector())})`);
        console.log(`Change it with: align config detector ${active === 'v0' ? 'v1' : 'v0'}`);
        return;
      }
      if (!(DETECTOR_VERSIONS as readonly string[]).includes(version)) {
        console.error(`"${version}" is not a detector. Allowed: ${DETECTOR_VERSIONS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      store.setDetector(version);
      console.log(`Saved: detector ${version}.`);
      if (process.env['ALIGN_DETECTOR']?.trim()) {
        console.log(`ALIGN_DETECTOR is set in this shell and overrides the saved choice (${process.env['ALIGN_DETECTOR']}).`);
      }
    });
}
