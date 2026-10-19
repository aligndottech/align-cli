#!/usr/bin/env node
/**
 * Retrieval quality eval for the local graph (ALI-1749). No LLM, no provider key, no network
 * beyond the repo clones and the one-time embedding model.
 *
 *   node scripts/retrieval-eval.mjs <step> [--cli <root>] [--label <name>] [--work <dir>] [--repo <name>]
 *
 *   clone   clone each repo in scripts/retrieval-eval-repos.json and pin it at its recorded sha
 *           (records the sha of a repo that has none yet)
 *   pairs   derive question -> expected-commit pairs from `git log` (deterministic, see below)
 *   build   import each pinned repo with the REAL `align connect git --approve` of <cli> into an
 *           isolated HOME, one graph per (label, repo). Skipped when that graph already exists.
 *           --prs: import the way FIRST RUN does instead (ALI-1782), in process through <cli>'s own
 *           modules: the commits, then the merged PR descriptions of the repo's GitHub origin
 *           (fetchFirstRunPrs, unauthenticated, responses cached under <work>/prcache so a second
 *           build or label costs no API quota), with the squash commits of imported PRs dropped.
 *           Build a no-PR graph the same in-process way with --no-prs to compare like with like.
 *   run     ask every question of the local graph through <cli>'s createLocalGatewayClient and
 *           print recall@3, recall@8, MRR per repo and in aggregate, plus the rank table
 *   all     clone, pairs, build, run
 *
 * <cli> is a directory holding `dist/` (npm run build) and `node_modules/`. Default: this repo.
 * NOTE what this eval can and cannot show: questions are templated from the commit SUBJECT, which is
 * also the indexed title, so once a commit is in the graph a title-matching ranker finds it
 * (recall@8 of imported is the column to read for that). It measures import COVERAGE well and
 * ranking changes poorly; a ranking lever needs questions that do not reuse the subject, which is
 * what retrieval-eval-v2.mjs is for. Keep this one as the regression column.
 * Pass the same <label> to reuse a graph, a new label to re-import (needed when the import or
 * the embedded text changed). `run` can be repeated on a graph to measure noise.
 *
 * HOW THE PAIRS ARE DERIVED (nothing here reads the retriever):
 *  - every non-merge commit reachable from the pinned sha, over the WHOLE history, not just what
 *    the importer would keep: a question about a commit the import never saw is a real miss
 *  - the cleaned subject (conventional prefix, PR number and list bullet stripped) must start
 *    with a decision verb: remove/drop/delete/retire, deprecate, replace, rename, switch,
 *    migrate, move, disable, stop, "add support"
 *  - the body must state a reason: after dropping trailers, attribution and lines that echo the
 *    subject, at least one sentence of 5+ words remains
 *  - the question is a template over the cleaned subject: "why was <object> <past verb>" for
 *    remove-like verbs, "why did we <verb phrase>" otherwise. For remove/drop/delete/retire the
 *    verb is rotated by sha, so the question does not simply echo the commit's own verb
 *  - housekeeping subjects (unused, typo, comment, redundant, duplicate, ...) are skipped
 *  - a question text shared by two commits is dropped (it has no single right answer)
 *  - PAIRS_PER_REPO pairs per repo, taken by sha256(seed + sha) order
 * The retriever sees only the question string. The sha stays in this process and is matched
 * against the result's source_url.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPOS_FILE = path.join(HERE, 'retrieval-eval-repos.json');
const SEED = 'ali-1749-v1';
const PAIRS_PER_REPO = 25;
const RESULT_LIMIT = 50;

const args = process.argv.slice(2);
const step = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const CLI = path.resolve(opt('cli', ROOT));
const LABEL = opt('label', 'default');
const WORK = path.resolve(opt('work', path.join(os.tmpdir(), 'retrieval-eval')));
const ONLY = opt('repo', null);
const BUILD_IN_PROCESS = args.includes('--prs') || args.includes('--no-prs');
const WITH_PRS = args.includes('--prs');

const repos = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')).filter(r => !ONLY || r.name === ONLY);
const cloneDir = r => path.join(WORK, 'repos', r.name);
const pairsFile = r => path.join(WORK, 'pairs', `${r.name}.json`);
const homeDir = r => path.join(WORK, 'graphs', LABEL, r.name, 'home');
const git = (r, ...a) => execFileSync('git', ['-C', cloneDir(r), ...a], { encoding: 'utf8', maxBuffer: 1 << 29 });

// ---------- clone ----------
function cloneAll() {
  for (const r of repos) {
    fs.mkdirSync(path.dirname(cloneDir(r)), { recursive: true });
    if (!fs.existsSync(cloneDir(r))) execFileSync('git', ['clone', '--quiet', `https://github.com/${r.repo}`, cloneDir(r)], { stdio: 'inherit' });
    if (!r.sha) {
      r.sha = git(r, 'rev-parse', 'HEAD').trim();
      const all = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
      all.find(x => x.name === r.name).sha = r.sha;
      fs.writeFileSync(REPOS_FILE, `${JSON.stringify(all, null, 2)}\n`);
    }
    git(r, 'checkout', '--quiet', '--detach', r.sha);
    console.log(`${r.name}\t${r.sha}\t${git(r, 'rev-list', '--count', 'HEAD').trim()} commits`);
  }
}

// ---------- pairs ----------
const VERB_PAST = { remove: 'removed', drop: 'dropped', delete: 'deleted', retire: 'retired', deprecate: 'deprecated', disable: 'disabled', stop: 'stopped' };
const ROTATE = ['removed', 'dropped', 'deleted', 'retired'];
const PASSIVE = /^(remove|drop|delete|retire|deprecate|disable)\s+(.+)$/i;
const ACTIVE = /^(replace|rename|switch|migrate|move|stop|add support)\b(.*)$/i;

export function cleanSubject(s) {
  return s
    .replace(/^\s*[*-]\s*/, '')
    .replace(/^\w+(\([^)]*\))?!?:\s*/, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s*#\d+\s*$/, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|helped-by|cc|refs?|closes?|fixes?|resolves?|bug|change-id)\s*:/i;
