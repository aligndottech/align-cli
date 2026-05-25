#!/usr/bin/env node
import { Command } from 'commander';
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

const program = new Command();

program
  .name('align')
  .description('Align CLI - capture decisions, check alignment, and manage connectors')
  .version('0.1.0');

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
registerSpacesCommand(program);
registerLinksCommand(program);
registerDriftCommand(program);

// Customer: CI/alignment check
registerCheckCommand(program);

// Customer: MCP server
registerMcpCommand(program);

// Internal: connector management
registerConnectorCommands(program);

// Internal: local dev
registerDevCommands(program);

program.parse();
