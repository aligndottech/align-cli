import type { Command } from 'commander';
import { registerLoginCommands } from './login.js';
import { registerCaptureCommand } from './capture.js';
import { registerImportCommand } from './import.js';
import { registerSearchCommand } from './search.js';
import { registerCheckCommand } from './check.js';
import { registerAdjudicateCommand } from './adjudicate.js';
import { registerRatifyCommand } from './ratify.js';
import { registerPushCommand } from './push.js';
import { registerMcpCommand } from './mcp.js';
import { registerLocalCommand } from './local.js';
import { registerDecisionsCommand } from './decisions/index.js';
import { registerConnectorCommands } from './connector/index.js';
import { registerDevCommands } from './dev/index.js';
import { registerSpacesCommand } from './spaces.js';
import { registerLinksCommand } from './links.js';
import { registerDriftCommand } from './drift.js';
import { registerStatusCommand } from './status.js';
import { registerContextCommand } from './context.js';
import { registerEnvCommand } from './env.js';
import { registerTelemetryCommand } from './telemetry.js';
import { registerAskCommand } from './why.js';
import { registerSetupCommand } from './setup.js';
import { registerExportCommand } from './export.js';
import { registerInviteCommand } from './invite.js';

/**
 * ALI-951: the one list of top-level commands. `align --help` shows the `visible` ones and
 * nothing else; every other command still parses and runs, and docs/commands.md (generated
 * from this list by `npm run docs:commands`) is where it is documented. A register function
 * that adds a command this list does not name fails help-tiers.test.ts, so a new command
 * cannot land without choosing visible or hidden.
 *
 * Measured before this list existed (origin/main 279672f): 24 visible top-level commands,
 * 29 subcommands, 137 flags, `align --help` 54 lines. Commands kept being added after
 * ALI-773's "20-command wall" complaint (ratify, push, invite), because nothing said which
 * tier a new one belonged to.
 */
export interface CommandEntry {
  /** The top-level command names this register function adds (login.ts adds three). */
  names: string[];
  /** Shown by `align --help`. Everything else is hidden there and documented instead. */
  visible: boolean;
  /** One line for `align --help` and the doc's everyday section, so those never carry
   *  Commander's paragraph-long descriptions. */
  summary: string;
  /** Registered only under ALIGN_INTERNAL=1 (Align team local dev). */
  internal?: true;
  register: (program: Command) => void;
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  // Environment targeting
  { names: ['env'], visible: false, summary: 'Set or show the default environment', register: registerEnvCommand },
  { names: ['telemetry'], visible: false, summary: 'Usage telemetry on, off, status', register: registerTelemetryCommand },

  // Auth + onboarding
  { names: ['login', 'logout', 'whoami'], visible: false, summary: 'Cloud account sign-in', register: registerLoginCommands },
  { names: ['setup'], visible: false, summary: 'Guided onboarding (bare `align` runs it)', register: registerSetupCommand },
  { names: ['invite'], visible: false, summary: 'Invite a teammate to your graph', register: registerInviteCommand },

  // Customer: ask, then connect - the order `align --help` shows them in.
  { names: ['ask'], visible: true, summary: 'Ask your decision graph, with sources', register: registerAskCommand },
  { names: ['capture'], visible: false, summary: 'Capture one decision from a URL', register: registerCaptureCommand },
  {
    names: ['connect'],
    visible: true,
    summary: 'Connect a source and import its decisions',
    register: registerImportCommand,
  },

  // Customer: search + query
  { names: ['search'], visible: false, summary: 'Keyword search, ranked list', register: registerSearchCommand },
  { names: ['decisions'], visible: false, summary: 'List and show decisions', register: registerDecisionsCommand },
  { names: ['export'], visible: false, summary: 'Export decisions as a brief or JSON', register: registerExportCommand },
  { names: ['spaces'], visible: false, summary: 'List spaces (cloud)', register: registerSpacesCommand },
  { names: ['links'], visible: false, summary: 'Cross-tool decision relationships', register: registerLinksCommand },
  { names: ['drift'], visible: false, summary: 'Decisions that may be out of date (cloud)', register: registerDriftCommand },
  { names: ['status'], visible: false, summary: 'What your graph has done for you', register: registerStatusCommand },
  { names: ['context'], visible: false, summary: 'Write decisions to .align/decisions.md', register: registerContextCommand },

  // Customer: CI/alignment check
  { names: ['check'], visible: true, summary: 'Check your changes against the graph', register: registerCheckCommand },
  { names: ['adjudicate'], visible: false, summary: 'Answer a check the judge declined to rule on', register: registerAdjudicateCommand },
  // ALI-831: agent decisions as claims - the human act, and the per-item promotion after it.
  { names: ['ratify'], visible: false, summary: 'Stand behind an agent-made decision', register: registerRatifyCommand },
  { names: ['push'], visible: false, summary: 'Promote one ratified local decision to the shared graph', register: registerPushCommand },

  // Customer: MCP server
  { names: ['mcp'], visible: true, summary: 'Serve the graph to your agent (--setup wires it)', register: registerMcpCommand },

  // Customer: local-first mode (no cloud account required)
  { names: ['local'], visible: false, summary: 'The local graph: start, status, reset, forget', register: registerLocalCommand },

  // Internal: only registered when ALIGN_INTERNAL=1 (Align team local dev)
  { names: ['connector'], visible: false, summary: 'Connector admin (Align team)', internal: true, register: registerConnectorCommands },
  { names: ['dev'], visible: false, summary: 'Local dev stack (Align team)', internal: true, register: registerDevCommands },
];

/** The root itself, listed first in `align --help`: bare `align` is the product. */
export const ROOT_SUMMARY = 'Set up, or see your graph and what to do next';

export function visibleEntries(): CommandEntry[] {
  return COMMAND_REGISTRY.filter((e) => e.visible);
}
