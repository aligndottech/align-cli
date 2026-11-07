import { Container, Editor, type EditorTheme, Loader, Markdown, type MarkdownTheme, matchesKey, ProcessTerminal, Spacer, type Terminal, Text, TuiMainScreen } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { createBroker, type HumanQuestion } from '../permission-broker.js';
import type { AgentEngine, GateOutcome, HumanAnswer, ToolAsk } from '../types.js';
import { commandCard, gateCard, gateNote, headerLine, toolLine } from './cards.js';
import { answerForKey, createController } from './controller.js';
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, statusMessage, toolActivity, wordAt } from './status.js';
import { theme } from './theme.js';

/** The only file that names pi-tui, so a breaking change there stays in one place. */
export interface AgentUiOptions {
  engine: AgentEngine;
  decisionCount: number;
  gate: (ask: ToolAsk) => Promise<GateOutcome>;
  gitRunsPrograms?: () => Promise<boolean>;
  terminal?: Terminal;
}

const markdownTheme: MarkdownTheme = {
  heading: theme.title, link: theme.link, linkUrl: theme.dim, code: theme.key, codeBlock: (s) => s,
  codeBlockBorder: theme.dim, quote: theme.dim, quoteBorder: theme.dim, hr: theme.dim, listBullet: theme.key,
  bold: chalk.bold, italic: chalk.italic, strikethrough: chalk.strikethrough, underline: chalk.underline,
};

const editorTheme: EditorTheme = {
  borderColor: theme.dim,
  selectList: { selectedPrefix: theme.key, selectedText: theme.title, description: theme.dim, scrollInfo: theme.dim, noMatch: theme.dim },
};

export async function runAgentUi(opts: AgentUiOptions): Promise<number> {
  const { engine } = opts;
  const tui = new TuiMainScreen(opts.terminal ?? new ProcessTerminal());
  const transcript = new Container();
  const editor = new Editor(tui, editorTheme);
  const controller = createController();
  let streaming: { md: Markdown; text: string } | undefined;
  let pending: { kind: 'gate' | 'command'; resolve: (a: HumanAnswer) => void } | undefined;
  let finish: (code: number) => void = () => {};

  // The status line: on for the whole turn, off while a question card waits for the person.
  const status = new Container();
  let loader: Loader | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let turnStartedAt = 0;
  let seed = 0;
  let activity: string | undefined;
  const refreshStatus = (): void => {
    const elapsedMs = Date.now() - turnStartedAt;
    loader?.setMessage(statusMessage({ word: activity ?? wordAt(seed, elapsedMs), elapsedMs }));
  };
  const showStatus = (): void => {
    if (loader) return;
    loader = new Loader(tui, theme.brand, theme.dim, '', { frames: SPINNER_FRAMES, intervalMs: SPINNER_INTERVAL_MS });
    status.addChild(loader);
    refreshStatus();
    ticker = setInterval(refreshStatus, 1000);
  };
  const hideStatus = (): void => {
    if (!loader) return;
    loader.stop();
    clearInterval(ticker);
    status.clear();
    loader = undefined;
    tui.requestRender();
  };

  const addLines = (lines: string[]): void => {
    streaming = undefined;
    for (const l of lines) transcript.addChild(new Text(l, 1, 0));
    tui.requestRender();
  };
  const endTurn = (): void => { hideStatus(); activity = undefined; controller.turnEnded(); editor.disableSubmit = false; tui.requestRender(); };

  const askHuman = (q: HumanQuestion): Promise<HumanAnswer> => {
    hideStatus();
    addLines(['', ...(q.kind === 'gate' ? gateCard(q) : commandCard(q)), '']);
    controller.beginAsk();
    return new Promise((resolve) => { pending = { kind: q.kind, resolve }; });
  };
  const broker = createBroker({ gate: opts.gate, gitRunsPrograms: opts.gitRunsPrograms, askHuman, onGate: (outcome) => addLines(gateNote(outcome)) });

  const onKey = (data: string): { consume: true } | undefined => {
    if (matchesKey(data, 'ctrl+c')) {
      if (controller.ctrlC() === 'exit') finish(0);
      else addLines([theme.dim('Press Ctrl+C again to leave.')]);
      return { consume: true };
    }
    controller.otherKey();
    if (matchesKey(data, 'ctrl+d') && controller.ctrlD(editor.getText() === '') === 'exit') { finish(0); return { consume: true }; }
    if (pending) {
      const answer = answerForKey(pending.kind, data);
      if (answer) {
        const { resolve } = pending;
        pending = undefined;
        controller.endAsk();
        showStatus();
        resolve(answer);
      }
      return { consume: true };
    }
    if (matchesKey(data, 'escape') && controller.escape() === 'abort') { engine.abort(); return { consume: true }; }
    return undefined;
  };

  editor.onSubmit = (text) => {
    const line = controller.submit(text);
    if (line === undefined) return;
    editor.setText('');
    editor.disableSubmit = true;
    addLines(['', `${theme.brand('>')} ${line}`]);
    turnStartedAt = Date.now();
    seed = Math.floor(Math.random() * 1000);
    showStatus();
    engine.prompt(line).catch((e: unknown) => addLines([theme.error(e instanceof Error ? e.message : String(e))])).finally(endTurn);
  };

  tui.addChild(new Text(headerLine({ label: engine.label, decisionCount: opts.decisionCount }), 1, 0));
  tui.addChild(new Spacer(1));
  tui.addChild(transcript);
  tui.addChild(status);
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.addInputListener(onKey);

  const closed = new Promise<number>((resolve) => { finish = resolve; });
  let failed: string | undefined;
  try {
    tui.start();
    // An engine that cannot start (no `claude`, a bad key) ends the run with its reason, printed
    // after the screen is restored, rather than throwing out of a cleared terminal.
    await engine.start((e) => {
      if (e.type === 'text') {
        if (!streaming) {
          streaming = { md: new Markdown('', 1, 0, markdownTheme), text: '' };
          transcript.addChild(streaming.md);
        }
        streaming.text += e.delta;
        streaming.md.setText(streaming.text);
      } else if (e.type === 'gate') {
        addLines(gateNote(e.outcome));
      } else if (e.type === 'error') {
        addLines([theme.error(e.message)]);
      } else {
        if (e.type === 'tool-start') { activity = toolActivity(e.tool); refreshStatus(); }
        if (e.type === 'tool-end') { activity = undefined; refreshStatus(); }
        addLines(toolLine(e));
        if (e.type === 'turn-end') endTurn();
      }
      tui.requestRender();
    }, broker).catch((err: unknown) => { failed = err instanceof Error ? err.message : String(err); });
    if (failed === undefined) {
      const code = await closed;
      await engine.close();
      return code;
    }
  } finally {
    hideStatus();
    tui.stop();
  }
  process.stderr.write(`${failed}\n`);
  return 1;
}
