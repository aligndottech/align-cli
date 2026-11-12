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
  config
    .command('backlog-offer [state]')
    .description('The one line align capture prints offering to turn a plan-shaped decision into tickets: on or off (default on)')
    .action((state: string | undefined) => {
      const store = createConfigStore();
      if (state === undefined) {
        const on = store.getBacklogOffer();
        console.log(`Backlog offer: ${on ? 'on' : 'off'}`);
        console.log(`Change it with: align config backlog-offer ${on ? 'off' : 'on'}`);
        return;
      }
      if (state !== 'on' && state !== 'off') {
        console.error(`"${state}" is not a state. Allowed: on, off.`);
        process.exitCode = 1;
        return;
      }
      store.setBacklogOffer(state === 'on');
      console.log(`Saved: backlog offer ${state}.`);
      if (process.env['ALIGN_NO_BACKLOG_OFFER']) console.log('ALIGN_NO_BACKLOG_OFFER is set in this shell and keeps the offer off.');
    });
}