export function statesReason(subject, body) {
  const norm = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const kept = body.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !TRAILER.test(l) && !/^(?:🤖\s*)?generated (with|by)\b/i.test(l) && !/^https?:\/\/\S+$/.test(l))
    .filter(l => norm(l) !== norm(subject));
  return kept.join(' ').split(/(?<=[.!?])\s+|\n+/).some(sentence => sentence.trim().split(/\s+/).length >= 5);
}

// Housekeeping is not a decision a newcomer asks "why" about; the product's own import filter
// treats it the same way. Kept deliberately short so it does not become a tuning knob.
const HOUSEKEEPING = /\b(unused|typos?|comments?|commented|repetition|whitespace|lint\w*|trailing|redundant|duplicate[ds]?|dead|obsolete|stale|empty|extra|useless|unnecessary)\b/i;

const FILLER = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'with', 'from', 'by', 'as', 'is', 'are']);
/**
 * A looser phrasing of the same question, the way a newcomer who does not know the exact wording
 * asks it: about 40% of the object's content words are dropped (by sha, never below two kept).
 * Null when the object is too short to drop anything, so the loose set holds only questions that
 * genuinely differ from the commit's own words.
 */
export function looser(sha, obj, build) {
  const words = obj.split(/\s+/);
  const content = words.map((w, i) => (FILLER.has(w.toLowerCase()) ? -1 : i)).filter(i => i >= 0);
  if (content.length < 4) return null;
  const h = i => parseInt(createHash('sha256').update(`${SEED}${sha}${i}`).digest('hex').slice(0, 4), 16) % 5;
  const drop = new Set(content.filter(i => h(i) < 2));
  while (content.length - drop.size < 2) drop.delete([...drop][0]);
  if (drop.size === 0) return null;
  return build(words.filter((_, i) => !drop.has(i)).join(' '));
}

