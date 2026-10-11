/** One line per saved team destination, naming both servers a person is trusting. Never prints a token. */
import type { createConfigStore } from './config.js';
import { describeHost } from './destination-trust.js';
import { visible } from './share/visible.js';

type ConfigStore = Pick<ReturnType<typeof createConfigStore>, 'listTeamDestinationNames' | 'getEnvironment' | 'getShareDestination'>;

const hostOf = (url: string | undefined): string => {
  try { return url ? new URL(url).host : '(unknown)'; } catch { return '(unknown)'; }
};

export function destinationLines(config: ConfigStore): string[] {
  const share = config.getShareDestination();
  return config.listTeamDestinationNames().map((name) => {
    let e;
    try { e = config.getEnvironment(name as never); } catch (err) {
      // A hand-edited entry the transport rule refuses: say so rather than fail the whole listing.
      return `  ${name}  unreadable: ${visible((err as Error).message)}`;
    }
    const org = e.orgNameClaimed ? ` "${visible(e.orgNameClaimed)}"` : '';
    const mark = name === share ? '  (share destination)' : '';
    return `  ${name}${org}  gateway ${describeHost(hostOf(e.gatewayUrl)).text}  web app ${describeHost(hostOf(e.appUrl)).text}${mark}`;
  });
}
