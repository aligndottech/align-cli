import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectEditors = vi.hoisted(() => vi.fn());
const writeMcpConfig = vi.hoisted(() => vi.fn());
vi.mock('../lib/mcp-setup.js', () => ({ detectEditors, writeMcpConfig }));

const confirm = vi.hoisted(() => vi.fn());
const logged: string[] = [];
vi.mock('@clack/prompts', () => ({
  confirm,
  isCancel: vi.fn().mockReturnValue(false),
  log: {
    info: (m: string) => logged.push(m),
    success: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
  },
}));

import { connectDetectedAgents } from '../commands/connect-agents.js';

const CLAUDE = { name: 'Claude Desktop', configPath: '/home/d/.config/Claude/x.json', format: 'mcpServers' };
const CURSOR = { name: 'Cursor', configPath: '/home/d/.cursor/mcp.json', format: 'mcpServers' };

/**
 * ALI-776. Setup wires the agents installed on this machine.
 *
 * An earlier version of this asked first, on the grounds that a global editor config is a
 * user-level file. Two facts moved it: the write is ADDITIVE (one `align` key, everything
 * else preserved, and it throws rather than overwriting a config it cannot parse), and an
 * agent reading your graph IS the product - so a prompt costs every user a keystroke in
 * order to let a few decline the only thing that makes Align do anything.
 *
 * The trade only holds with disclosure and a real undo, so both are asserted here.
 */
describe('connectDetectedAgents', () => {
  beforeEach(() => {
    logged.length = 0;
    detectEditors.mockReset();
    writeMcpConfig.mockReset();
    confirm.mockReset();
  });

  it('wires every detected agent without asking', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    const r = await connectDetectedAgents('local');
    expect(confirm).not.toHaveBeenCalled();
    expect(writeMcpConfig).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ detected: 2, connected: 2 });
  });

  it('threads the env, or a local user\'s agent reads the cloud graph', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    await connectDetectedAgents('local');
    expect(writeMcpConfig).toHaveBeenCalledWith(CLAUDE, 'local');
  });

  it('passes undefined for prod, so the agent gets the default env', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    await connectDetectedAgents('prod');
    expect(writeMcpConfig).toHaveBeenCalledWith(CLAUDE, undefined);
  });

  /**
   * The disclosure IS the consent here. Naming the agent is not enough - "Cursor: connected"
   * does not tell anyone which file changed, and this is what the user gets in place of
   * being asked.
   */
  it('names the exact files it touched and how to undo it', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    await connectDetectedAgents('local');
    const out = logged.join('\n');
    expect(out).toContain(CLAUDE.configPath);
    expect(out).toContain(CURSOR.configPath);
    expect(out).toContain('align mcp --remove');
    // and the promise that makes an unasked write acceptable
    expect(out).toMatch(/Nothing else in them was changed/);
  });

  it('agrees in number when it touched exactly one file', async () => {
    detectEditors.mockReturnValue([CLAUDE]);
    await connectDetectedAgents('local');
    const out = logged.join('\n');
    expect(out).toContain('this file');
    expect(out).toContain('Nothing else in it was changed');
    expect(out).not.toContain('these files');
  });

  it('says nothing about files when it wrote none', async () => {
    detectEditors.mockReturnValue([]);
    await connectDetectedAgents('local');
    expect(logged.join('\n')).not.toContain('align mcp --remove');
  });

  it('keeps going, and does not claim a file it failed to write', async () => {
    detectEditors.mockReturnValue([CLAUDE, CURSOR]);
    writeMcpConfig.mockImplementationOnce(() => { throw new Error('permission denied'); });
    const r = await connectDetectedAgents('local');
    expect(writeMcpConfig).toHaveBeenCalledTimes(2);      // did not abort on the first
    expect(r).toEqual({ detected: 2, connected: 1 });
    const out = logged.join('\n');
    expect(out).toContain('permission denied');
    expect(out).not.toContain(CLAUDE.configPath);          // the one that failed
    expect(out).toContain(CURSOR.configPath);
  });

  it('hands over a portable config when no agent is installed', async () => {
    detectEditors.mockReturnValue([]);
    await connectDetectedAgents('local');
    expect(writeMcpConfig).not.toHaveBeenCalled();
    expect(logged.join('\n')).toMatch(/mcpServers/);
  });

  // Bare `align mcp --setup` resolves to the cloud default, so telling a local user to run it
  // would wire their agent to prod - the graph they did not just build.
  it('qualifies the manual command with the env', async () => {
    detectEditors.mockReturnValue([]);
    await connectDetectedAgents('local');
    expect(logged.join('\n')).toContain('align mcp --setup --env local');

    logged.length = 0;
    await connectDetectedAgents('prod');
    const out = logged.join('\n');
    expect(out).toContain('align mcp --setup');
    expect(out).not.toContain('--env');
  });
});


describe("connectDetectedAgents - the zero-editors message", () => {
  beforeEach(() => {
    logged.length = 0;
    detectEditors.mockReset();
    writeMcpConfig.mockReset();
  });

  it("does not say NOTHING was detected, since .mcp.json already covers project-scoped agents", () => {
    // David, 2026-08-31: he was in an active Claude Code session - .claude/settings.json
    // in his own paste proves it - and still got "No MCP agent detected automatically".
    // That is technically true of detectEditors() (which only checks the GLOBAL
    // ~/.claude.json) and false of his actual outcome: writeAgentAlignment had already
    // written .mcp.json a few lines earlier in the SAME run, which this file's own header
    // comment says Claude Code reads. The message needs to say that, not imply nothing
    // was wired.
    detectEditors.mockReturnValue([]);
    connectDetectedAgents("local");
    const all = logged.join("\n");
    expect(all).toContain(".mcp.json");
    expect(all).toMatch(/claude code|pi/i);
  });
});