export function questionFor(sha, cleaned) {
  const words = cleaned.split(/\s+/);
  if (words.length < 3 || words.length > 14) return null;
  if (HOUSEKEEPING.test(cleaned) || /…|\.\.\./.test(cleaned)) return null;
  const rot = parseInt(sha.slice(0, 4), 16);
  let m = PASSIVE.exec(cleaned);
  if (m) {
    const verb = m[1].toLowerCase();
    const obj = m[2].replace(/\s+(from|in|for)\s+.*$/i, '').trim();
    // A one-word lowercase object ("test", "docs") names nothing a question could single out.
    if (obj.length < 3 || (obj.split(/\s+/).length < 2 && /^[a-z]+$/.test(obj))) return null;
    const past = ['remove', 'drop', 'delete', 'retire'].includes(verb) ? ROTATE[rot % ROTATE.length] : VERB_PAST[verb];
    return { exact: `why was ${obj} ${past}`, loose: looser(sha, obj, o => `why was ${o} ${past}`) };
  }
  m = ACTIVE.exec(cleaned);
  if (m) {
    const lower = `${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
    const verbEnd = m[1].length;
    return { exact: `why did we ${lower}`, loose: looser(sha, lower.slice(verbEnd).trim(), o => `why did we ${lower.slice(0, verbEnd)} ${o}`) };
  }
  return null;
}

function derivePairs(r) {
  const SEP = '\x1f';
  const out = git(r, 'log', '--no-merges', `--format=C${SEP}%H${SEP}%s${SEP}%aI${SEP}%b${SEP}E`);
  const commits = [];
  for (const chunk of out.split(`${SEP}E\n`)) {
    const [mark, sha, subject, date, ...body] = chunk.replace(/^\n/, '').split(SEP);
    if (mark !== 'C' || !/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
    commits.push({ sha, subject, date, body: body.join(SEP) });
  }
  const cands = [];
  for (const c of commits) {
    const cleaned = cleanSubject(c.subject);
    if (!statesReason(c.subject, c.body)) continue;
    const q = questionFor(c.sha, cleaned);
    if (q) cands.push({ sha: c.sha, date: c.date, subject: c.subject, question: q.exact, loose: q.loose });
  }
  const seen = new Map();
  for (const c of cands) seen.set(c.question, (seen.get(c.question) ?? 0) + 1);
  const unique = cands.filter(c => seen.get(c.question) === 1);
  const h = c => createHash('sha256').update(SEED + c.sha).digest('hex');
  unique.sort((a, b) => (h(a) < h(b) ? -1 : 1));
  return { repo: r.name, sha: r.sha, totalCommits: commits.length, candidates: unique.length, pairs: unique.slice(0, PAIRS_PER_REPO) };
}

function pairsAll() {
  fs.mkdirSync(path.join(WORK, 'pairs'), { recursive: true });
  for (const r of repos) {
    const p = derivePairs(r);
    fs.writeFileSync(pairsFile(r), `${JSON.stringify(p, null, 2)}\n`);
    console.log(`${r.name}\tcommits=${p.totalCommits}\tcandidates=${p.candidates}\tpairs=${p.pairs.length}`);
  }
}

// ---------- build ----------
const env = home => ({
  HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`,
  XDG_CACHE_HOME: `${home}/.cache`, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('EVAL_'))),
  // A fresh HOME per graph would download the on-device model nine times; point them at one cache.
  ...(process.env.EVAL_MODEL_CACHE ? { ALIGN_MODEL_CACHE: process.env.EVAL_MODEL_CACHE } : {}), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, CI: 'true', NO_COLOR: '1',
});
const alignCli = (home, cwd, ...a) => spawnSync(process.execPath, [path.join(CLI, 'dist/bin.js'), ...a], { cwd, env: env(home), encoding: 'utf8', maxBuffer: 1 << 28 });

