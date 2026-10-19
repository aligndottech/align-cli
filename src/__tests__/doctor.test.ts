/**
 * ALI-1740: `align doctor`, the install preflight. These tests drive the check logic through
 * injected dependencies; doctor-e2e.test.ts drives the real command, the real `align mcp` and a
 * real loopback gateway.
 *
 * Test list (each rule has two examples, the boundary included):
 *  node:     22.16.0 passes, 22.15.9 fails, 24.1.0 passes, 20.0.0 fails
 *  path:     found passes and names the path; missing fails and names the install command
 *  gateway:  answered passes; unreachable fails and names the URL
 *  whoami:   accepted passes; 401 fails naming `align login`; no token fails; unreachable fails
 *  ask:      text passes; '' fails; whitespace fails; a 401 fails naming `align login`; other error fails
 *  skips:    a missing `align` skips the ask; an unreachable gateway skips whoami
 *  local:    a local-embedded graph skips gateway and whoami, and still runs the ask
 *  verdict:  one fail anywhere fails the run; skips alone do not
 */
import { describe, expect, it, vi } from 'vitest';
import { type DoctorDeps, doctorPassed, MIN_NODE, nodeMeetsFloor, renderDoctor, runDoctor } from '../lib/doctor.js';

class Boom extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: '22.16.0',
    envName: 'prod',
    mode: 'auth',
    gatewayUrl: 'https://api.example.test',
    hasToken: true,
    findAlign: () => '/usr/local/bin/align',
    probeGateway: async () => ({ reached: true, detail: 'answered HTTP 200' }),
    whoami: async () => ({ email: 'buyer@example.test', tenant: 'Acme' }),
    askViaMcp: async () => ({ text: '{"results":[{"title":"Use Postgres"}]}' }),
    ...over,
  };
}

const byId = (checks: Awaited<ReturnType<typeof runDoctor>>, id: string) => checks.find((c) => c.id === id)!;

describe('node version', () => {
  it('the floor is 22.16', () => expect(MIN_NODE).toBe('22.16.0'));
  it.each(['22.16.0', '22.16.1', '24.1.0'])('%s passes', (v) => expect(nodeMeetsFloor(v)).toBe(true));
  it.each(['22.15.9', '22.0.0', '20.19.0'])('%s fails', (v) => expect(nodeMeetsFloor(v)).toBe(false));

  it('a too-old Node fails the check and says what to install', async () => {
    const c = byId(await runDoctor(deps({ nodeVersion: '20.11.0' })), 'node');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('20.11.0');
    expect(c.next).toMatch(/Node 22\.16 or newer/);
  });
  it('a new enough Node passes and shows the version', async () => {
    const c = byId(await runDoctor(deps({ nodeVersion: '24.1.0' })), 'node');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('24.1.0');
  });
});

describe('align on PATH', () => {
  it('found: passes and names where', async () => {
    const c = byId(await runDoctor(deps({ findAlign: () => 'C:\\npm\\align.cmd' })), 'path');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('C:\\npm\\align.cmd');
  });
  it('missing: fails and names the install command and a new terminal', async () => {
    const c = byId(await runDoctor(deps({ findAlign: () => null })), 'path');
    expect(c.status).toBe('fail');
    expect(c.next).toContain('npm install -g @aligndottech/cli');
    expect(c.next).toMatch(/new terminal/i);
  });
});

describe('gateway reachable', () => {
  it('answered: passes', async () => {
    expect(byId(await runDoctor(deps()), 'gateway').status).toBe('pass');
  });
  it('unreachable: fails, names the URL and the network as the next step', async () => {
    const c = byId(await runDoctor(deps({ probeGateway: async () => ({ reached: false, detail: 'connection refused' }) })), 'gateway');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('https://api.example.test');
    expect(c.next).toMatch(/network|VPN|proxy/i);
  });
});

