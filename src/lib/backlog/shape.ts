import { callChatDetailed, noProviderHintLines } from '../local-llm.js';
import type { PlannedTask } from './ledger.js';

export interface ShapeInput { id: string; title: string; summary: string; actions: string[] }

export const SHAPE_SYSTEM_PROMPT =
  'You turn one recorded engineering decision into a short backlog of implementation tasks. ' +
  'Reply with JSON only, no prose: {"tasks":[{"title":"...","body":"..."}]}. ' +
  'Each task is one piece of work a person can pick up and finish. Title: imperative, under 90 characters. ' +
  'Body: one to three short sentences saying what to do and how to know it is done. ' +
  'Use only what the decision says. Never invent systems, files, owners or dates it does not name. ' +
  'If the decision implies no work, reply {"tasks":[]}. Plain hyphens only, no em dashes.';

export function shapePrompt(d: ShapeInput, max: number): string {
  const actions = d.actions.length ? `\nActions already listed on the decision:\n${d.actions.map((a) => `- ${a}`).join('\n')}` : '';
  return `Decision: ${d.title}\n\n${d.summary}${actions}\n\nWrite at most ${max} tasks.`;
}

const BODY_MAX = 1_500;
/** Model text goes into someone's tracker: no remote images, no @mentions that notify people, and a length cap. */
export const safeBody = (s: string): string =>
  noEmDash(s).replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b').trim().slice(0, BODY_MAX);

export const noEmDash = (s: string): string => s.replace(/[^\S\r\n]*—[^\S\r\n]*/g, ' - ');

/** Parse the model's reply. Returns null for anything that is not the requested shape: nothing is ever made up to fill the gap. */
export function parseTasks(raw: string): PlannedTask[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1]! : raw).trim();
  const start = body.indexOf('{'); const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  const list = (parsed as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return null;
  const out: PlannedTask[] = [];
  for (const t of list) {
    const title = (t as { title?: unknown } | null)?.title;
    const text = (t as { body?: unknown } | null)?.body;
    if (typeof title !== 'string' || title.trim() === '') return null;
    out.push({ title: safeBody(title).replace(/\s+/g, ' ').slice(0, 200), body: safeBody(typeof text === 'string' ? text : '') });
  }
  return out;
}

export type ShapeResult = { ok: true; text: string } | { ok: false; message: string };

/** The real shaper: whatever model `align ask` already uses. No model means no tasks, said plainly. */
export async function shapeWithModel(d: ShapeInput, max: number): Promise<ShapeResult> {
  const r = await callChatDetailed(SHAPE_SYSTEM_PROMPT, shapePrompt(d, max), { maxTokens: 2_000, temperature: 0 });
  if (r.ok) return { ok: true, text: r.text };
  const f = r.failure;
  if (f.kind === 'no_provider') return { ok: false, message: ['No tasks written: no LLM configured. Any one of these works:', ...noProviderHintLines().slice(1)].join('\n') };
  if (f.kind === 'provider_stopped') return { ok: false, message: `No tasks written: ${f.provider} (${f.model}) answered unusably: ${f.detail}` };
  if (f.kind === 'providers_unavailable') return { ok: false, message: `No tasks written: every configured model was unavailable (${f.tried.map((t) => t.provider).join(', ')}).` };
  return { ok: false, message: 'No tasks written: the local models found are not ones this CLI can use. Set a cloud key or ALIGN_LLM_BASE_URL.' };
}
