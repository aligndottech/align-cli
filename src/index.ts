#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
const { version } = pkg;
import { registerLoginCommands } from './commands/login.js';
import { registerCaptureCommand } from './commands/capture.js';
import { registerImportCommand } from './commands/import.js';
import { registerSearchCommand } from './commands/search.js';
import { registerCheckCommand } from './commands/check.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerDecisionsCommand } from './commands/decisions/index.js';
import { registerConnectorCommands } from './commands/connector/index.js';
import { registerDevCommands } from './commands/dev/index.js';
import { registerSpacesCommand } from './commands/spaces.js';
import { registerLinksCommand } from './commands/links.js';
import { registerDriftCommand } from './commands/drift.js';
import { registerEnvCommand } from './commands/env.js';
import { registerAskCommand } from './commands/why.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerExportCommand } from './commands/export.js';

const program = new Command();

program
  .name('align')
  .description('Align CLI - capture decisions, check alignment, and manage connectors')
  .version(version);

// Environment targeting
registerEnvCommand(program);

// Auth + onboarding
registerLoginCommands(program);
registerSetupCommand(program);

// Customer: decision capture + import
registerCaptureCommand(program);
registerImportCommand(program);

// Customer: search + query
registerSearchCommand(program);
registerAskCommand(program);
registerDecisionsCommand(program);
registerExportCommand(program);
registerSpacesCommand(program);
registerLinksCommand(program);
registerDriftCommand(program);

// Customer: CI/alignment check
registerCheckCommand(program);

// Customer: MCP server
registerMcpCommand(program);

// Internal: only registered when ALIGN_INTERNAL=1 (Align team local dev)
if (process.env.ALIGN_INTERNAL === '1') {
  registerConnectorCommands(program);
  registerDevCommands(program);
}

program.parse();