describe('whoami', () => {
  it('accepted: passes and shows who', async () => {
    const c = byId(await runDoctor(deps()), 'whoami');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('buyer@example.test');
  });
  it('a 401 fails and names align login for THAT environment', async () => {
    const c = byId(await runDoctor(deps({ envName: 'acme', whoami: async () => { throw new Boom('Gateway returned 401 for /auth/me', 401); } })), 'whoami');
    expect(c.status).toBe('fail');
    expect(c.next).toContain('align login --env acme');
  });
  it('a 403 fails the same way', async () => {
    const c = byId(await runDoctor(deps({ whoami: async () => { throw new Boom('Gateway returned 403 for /auth/me', 403); } })), 'whoami');
    expect(c.status).toBe('fail');
    expect(c.next).toContain('align login --env prod');
  });
  it('no token at all fails without calling the gateway', async () => {
    let called = false;
    const c = byId(await runDoctor(deps({ hasToken: false, whoami: async () => { called = true; return { email: 'x', tenant: 'y' }; } })), 'whoami');
    expect(c.status).toBe('fail');
    expect(c.next).toContain('align login --env prod');
    expect(called).toBe(false);
  });
  it('a 500 fails and shows the gateway message', async () => {
    const c = byId(await runDoctor(deps({ whoami: async () => { throw new Boom('Gateway returned 500 for /auth/me', 500); } })), 'whoami');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('500');
  });
});

describe('a real tool call', () => {
  it('text comes back: passes', async () => {
    const c = byId(await runDoctor(deps()), 'ask');
    expect(c.status).toBe('pass');
    expect(c.detail).toMatch(/characters/);
  });
  it.each(['', '   ', '\n\t'])('an empty answer (%j) is a failure, not a pass', async (text) => {
    const c = byId(await runDoctor(deps({ askViaMcp: async () => ({ text }) })), 'ask');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/empty/i);
  });
  it.each(['null', '{}', '{"results":"none"}', '{"error":"x"}'])('JSON with no results list (%s) is not an answer', async (text) => {
    const c = byId(await runDoctor(deps({ askViaMcp: async () => ({ text }) })), 'ask');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/no results list/);
  });
  it('an empty results list is a real answer from an empty graph, and says so', async () => {
    const c = byId(await runDoctor(deps({ askViaMcp: async () => ({ text: '{"results":[]}' }) })), 'ask');
    expect(c.status).toBe('pass');
    expect(c.detail).toMatch(/0 decisions matched/);
  });
  it('a 401 from the gateway fails and names align login', async () => {
    const c = byId(await runDoctor(deps({ askViaMcp: async () => { throw new Error('Gateway returned 401 for /decisions/smart-search'); } })), 'ask');
    expect(c.status).toBe('fail');
    expect(c.next).toContain('align login --env prod');
  });
  it('any other error fails and shows the error', async () => {
    const c = byId(await runDoctor(deps({ askViaMcp: async () => { throw new Error('align mcp exited with code 1'); } })), 'ask');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('exited with code 1');
  });
  it('is handed the align that the PATH check found', async () => {
    let got = '';
    await runDoctor(deps({ findAlign: () => '/opt/x/align', askViaMcp: async (bin) => { got = bin; return { text: 'ok' }; } }));
    expect(got).toBe('/opt/x/align');
  });
});

describe('a check never reads as a pass when its prerequisite failed', () => {
  it('no align: the ask is skipped, never run', async () => {
    let called = false;
    const checks = await runDoctor(deps({ findAlign: () => null, askViaMcp: async () => { called = true; return { text: 'x' }; } }));
    expect(byId(checks, 'ask').status).toBe('skip');
    expect(called).toBe(false);
    expect(doctorPassed(checks)).toBe(false);
  });
  it('gateway unreachable: whoami is skipped', async () => {
    const checks = await runDoctor(deps({ probeGateway: async () => ({ reached: false, detail: 'timed out' }) }));
    expect(byId(checks, 'whoami').status).toBe('skip');
    expect(doctorPassed(checks)).toBe(false);
  });
});

