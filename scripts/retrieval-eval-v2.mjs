#!/usr/bin/env node
/**
 * Retrieval eval v2 (ALI-1749, ALI-1782): newcomer-worded questions that are NOT derived from the
 * commit subject.
 *
 * Why it exists: eval v1 templates its questions from the commit subject, which is also the
 * indexed title, so a plain title-overlap ranker with no embeddings scored 82.7% recall@3 against
 * the product's 81.4%. It measures import coverage and cannot judge ranking. Here a model sees ONLY
 * the commit's body (the stated reason; never the subject, never the sha) and writes two questions
 * a developer new to the repo would ask. The questions are generated ONCE and frozen in
 * scripts/retrieval-eval-v2-questions.json. After that the harness needs no model and no network
 * beyond the repo clones.
 *
 *   node scripts/retrieval-eval-v2.mjs select   [--work dir] [--label main] [--per-repo 16]
 *   node scripts/retrieval-eval-v2.mjs estimate [--work dir]
 *   node scripts/retrieval-eval-v2.mjs generate [--work dir] [--cap-usd 3]    (the ONLY step that reads ANTHROPIC_API_KEY)
 *   node scripts/retrieval-eval-v2.mjs import-written --file a.json,b.json --generator <name>   (when no API is available: questions written blind from the printed bodies)
 *   node scripts/retrieval-eval-v2.mjs check    [--work dir]                  (leakage guard + 20 random questions)
 *   node scripts/retrieval-eval-v2.mjs run      [--work dir] [--label l] [--cli root] [--out file] [--table]
 *
 * `select` picks, per repo, commits that are in the graph of --label (the default import's own
 * keep set), state a reason in the body, and are not dependency bumps, releases or reverts.
 * Questions are about what the import KEPT, so recall measures ranking; import coverage is what
 * eval v1 (retrieval-eval.mjs) measures.
 *
 * WHAT IT CAN AND CANNOT SHOW. The questions are paraphrases written from the commit BODY, so they
 * share vocabulary with the indexed body text by construction. That is much harder than v1 (a plain
 * title-overlap ranker with no embeddings scores 55.7% recall@8 here against 82.7% on v1) and it
 * still favours anything that indexes the body. The leakage guard is a floor, not proof: no 4-word run and
 * at most two stemmed content words shared with the subject, no commit whose body restates the subject, and a
 * short exclusion list of commits a reviewer found ambiguous. Scores are micro-averaged over about 120
 * independent commits (two questions each), so a per-repo difference of a few points is noise. The repos
 * include align-cli and adr, which are atypical. A real newcomer who never saw the body words will
 * do worse than this set says: read the numbers as a ceiling on paraphrased questions, not a rate.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.join(HERE, 'retrieval-eval-v2-questions.json');
const REPOS_FILE = path.join(HERE, 'retrieval-eval-repos.json');
const SEED = 'ali-1749-v2';
export const GENERATOR_MODEL = 'claude-haiku-5-5';
const RESULT_LIMIT = 50;

// Conservative per-million-token prices for the spend cap (above any Haiku-class list price).
const USD_PER_MTOK_IN = 3;
const USD_PER_MTOK_OUT = 15;

const args = process.argv.slice(2);
const step = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const WORK = path.resolve(opt('work', path.join(os.tmpdir(), 'retrieval-eval')));
const LABEL = opt('label', 'main');
const CLI = path.resolve(opt('cli', path.resolve(HERE, '..')));

// ---------- pure helpers (exported for the fixture test) ----------
const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const wordsOf = t => norm(t).split(' ').filter(Boolean);

/** The first run of >= n consecutive words the question shares with the text, or null. */
export function sharedRun(question, text, n = 4) {
  const q = wordsOf(question);
  const grams = new Set();
  const t = wordsOf(text);
  for (let i = 0; i + n <= t.length; i++) grams.add(t.slice(i, i + n).join(' '));
  for (let i = 0; i + n <= q.length; i++) if (grams.has(q.slice(i, i + n).join(' '))) return q.slice(i, i + n).join(' ');
  return null;
}

