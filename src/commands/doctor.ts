import type { Command } from 'commander';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveTrustedAlignBin } from '../lib/trusted-align-bin.js';
import { askViaMcp, LOCAL_ASK_TIMEOUT_MS } from '../lib/doctor-mcp.js';
import { type DoctorDeps, doctorPassed, renderDoctor, runDoctor } from '../lib/doctor.js';

const PROBE_TIMEOUT_MS = 10_000;
const WHOAMI_TIMEOUT_MS = 15_000;

/** Any HTTP answer means the gateway is there (a 404 on /health still came from a server); only a failure to connect does not. */
async function probeGateway(gatewayUrl: string): Promise<{ reached: boolean; detail: string }> {
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return { reached: true, detail: `answered HTTP ${res.status}` };
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    return { reached: false, detail: err.name === 'TimeoutError' ? `no answer in ${PROBE_TIMEOUT_MS / 1000}s` : (err.cause?.code ?? err.message ?? 'connection failed') };
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check this install end to end: Node, align on PATH, the gateway, your token, and one real tool call')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      // No telemetry from this process or from the align mcp it starts: beginInvocationTelemetry marks the run (usage-telemetry.ts) and lib/doctor-mcp.ts marks the child.
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);

      const deps: DoctorDeps = {
        nodeVersion: process.versions.node,
        envName,
        mode: env.mode,
        gatewayUrl: env.gatewayUrl,
        hasToken: Boolean(env.authToken) || env.mode === 'demo',
        findAlign: () => resolveTrustedAlignBin(),
        probeGateway: () => probeGateway(env.gatewayUrl),
        whoami: async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`the gateway did not answer in ${WHOAMI_TIMEOUT_MS / 1000}s`)), WHOAMI_TIMEOUT_MS);
          });
          try {
            const me = await Promise.race([createGatewayClient(env).whoami(), timeout]);
            return { email: me.user.email, tenant: me.tenant.name };
          } finally {
            clearTimeout(timer);
          }
        },
        askViaMcp: (bin) => askViaMcp(bin, envName, env.mode === 'local-embedded' ? LOCAL_ASK_TIMEOUT_MS : undefined),
      };

      const checks = await runDoctor(deps);
      console.log(`\nalign doctor (${envName})\n\n${renderDoctor(checks)}\n`);
      if (!doctorPassed(checks)) process.exitCode = 1;
      // A timed-out request is abandoned, not aborted, and would hold the terminal for minutes after the verdict. Unref'd: a clean run exits on its own first.
      setTimeout(() => process.exit(), 500).unref();
    });
}