/** An unauthenticated GitHub read, cached by url so the 60-requests-an-hour quota is spent once per page ever. */
function cachingFetch() {
  const dir = path.join(WORK, 'prcache');
  fs.mkdirSync(dir, { recursive: true });
  return async (url, init) => {
    const file = path.join(dir, `${createHash('sha256').update(String(url)).digest('hex').slice(0, 24)}.json`);
    if (fs.existsSync(file)) {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      return new Response(c.body, { status: c.status, headers: c.headers });
    }
    const res = await fetch(url, init);
    const body = await res.text();
    if (res.status === 200) fs.writeFileSync(file, JSON.stringify({ status: 200, body, headers: { 'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining') ?? '50' } }));
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

async function buildInProcess(r, home) {
  const lib = f => import(pathToFileURL(path.join(CLI, 'dist/lib', f)).href);
  const { fetchGitItems } = await lib('fetchers/git.js');
  const { GIT_DEFAULT_LIMIT, GIT_KEEP_CAP } = await lib('import-defaults.js');
  const { createLocalGatewayClient } = await lib('local-gateway-client.js');
  const prs = WITH_PRS ? await lib('first-run-pr-import.js') : null;
  const prRead = prs ? prs.fetchFirstRunPrs(`github.com/${r.repo.toLowerCase()}`, { fetchFn: cachingFetch(), detectToken: async () => null, deadlineMs: 120_000 }) : null;
  const t0 = Date.now();
  const prev = process.cwd();
  process.chdir(cloneDir(r));
  let git;
  try { git = await fetchGitItems({ limit: GIT_DEFAULT_LIMIT, keep: GIT_KEEP_CAP }); } finally { process.chdir(prev); }
  const outcome = prRead ? await prRead : null;
  const kept = outcome ? prs.dropCoveredCommits(git.items, outcome) : { items: git.items, covered: 0 };
  const client = createLocalGatewayClient(path.join(home, '.align/local.db'), { cwd: cloneDir(r) });
  await client.ingestBatch(kept.items, { classify: false, keyed: true });
  if (outcome?.items.length) await client.ingestBatch(outcome.items, { classify: false, keyed: true });
  client.close?.();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${r.name}\timport=${secs}s\tcommits=${kept.items.length}\tpr_rows=${outcome?.items.length ?? 0}\tcovered_commits=${kept.covered}\tprs_scanned=${outcome?.scanned ?? 0}${outcome?.note ? `\tnote=${outcome.note}` : ''}`);
}

async function buildAll() {
  for (const r of repos) {
    const home = homeDir(r);
    if (fs.existsSync(path.join(home, '.align/local.db'))) { console.log(`${r.name}\tgraph exists, skipped`); continue; }
    fs.mkdirSync(home, { recursive: true });
    alignCli(home, cloneDir(r), 'local', 'start');
    if (BUILD_IN_PROCESS) { await buildInProcess(r, home); continue; }
    const t0 = Date.now();
    const res = alignCli(home, cloneDir(r), 'connect', 'git', '--approve');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const report = (res.stdout.match(/Git: .*/) ?? ['(no report line)'])[0].trim();
    console.log(`${r.name}\timport=${secs}s\t${(res.stdout.match(/Imported .*/) ?? ['(no import line)'])[0]}\t${report}`);
    if (res.status !== 0) console.log(res.stderr.slice(0, 500));
  }
}

// ---------- run ----------
async function runAll() {
  const mod = await import(pathToFileURL(path.join(CLI, 'dist/lib/local-gateway-client.js')).href);
  for (const style of ['exact', 'loose']) await runStyle(mod, style);
}

async function runStyle(mod, style) {
  const rows = [];
  const perRepo = [];
  for (const r of repos) {
    const dbPath = path.join(homeDir(r), '.align/local.db');
    if (!fs.existsSync(dbPath)) { console.log(`${r.name}: no graph for label ${LABEL}, run build`); continue; }
    const { pairs } = JSON.parse(fs.readFileSync(pairsFile(r), 'utf8'));
    const client = mod.createLocalGatewayClient(dbPath, { cwd: cloneDir(r) });
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    // ALI-1782: a squash commit and its PR are one change. When first run imported the PR instead of the commit, the PR
    // row is the right answer, so a result at /pull/N counts for the commit whose subject ends in (#N).
    const prNumber = subject => /\(#(\d+)\)\s*$/.exec(subject ?? '')?.[1];
    const isAnswer = (url, p) => {
      if (url.includes(`/commit/${p.sha}`)) return true;
      const n = prNumber(p.subject);
      return n !== undefined && new RegExp(`/pull/${n}$`).test(url);
    };
    const inGraph = p => ro.prepare('SELECT 1 FROM decisions WHERE source_url LIKE ?').get(`%/commit/${p.sha}`) !== undefined
      || (prNumber(p.subject) !== undefined && ro.prepare('SELECT 1 FROM decisions WHERE source_url LIKE ?').get(`%/pull/${prNumber(p.subject)}`) !== undefined);
    const stats = { repo: r.name, n: 0, in_graph: 0, r3: 0, r8: 0, rr: 0 };
    const t0 = Date.now();
    for (const p of pairs) {
      const asked = style === 'loose' ? p.loose : p.question;
      if (!asked) continue;
      const res = await client.searchDecisions(asked, RESULT_LIMIT, undefined, { all: true });
      const idx = res.results.findIndex(x => isAnswer(x.source_url ?? '', p));
      const rank = idx === -1 ? null : idx + 1;
      stats.n++;
      const imported = inGraph(p);
      if (imported) stats.in_graph++;
      if (rank !== null && rank <= 3) stats.r3++;
      if (rank !== null && rank <= 8) stats.r8++;
      if (rank !== null) stats.rr += 1 / rank;
      rows.push({ repo: r.name, rank, imported, sha: p.sha.slice(0, 7), question: asked, top: res.results[0] ? res.results[0].title.slice(0, 50) : '-' });
    }
    stats.ms_per_query = Math.round((Date.now() - t0) / Math.max(1, stats.n));
    ro.close();
    perRepo.push(stats);
    client.close?.();
  }
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '-');
  console.log(`\nlabel=${LABEL} style=${style} cli=${CLI}`);
  console.log('repo\tn\tcoverage\trecall@3\trecall@8\tMRR\tms/query\trecall@8 of imported');
  const tot = { n: 0, in_graph: 0, r3: 0, r8: 0, rr: 0 };
  for (const s of perRepo) {
    console.log(`${s.repo}\t${s.n}\t${pct(s.in_graph, s.n)}\t${pct(s.r3, s.n)}\t${pct(s.r8, s.n)}\t${(s.rr / s.n).toFixed(3)}\t${s.ms_per_query}\t${pct(s.r8, s.in_graph)}`);
    for (const k of Object.keys(tot)) tot[k] += s[k];
  }
  console.log(`AGGREGATE\t${tot.n}\t${pct(tot.in_graph, tot.n)}\t${pct(tot.r3, tot.n)}\t${pct(tot.r8, tot.n)}\t${(tot.rr / tot.n).toFixed(3)}\t-\t${pct(tot.r8, tot.in_graph)}`);
  if (args.includes('--table')) {
    console.log('\nrank table (- = not in top 50)');
    for (const x of rows) console.log(`${x.repo}\t${x.rank ?? '-'}\t${x.imported ? 'in' : 'OUT'}\t${x.sha}\t${x.question}\t[top: ${x.top}]`);
  }
  if (opt('out', null)) fs.writeFileSync(opt('out').replace(/\.json$/, `.${style}.json`), `${JSON.stringify({ label: LABEL, perRepo, tot, rows }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (step === 'clone') cloneAll();
  else if (step === 'pairs') pairsAll();
  else if (step === 'build') await buildAll();
  else if (step === 'run') await runAll();
  else if (step === 'all') { cloneAll(); pairsAll(); await buildAll(); await runAll(); }
  else { console.error('usage: retrieval-eval.mjs clone|pairs|build|run|all [--cli root] [--label l] [--work dir] [--repo name] [--prs|--no-prs] [--table] [--out file]'); process.exit(2); }
}