/** Why a question leaks its answer, or null. The subject is the indexed title; the sha is the key. */
export function leak(question, subject, sha) {
  const run = sharedRun(question, subject, 4);
  if (run) return `shares "${run}" with the subject`;
  const s = norm(subject);
  if (s && wordsOf(s).length >= 2 && ` ${norm(question)} `.includes(` ${s} `)) return 'contains the whole subject';
  if (new RegExp(sha.slice(0, 7), 'i').test(question)) return 'contains the sha';
  const shared = sharedContent(question, subject);
  if (shared.length > MAX_SHARED_CONTENT) return `shares content words ${shared.join(', ')} with the subject`;
  return null;
}

// Commits a fresh-context review found to have no single right answer (sibling commits on the same topic) or a weak
// newcomer question. Excluded by sha prefix so the fixture can be regenerated without them coming back.
export const EXCLUDED = ['580b250', '236c831', '708fed7', '32ea0ea', 'ae1ed9b', 'c12b576'];
const STOPWORDS = new Set('why how what when where who which do does did is are was were be been can should would i me my we us our you your they their a an the of to for on in at about and or that this it its there with from by as not no into than then also only now no longer any all'.split(' '));
const stemW = t => t.replace(/(ing|ed|es|s)$/, '');
const contentWords = t => new Set(wordsOf(t).filter(w => !STOPWORDS.has(w) && w.length > 2).map(stemW));
/** Content words (stemmed, stop words dropped) the question shares with the subject. */
export function sharedContent(question, subject) {
  const s = contentWords(subject);
  return [...contentWords(question)].filter(w => s.has(w));
}
export const MAX_SHARED_CONTENT = 2;

const NOISE_SUBJECT = /^(chore\(main\): release|release\b|v?\d+\.\d+|revert\b|bump\b|chore\(deps|build\(deps|update dependency|merge\b)|dependabot|\bbump\b.*\bfrom\b.*\bto\b|^\d+\.\d+/i;

export function reasonText(subject, body, cleanSubject) {
  const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|helped-by|cc|refs?|closes?|fixes?|resolves?|bug|change-id)\s*:/i;
  const n = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const cs = cleanSubject(subject);
  return body.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !TRAILER.test(l) && !/^(?:🤖\s*)?generated (with|by)\b/i.test(l) && !/^https?:\/\/\S+$/.test(l))
    .filter(l => n(l) !== n(subject) && n(l) !== n(cs))
    .join('\n');
}

