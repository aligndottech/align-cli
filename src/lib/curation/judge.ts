/** LM: who "I" am on this machine - the install id the CLI keeps for telemetry (one identity, one writer) and the git email, if any. */
import { createConfigStore } from '../config.js';
import { getGitIdentities } from '../git.js';
import type { Judge } from './judgements-db.js';

export async function defaultJudge(): Promise<Judge> {
  const judgeId = createConfigStore().getInstallId();
  const { email } = await getGitIdentities().catch(() => ({ email: null }));
  return { judgeId, judgeLabel: email };
}
