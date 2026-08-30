import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectEditors = vi.hoisted(() => vi.fn());
const writeMcpConfig = vi.hoisted(() => vi.fn());
vi.mock('../lib/mcp-setup.js', () => ({ detectEditors, writeMcpConfig }));

const confirm = vi.hoisted(() => vi.fn());
const isCancel = vi.hoisted(() => vi.fn().mockReturnValue(false));
const logged: string[] = [];
vi.mock('@clack/prompts', () => ({
  confirm,
  isCancel,
  log: {
    info: (m: string) => logged.push(m),
    success: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
  },
}));

vi.spyOn(console, 'log').mockImplementation(() => undefined);

import { connectDetectedAgents } from '../commands/connect-agents.js';

const CLAUDE = { name: 'Claude Desktop', configPath: '/home/d/.config/Claude/x.json', format: 'mcpServers' };
const CURSOR = { name: 'Cursor', configPath: '/home/d/.cursor/mcp.json', format: 'mcpServers' };

/**
 * ALI-776. Local setup wired the PROJECT (.mcp.json and the agent hooks) but never the
 * globally installed agents, while cloud setup did - so a local-only user, the one for whom
 * an agent on their own machine is the entire point, got less.
 *
 * Closing that gap means writing to files OUTSIDE the repo the user ran us in
 * (~/.claude.json, a Claude Desktop config). Those are user-level files people curate, so
 * this asks once rather than editing them silently - which is what the cloud path did
 * whenever exactly one editor was detected.
 */
describe('connectDetectedAgents', () => {
  beforeEach(() => {
    logged.length = 0;
    detectEditors.mockReset();
    writeMcpConfig.mockReset();
    confirm.mockReset().mockResolvedValue(true);
    isCancel.mockReturnValue(false);
  });

  it('writes nothing and says nothing useless when no agent is installed', async () => {
    detectEditors.mockReturnValue([]);
    await connectDetectedAgents('local', { interactive: true });
    expect(writeMcpConfig).not.toHaveBeenCalled();
    // Still hands over the portable config, because Align is just an MCP server and works
    // with agents we cannot detect.
    expect(logged.join(' ')).toMatch(/mcpServers/);
  });

  it('asks before touching a global config, and writes when told yes', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    await connectDetectedAgents('local', { interactive: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(writeMcpConfig).toHaveBeenCalledTimes(2);
    // env threaded through, or a local user's agent would point at the cloud graph
    expect(writeMcpConfig).toHaveBeenCalledWith(CLAUDE, 'local');
  });

  it('writes nothing when told no, and says how to do it later', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    confirm.mockResolvedValue(false);
    await connectDetectedAgents('local', { interactive: true });
    expect(writeMcpConfig).not.toHaveBeenCalled();
    expect(logged.join(' ')).toMatch(/align mcp --setup/);
  });

  it('treats a cancelled prompt as no', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    isCancel.mockReturnValue(true);
    await connectDetectedAgents('local', { interactive: true });
    expect(writeMcpConfig).not.toHaveBeenCalled();
  });

  /**
   * Without a TTY there is nobody to ask, and silently editing a user-level file is exactly
   * what this design refuses to do. It also must not PROMPT, or `align setup --approve` hangs
   * - which is a live bug today: the cloud path's multiselect is unguarded.
   */
  // `--approve` is consent given up front, so a scripted run must still get its agents
  // wired rather than silently losing them.
  it('writes without asking when --approve was passed', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    await connectDetectedAgents('local', { interactive: false, assumeYes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(writeMcpConfig).toHaveBeenCalledTimes(2);
  });

  it('neither prompts nor writes when there is no TTY', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    await connectDetectedAgents('local', { interactive: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(writeMcpConfig).not.toHaveBeenCalled();
    expect(logged.join(' ')).toMatch(/align mcp --setup/);
  });

  it('keeps going when one agent fails to write', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    writeMcpConfig.mockImplementationOnce(() => { throw new Error('permission denied'); });
    await connectDetectedAgents('local', { interactive: true });
    expect(writeMcpConfig).toHaveBeenCalledTimes(2);      // did not abort on the first
    expect(logged.join(' ')).toMatch(/permission denied/); // and said so
  });

  it('passes undefined for prod, so the agent gets the default env', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    await connectDetectedAgents('prod', { interactive: true });
    expect(writeMcpConfig).toHaveBeenCalledWith(CLAUDE, undefined);
  });
});