// ---------- select ----------
async function select() {
  const ev = await import(pathToFileURL(path.join(HERE, 'retrieval-eval.mjs')).href);
  const perRepo = Number(opt('per-repo', '16'));
  const repos = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
  // --extend adds more commits for --repos after the ones already selected, so earlier indexes keep their meaning.
  const selFile = path.join(WORK, 'v2-selected.json');
  const out = args.includes('--extend') ? JSON.parse(fs.readFileSync(selFile, 'utf8')) : [];
  const have = new Set(out.map(c => c.sha));
  const only = opt('repos', null)?.split(',');
  for (const r of repos.filter(x => !only || only.includes(x.name))) {
    const dir = path.join(WORK, 'repos', r.name);
    const SEP = '\x1f';
    const log = execFileSync('git', ['-C', dir, 'log', '--no-merges', r.sha, `--format=C${SEP}%H${SEP}%s${SEP}%b${SEP}E`], { encoding: 'utf8', maxBuffer: 1 << 29 });
    const db = new DatabaseSync(path.join(WORK, 'graphs', LABEL, r.name, 'home/.align/local.db'), { readOnly: true });
    const inGraph = sha => db.prepare('SELECT 1 FROM decisions WHERE source_url LIKE ?').get(`%/commit/${sha}`) !== undefined;
    const cands = [];
    for (const chunk of log.split(`${SEP}E\n`)) {
      const [mark, sha, subject, ...body] = chunk.replace(/^\n/, '').split(SEP);
      if (mark !== 'C' || !/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
      if (NOISE_SUBJECT.test(subject)) continue;
      const reason = reasonText(subject, body.join(SEP), ev.cleanSubject);
      const words = reason.split(/\s+/).filter(Boolean).length;
      if (words < 15 || !ev.statesReason(subject, body.join(SEP))) continue;
      if (!inGraph(sha)) continue;
      cands.push({ repo: r.name, sha, subject, reason: reason.slice(0, 1200) });
    }
    db.close();
    cands.sort((a, b) => (h(a) < h(b) ? -1 : 1));
    const fresh = cands.filter(c => !have.has(c.sha)).slice(0, perRepo);
    out.push(...fresh);
    console.log(`${r.name}\tcandidates=${cands.length}\tselected=${fresh.length}`);
  }
  fs.writeFileSync(selFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`selected ${out.length} commits -> ${out.length * 2} questions`);
}
const h = c => createHash('sha256').update(SEED + c.sha).digest('hex');

// ---------- generate ----------
const PROMPT = reason => `Below is the explanation a developer wrote for one change to a code repository. You do not see the change's title.

<explanation>
${reason}
</explanation>

Imagine you are a developer who is new to this repository. You noticed how something works and want to know why it is that way. Write exactly two questions, each answerable from the explanation above:
- "concept": a question that names the concept or behaviour in general terms.
- "symptom": a question that describes a symptom or surprise someone would run into.

Rules: plain everyday words. Do not copy rare identifiers, file names, option names, function names or version numbers from the explanation; describe them in ordinary words instead. Do not write the title of a change. Each question is 6 to 20 words and ends with a question mark.

Return only JSON: {"concept": "...", "symptom": "..."}`;

function estimate() {
  const sel = JSON.parse(fs.readFileSync(path.join(WORK, 'v2-selected.json'), 'utf8'));
  const inTok = sel.reduce((a, c) => a + Math.ceil(PROMPT(c.reason).length / 3.5), 0);
  const outTok = sel.length * 90;
  const usd = (inTok * USD_PER_MTOK_IN + outTok * USD_PER_MTOK_OUT) / 1e6;
  console.log(`commits=${sel.length} questions=${sel.length * 2} (target <= 300)  est input tokens=${inTok} output tokens=${outTok}`);
  console.log(`estimated spend at conservative $${USD_PER_MTOK_IN}/$${USD_PER_MTOK_OUT} per Mtok: $${usd.toFixed(3)}  (cap $${opt('cap-usd', '3')})`);
  return usd;
}

async function generate() {
  const cap = Number(opt('cap-usd', '3'));
  const sel = JSON.parse(fs.readFileSync(path.join(WORK, 'v2-selected.json'), 'utf8'));
  if (sel.length * 2 > 300) throw new Error(`refusing: ${sel.length * 2} questions exceeds the 300 target`);
  if (estimate() > cap) throw new Error('estimate exceeds the cap, aborting before any call');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const cacheFile = path.join(WORK, 'v2-raw.json');
  const raw = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  let spent = Object.values(raw).reduce((a, x) => a + x.usd, 0);
  for (const c of sel) {
    if (raw[c.sha]) continue;
    if (spent > cap) throw new Error(`spend $${spent.toFixed(3)} exceeded the cap, aborting`);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: GENERATOR_MODEL, max_tokens: 400, messages: [{ role: 'user', content: PROMPT(c.reason) }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const usd = ((j.usage?.input_tokens ?? 0) * USD_PER_MTOK_IN + (j.usage?.output_tokens ?? 0) * USD_PER_MTOK_OUT) / 1e6;
    spent += usd;
    raw[c.sha] = { text: j.content?.find(b => b.type === 'text')?.text ?? '', usd, usage: j.usage };
    fs.writeFileSync(cacheFile, JSON.stringify(raw, null, 2));
  }
  buildFixture(sel, Object.fromEntries(Object.entries(raw).map(([sha, x]) => {
    try { const j = JSON.parse(x.text.match(/\{[\s\S]*\}/)[0]); return [sha, [j.concept, j.symptom]]; } catch { return [sha, null]; }
  })), GENERATOR_MODEL, spent);
}

/**
 * Write the frozen fixture from `{ sha: [concept question, symptom question] }`. Every question goes
 * through the leakage guard; a failing or duplicate one is dropped and printed.
 */
function buildFixture(sel, bySha, generator, spent) {
  const repos = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
  const shaOf = Object.fromEntries(repos.map(r => [r.name, r.sha]));
  const date = new Date().toISOString().slice(0, 10);
  const items = [];
  const dropped = [];
  const seen = new Set();
  for (const c of sel) {
    const pair = bySha[c.sha];
    // The writer saw the subject if the body restates it, so the questions cannot be called subject-blind.
    const subj = norm(c.subject.replace(/^\s*\w+(\([^)]*\))?!?:\s*/, '').replace(/\s*\(#\d+\)\s*$/, ''));
    if (EXCLUDED.some(x => c.sha.startsWith(x))) { dropped.push({ sha: c.sha, why: 'excluded after review (ambiguous or weak)' }); continue; }
    if (subj.split(' ').length >= 3 && norm(c.reason).includes(subj)) { dropped.push({ sha: c.sha, why: 'body restates the subject' }); continue; }
    if (!pair) { dropped.push({ sha: c.sha, why: 'no questions' }); continue; }
    for (const [i, kind] of ['concept', 'symptom'].entries()) {
      const q = String(pair[i] ?? '').trim();
      const why = !q ? 'empty' : leak(q, c.subject, c.sha) ?? (seen.has(norm(q)) ? 'duplicate' : null);
      if (why) { dropped.push({ sha: c.sha, kind, why, q }); continue; }
      seen.add(norm(q));
      items.push({ repo: c.repo, clone_sha: shaOf[c.repo], expected_sha: c.sha, kind, question: q, subject: c.subject, generator, date });
    }
  }
  fs.writeFileSync(FIXTURE, `${JSON.stringify({ generator, date, spent_usd: Number(spent.toFixed(4)), items }, null, 2)}\n`);
  console.log(`${dropped.filter(d => d.why === 'body restates the subject').length} commits dropped because the body restates the subject`);
  console.log(`wrote ${items.length} questions for ${new Set(items.map(i => i.expected_sha)).size} commits, dropped ${dropped.length}, spent $${spent.toFixed(4)}`);
  for (const d of dropped.filter(x => x.why !== 'no questions')) console.log('dropped', JSON.stringify(d).slice(0, 220));
}

/** Questions written by hand or by an agent: `--file` is `{ "<index into v2-selected.json>": [concept, symptom] }`, indexes as printed by `show`. */
function importWritten() {
  const sel = JSON.parse(fs.readFileSync(path.join(WORK, 'v2-selected.json'), 'utf8'));
  const written = Object.assign({}, ...opt('file', '').split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8'))));
  const bySha = {};
  for (const [idx, pair] of Object.entries(written)) bySha[sel[Number(idx)].sha] = pair;
  buildFixture(sel, bySha, opt('generator', 'unknown'), 0);
}

// ---------- check ----------
function check() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const bad = fx.items.map(i => ({ i, why: leak(i.question, i.subject, i.expected_sha) })).filter(x => x.why);
  console.log(`${fx.items.length} questions, ${bad.length} leak`);
  for (const b of bad) console.log('LEAK', b.why, '|', b.i.question, '|', b.i.subject);
  const sorted = [...fx.items].sort((a, b) => (createHash('sha256').update('sample' + a.expected_sha + a.kind).digest('hex') < createHash('sha256').update('sample' + b.expected_sha + b.kind).digest('hex') ? -1 : 1));
  console.log('\n20 sampled (read them against the subject):');
  for (const i of sorted.slice(0, 20)) console.log(`[${i.repo}/${i.kind}] ${i.question}\n    subject: ${i.subject}`);
  if (bad.length) process.exit(1);
}

// ---------- run ----------
async function run() {
  const mod = await import(pathToFileURL(path.join(CLI, 'dist/lib/local-gateway-client.js')).href);
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const repos = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
  const rows = [];
  const perRepo = [];
  for (const r of repos) {
    const dbPath = path.join(WORK, 'graphs', LABEL, r.name, 'home/.align/local.db');
    if (!fs.existsSync(dbPath)) throw new Error(`${r.name}: no graph for label ${LABEL}; run retrieval-eval.mjs build first (a missing repo would silently shrink the aggregate)`);
    const head = execFileSync('git', ['-C', path.join(WORK, 'repos', r.name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== r.sha) throw new Error(`${r.name}: clone is at ${head}, the fixture pins ${r.sha}`);
    const client = mod.createLocalGatewayClient(dbPath, { cwd: path.join(WORK, 'repos', r.name) });
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const inGraph = sha => ro.prepare('SELECT 1 FROM decisions WHERE source_url LIKE ?').get(`%/commit/${sha}`) !== undefined;
    const s = { repo: r.name, n: 0, in_graph: 0, r3: 0, r8: 0, rr: 0 };
    const t0 = Date.now();
    for (const p of fx.items.filter(x => x.repo === r.name)) {
      const res = await client.searchDecisions(p.question, RESULT_LIMIT, undefined, { all: true });
      const idx = res.results.findIndex(x => (x.source_url ?? '').includes(`/commit/${p.expected_sha}`));
      const rank = idx === -1 ? null : idx + 1;
      s.n++;
      const imported = inGraph(p.expected_sha);
      if (imported) s.in_graph++;
      if (rank !== null && rank <= 3) s.r3++;
      if (rank !== null && rank <= 8) s.r8++;
      if (rank !== null) s.rr += 1 / rank;
      rows.push({ repo: r.name, kind: p.kind, rank, imported, sha: p.expected_sha.slice(0, 7), question: p.question, top: res.results[0]?.title.slice(0, 50) ?? '-' });
    }
    s.ms = Math.round((Date.now() - t0) / Math.max(1, s.n));
    ro.close();
    client.close?.();
    perRepo.push(s);
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-');
  console.log(`\nv2 label=${LABEL} cli=${CLI}`);
  console.log('repo\tn\tcoverage\trecall@3\trecall@8\tMRR\tms/query');
  const tot = { n: 0, in_graph: 0, r3: 0, r8: 0, rr: 0 };
  for (const s of perRepo) {
    console.log(`${s.repo}\t${s.n}\t${pct(s.in_graph, s.n)}\t${pct(s.r3, s.n)}\t${pct(s.r8, s.n)}\t${(s.rr / s.n).toFixed(3)}\t${s.ms}`);
    for (const k of Object.keys(tot)) tot[k] += s[k];
  }
  console.log(`AGGREGATE\t${tot.n}\t${pct(tot.in_graph, tot.n)}\t${pct(tot.r3, tot.n)}\t${pct(tot.r8, tot.n)}\t${(tot.rr / tot.n).toFixed(3)}\t-`);
  if (args.includes('--table')) for (const x of rows) console.log(`${x.repo}\t${x.kind}\t${x.rank ?? '-'}\t${x.sha}\t${x.question}\t[top: ${x.top}]`);
  if (opt('out', null)) fs.writeFileSync(opt('out'), `${JSON.stringify({ label: LABEL, perRepo, tot, rows }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (step === 'select') await select();
  else if (step === 'estimate') estimate();
  else if (step === 'generate') await generate();
  else if (step === 'import-written') importWritten();
  else if (step === 'check') check();
  else if (step === 'run') await run();
  else { console.error('usage: retrieval-eval-v2.mjs select|estimate|generate|check|run [--work dir] [--label l] [--cli root] [--out file] [--table]'); process.exit(2); }
}