describe('local-embedded graph', () => {
  it('has no gateway or token to check, and still makes the real tool call', async () => {
    let probed = false;
    const checks = await runDoctor(deps({ mode: 'local-embedded', hasToken: false, probeGateway: async () => { probed = true; return { reached: true, detail: '' }; } }));
    expect(byId(checks, 'gateway').status).toBe('skip');
    expect(byId(checks, 'whoami').status).toBe('skip');
    expect(byId(checks, 'ask').status).toBe('pass');
    expect(probed).toBe(false);
    expect(doctorPassed(checks)).toBe(true);
  });
  it('an empty local answer still fails', async () => {
    const checks = await runDoctor(deps({ mode: 'local-embedded', askViaMcp: async () => ({ text: '' }) }));
    expect(doctorPassed(checks)).toBe(false);
  });
});

describe('verdict and rendering', () => {
  it('all five pass: passed', async () => {
    const checks = await runDoctor(deps());
    expect(checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(doctorPassed(checks)).toBe(true);
  });
  it('one fail anywhere fails the run, whichever check it is', async () => {
    for (const over of [
      { nodeVersion: '18.0.0' },
      { findAlign: () => null },
      { probeGateway: async () => ({ reached: false, detail: 'x' }) },
      { hasToken: false },
      { askViaMcp: async () => ({ text: '' }) },
    ] as Array<Partial<DoctorDeps>>) {
      expect(doctorPassed(await runDoctor(deps(over)))).toBe(false);
    }
  });
  it('a throwing probe is a fail, not a crash', async () => {
    const checks = await runDoctor(deps({ probeGateway: async () => { throw new Error('boom'); } }));
    expect(byId(checks, 'gateway').status).toBe('fail');
  });
  it('rendering shows one line per check and the next step only under a failure', async () => {
    const out = renderDoctor(await runDoctor(deps({ findAlign: () => null })));
    expect(out).toMatch(/PASS\s+Node/);
    expect(out).toMatch(/FAIL\s+align on PATH/);
    expect(out).toMatch(/SKIP\s+Tool call/);
    expect(out).toContain('Next: ');
    expect(out.match(/Next: /g)).toHaveLength(1);
  });
  it('rendering says which way the whole run went', async () => {
    expect(renderDoctor(await runDoctor(deps()))).toMatch(/All checks passed/);
    expect(renderDoctor(await runDoctor(deps({ nodeVersion: '18.0.0' })))).toMatch(/1 check failed/);
  });
});

// ALI-1781: the on-device runtime and model are downloaded on first local use, so doctor is where
// a person finds out it could not be.
describe('on-device embeddings (local graph only)', () => {
  const local = { mode: 'local-embedded' as const };

  it('passes and says what is installed when the runtime and model are present', async () => {
    const c = byId(await runDoctor(deps({ ...local, ensureEmbeddings: async () => ({ detail: 'ONNX Runtime 1.30.0 at /c/ort; model verified at /c/hf' }) })), 'embeddings');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('ONNX Runtime 1.30.0');
  });

  it('fails with the cause, and names the hosts and the mirror variables, when the download failed', async () => {
    const checks = await runDoctor(deps({ ...local, ensureEmbeddings: async () => { throw new Error('could not reach github.com: getaddrinfo ENOTFOUND'); } }));
    const c = byId(checks, 'embeddings');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/ENOTFOUND/);
    expect(c.next).toMatch(/github\.com[\s\S]*huggingface\.co[\s\S]*ALIGN_ORT_RUNTIME_URL/);
    expect(doctorPassed(checks)).toBe(false);
  });

  it('is not run at all on a cloud install, where nothing embeds on this machine', async () => {
    const ensure = vi.fn();
    const checks = await runDoctor(deps({ mode: 'auth', ensureEmbeddings: ensure }));
    expect(checks.some((c) => c.id === 'embeddings')).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });
});
