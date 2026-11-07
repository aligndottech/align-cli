import type { HumanAnswer } from '../types.js';

/** The screen's state machine, with no terminal in it so it can be tested on its own. */
export type Phase = 'idle' | 'running' | 'awaiting-answer';

export interface Controller {
  phase(): Phase;
  /** Returns the text to send, or undefined when the line is empty or a turn is already running. */
  submit(text: string): string | undefined;
  turnEnded(): void;
  beginAsk(): void;
  endAsk(): void;
  /** Esc: abort only while a turn runs (not while a question is open). */
  escape(): 'abort' | 'none';
  /** Two in a row exit. */
  ctrlC(): 'hint' | 'exit';
  /** Any key that is not Ctrl+C resets the exit count. */
  otherKey(): void;
  ctrlD(editorEmpty: boolean): 'exit' | 'none';
}

export function createController(): Controller {
  let phase: Phase = 'idle';
  // A question can open with no turn running (a late broker call); answering it must not invent one.
  let beforeAsk: Phase = 'idle';
  let ctrlCs = 0;
  return {
    phase: () => phase,
    submit(text) {
      const t = text.trim();
      if (phase !== 'idle' || t === '') return undefined;
      phase = 'running';
      return t;
    },
    turnEnded() { phase = 'idle'; },
    beginAsk() { if (phase !== 'awaiting-answer') beforeAsk = phase; phase = 'awaiting-answer'; },
    endAsk() { phase = beforeAsk; },
    escape: () => (phase === 'running' ? 'abort' : 'none'),
    ctrlC() { ctrlCs += 1; return ctrlCs >= 2 ? 'exit' : 'hint'; },
    otherKey() { ctrlCs = 0; },
    ctrlD: (editorEmpty) => (editorEmpty ? 'exit' : 'none'),
  };
}

const ANSWER_KEYS: Record<'gate' | 'command', Record<string, HumanAnswer>> = {
  gate: { a: 'allow', s: 'stop' },
  command: { y: 'allow', s: 'allow-session', n: 'stop' },
};

export function answerForKey(kind: 'gate' | 'command', key: string): HumanAnswer | undefined {
  return ANSWER_KEYS[kind][key.toLowerCase()];
}
