import { describe, expect, it, vi } from 'vitest';
import { ALIGN_AGENT_SYSTEM_PROMPT } from '../lib/agent/engines/pi.js';
import { createBroker, type HumanQuestion } from '../lib/agent/permission-broker.js';
import type { HumanAnswer, ToolAsk } from '../lib/agent/types.js';

/**
 * A file changed from the shell never reaches the edit gate, so a decision cannot stop it. On a
 * fastify clone the agent found #7089 with align_ask, then rewrote lib/error-handler.js with a
 * python heredoc, and the person only ever saw "Run this command?". Those commands are refused
 * before anyone is asked, with a message that sends the model to the edit tool.
 */

const cmd = (command: string): ToolAsk => ({ id: `c-${command}`, tool: 'Bash', kind: 'command', command });

function setup() {
  const asked: HumanQuestion[] = [];
  const askHuman = vi.fn(async (q: HumanQuestion) => { asked.push(q); return 'allow' as HumanAnswer; });
  const broker = createBroker({ gate: vi.fn(async () => ({ kind: 'allow' as const, cards: [] })), askHuman, onGate: vi.fn() });
  return { broker, askHuman };
}

const FIELD_COMMAND = [
  "python3 - <<'E'",
  "p='lib/error-handler.js'",
  's=open(p).read()',
  's=s.replace("statusCode >= 400","statusCode >= 100")',
  "open(p,'w').write(s)",
  'E',
  'git diff --stat; npx borp test/reply-error.test.js 2>&1 | tail -15',
].join('\n');

const REFUSED: Array<[string, string]> = [
  ['the python heredoc from the field', FIELD_COMMAND],
  ['inline node code', `node -e "require('fs').writeFileSync('lib/a.js', 'x')"`],
  ['inline python code', `python3 -c "open('lib/a.py','w').write('x')"`],
  ['sed in place', "sed -i 's/400/100/' lib/error-handler.js"],
  ['perl in place', "perl -pi -e 's/400/100/' lib/error-handler.js"],
  ['a redirect into a file', 'echo x > lib/a.js'],
  ['an appending redirect', 'printf y >> lib/a.js'],
  ['tee into a file', 'echo x | tee lib/a.js'],
  ['a write chained after a test run', "npm test && sed -i 's/a/b/' lib/a.js"],
  ['sed with the long in-place flag', "sed --in-place 's/a/b/' lib/a.js"],
  ['perl with -i before -pe', "perl -i -pe 's/a/b/' lib/a.js"],
  ['code piped into python', `echo "open('lib/a.js','w')" | python3 -`],
  ['tee into a quoted path', 'echo x | tee "lib/a.js"'],
  ['a write after a harmless tee', "npm test | tee /tmp/out.log; sed -i 's/a/b/' lib/a.js"],
  ['a write behind env and an assignment', `env FOO=1 python3 -c "open('lib/a.py','w').write('x')"`],
  ['a write behind timeout', "timeout 5 sed -i 's/a/b/' lib/a.js"],
  ['an interpreter by absolute path', `/usr/bin/python3 -c "open('lib/a.py','w').write('x')"`],
  ['a versioned interpreter', `python3.11 -c "open('lib/a.py','a').write('x')"`],
  ['a redirect inside bash -c', 'bash -c "echo x > lib/a.js"'],
  ['sed inside sh -c', "sh -c 'sed -i s/a/b/ lib/a.js'"],
  ['perl in place with a backup suffix', "perl -i.bak -pe 's/a/b/' lib/a.js"],
  ['sed through xargs', "git ls-files | xargs sed -i 's/a/b/'"],
  ['awk in place', "awk -i inplace '{print}' lib/a.js"],
  ['a redirect that climbs out of /tmp', 'echo x > /tmp/../repo/lib/a.js'],
  ['test output written into the repo', 'pnpm test --reporter=json > results.json'],
  ['node --eval that writes', `node --eval "require('fs').appendFileSync('lib/a.js', 'x')"`],
  ['awk writing a file from its own program', `awk '{print > "lib/out.txt"}' lib/a.js`],
  ['git apply', 'git apply fix.patch'],
  ['patch', 'patch -p1 < fix.patch'],
  ['python copying over a file', `python3 -c "import shutil; shutil.copy('a', 'lib/b.py')"`],
];

const ASKED: Array<[string, string]> = [
  ['a test run', 'npm test'],
  ['a test run that merges stderr', 'node --test test/reply-error.test.js 2>&1 | tail -30'],
  ['output thrown away', 'npm run build > /dev/null'],
  ['output kept outside the repo', 'npm test > /tmp/test.log 2>&1'],
  ['a > inside quotes', 'grep -n "a > b" lib/a.js'],
  ['sed that only prints', "sed -n 140,175p lib/error-handler.js"],
  ['tee appending outside the repo', 'npm test | tee -a /tmp/out.log'],
  ['inline node that only prints', 'node -e "console.log(require(\'./package.json\').version)"'],
  ['inline python that only prints', `python3 -c "import json; print(json.load(open('package.json'))['name'])"`],
  ['inline ruby that only prints', 'ruby -e "puts 1"'],
  ['python reading stdin and writing stdout', `cat x | python3 -c "import sys; sys.stdout.write(sys.stdin.read())"`],
  ['a python heredoc that only reads', "python3 - <<'EOF'\nprint(open('lib/a.py').read()[:10])\nEOF"],
  ['a commit message heredoc with an arrow', 'git commit -F - <<EOF\nfix: a -> b\nEOF'],
  ['node in interactive mode', 'node -i'],
  ['a > inside a comment', 'npm test # a > b'],
  ['removing a build folder', 'rm -rf build'],
  ['python asking where git is', `python3 -c "import shutil; print(shutil.which('git'))"`],
  ['python writing bytes to stdout', `python3 -c "import sys; sys.stdout.buffer.write(b'x')"`],
  ["node writing to a child's stdin", `node -e "const p = require('child_process').spawn('cat'); p.stdin.write('x')"`],
  ['node answering an http request', `node -e "require('http').createServer((q, r) => r.write('x')).listen(0)"`],
  ['node printing a function, not calling it', `node -e "console.log(require('fs').rmSync)"`],
  ['awk comparing a field', `awk '$1 > 2' data.txt`],
];

describe('broker: commands that change files are refused, so the edit gate sees every change', () => {
  for (const [name, command] of REFUSED) {
    it(`refuses ${name} without asking, and points the model at the edit tool`, async () => {
      const { broker, askHuman } = setup();
      const v = await broker(cmd(command));
      expect(v.allow).toBe(false);
      expect((v as { message: string }).message).toContain('edit tool');
      expect(askHuman).not.toHaveBeenCalled();
    });
  }

  for (const [name, command] of ASKED) {
    it(`still asks the person for ${name}`, async () => {
      const { broker, askHuman } = setup();
      expect(await broker(cmd(command))).toEqual({ allow: true });
      expect(askHuman).toHaveBeenCalledTimes(1);
    });
  }
});

// The deterministic refusal is the floor; the prompt is what makes the agent ask before it tries.
describe("Align's agent is told to edit through the gate and to stop before reversing a decision", () => {
  const lines = ALIGN_AGENT_SYSTEM_PROMPT.split('\n');
  it('says to change files only with the edit and write tools', () => {
    expect(lines.filter((l) => l.startsWith('Change files only with the edit and write tools.'))).toHaveLength(1);
  });
  it('says to change nothing and ask when the request reverses a decision', () => {
    expect(lines.filter((l) => l.startsWith('If the graph shows a decision that the request would reverse, change nothing yet.'))).toHaveLength(1);
  });
});
