import { Container, Editor, type EditorTheme, Loader, Markdown, type MarkdownTheme, matchesKey, ProcessTerminal, Spacer, type Terminal, Text, TuiMainScreen } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { createBroker, type HumanQuestion } from '../permission-broker.js';
import type { AgentEngine, GateOutcome, HumanAnswer, ToolAsk } from '../types.js';
import { answeredLine, commandCard, gateCard, gateNote, headerLine, oneLine, toolLine } from './cards.js';
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
  /** Lines shown under the header when the screen opens, such as a background refresh starting. */
  notices?: string[];
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
  let pending: { q: HumanQuestion; card: Container; resolve: (a: HumanAnswer) => void } | undefined;
  let finish: (code: number) => void = () => {};

  // The turn in progress, if any. Each submit gets a new id, so a late end for an older turn
  // (the turn-end event, then prompt()'s own finally) cannot end the one after it.
  let turn: { id: number; startedAt: number; seed: number } | undefined;
  let turnIds = 0;
  // Tools running now, by call id: parallel calls each keep their own words, and the newest shows.
  const running = new Map<string, string | undefined>();

  // The status line: on for the whole turn, off while a question card waits for the person.
  // The spinner's own frame tick redraws it, and the message is computed at draw time, so the
  // time and the word stay current with no second timer and no extra render.
  const status = new Container();
  let loader: Loader | undefined;
  const currentStatus = (): string => {
    const elapsedMs = turn ? Date.now() - turn.startedAt : 0;
    const activity = [...running.values()].reverse().find((a) => a !== undefined);
    return statusMessage({ word: activity ?? wordAt(turn?.seed ?? 0, elapsedMs), elapsedMs });
  };
  const showStatus = (): void => {
    if (loader || !turn) return;
    loader = new Loader(tui, theme.brand, () => theme.dim(currentStatus()), '', { frames: SPINNER_FRAMES, intervalMs: SPINNER_INTERVAL_MS });
    status.addChild(loader);
  };
  const hideStatus = (): void => {
    if (!loader) return;
    loader.stop();
    status.clear();
    loader = undefined;
    tui.requestRender();
  };

  const addLines = (lines: string[]): void => {
    streaming = undefined;
    for (const l of lines) transcript.addChild(new Text(l, 1, 0));
    tui.requestRender();
  };
  const fold = (q: HumanQuestion, card: Container, answer: HumanAnswer): void => {
    card.clear();
    card.addChild(new Text(answeredLine(q, answer), 1, 0));
    tui.requestRender();
  };
  const endTurn = (id: number | undefined): void => {
    if (!turn || turn.id !== id) return;
    turn = undefined;
    running.clear();
    hideStatus();
    // A card left open when its turn ended (an engine error, an abort) is answered no, so the
    // tool call behind it is refused and the next key goes to the editor again.
    if (pending) {
      const { q, card, resolve } = pending;
      pending = undefined;
      controller.endAsk();
      fold(q, card, 'stop');
      resolve('stop');
    }
    controller.turnEnded();
    editor.disableSubmit = false;
    tui.requestRender();
  };

  // Each card sits in its own container, so an answer can fold it to one line in place.
  const askHuman = (q: HumanQuestion): Promise<HumanAnswer> => {
    hideStatus();
    streaming = undefined;
    const card = new Container();
    for (const l of ['', ...(q.kind === 'gate' ? gateCard(q) : commandCard(q)), '']) card.addChild(new Text(l, 1, 0));
    transcript.addChild(card);
    tui.requestRender();
    controller.beginAsk();
    return new Promise((resolve) => { pending = { q, card, resolve }; });
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
      const answer = answerForKey(pending.q.kind, data);
      if (answer) {
        const { q, card, resolve } = pending;
        pending = undefined;
        controller.endAsk();
        fold(q, card, answer);
        // The approved command names itself until its tool ends (both engines key tool events by this id).
        if (q.kind === 'command' && answer !== 'stop') running.set(q.ask.id, `Running ${oneLine(q.command, 40)}`);
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
    turnIds += 1;
    const id = turnIds;
    turn = { id, startedAt: Date.now(), seed: Math.floor(Math.random() * 1000) };
    showStatus();
    engine.prompt(line).catch((e: unknown) => addLines([theme.error(e instanceof Error ? e.message : String(e))])).finally(() => endTurn(id));
  };

  tui.addChild(new Text(headerLine({ label: engine.label, decisionCount: opts.decisionCount }), 1, 0));
  for (const line of opts.notices ?? []) tui.addChild(new Text(theme.dim(line), 1, 0));
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
        if (e.type === 'tool-start') { running.set(e.id, toolActivity(e.tool)); loader?.invalidate(); }
        if (e.type === 'tool-end') { running.delete(e.id); loader?.invalidate(); }
        addLines(toolLine(e));
        if (e.type === 'turn-end') endTurn(turn?.id);
      }
      tui.requestRender();
    }, broker).catch((err: unknown) => { failed = err instanceof Error ? err.message : String(err); });
    if (failed === undefined) {
      const code = await closed;
      // Stop drawing before the engine closes: a slow close must not leave the spinner going.
      hideStatus();
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
