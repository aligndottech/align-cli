#!/usr/bin/env node
// Prints the shell text of every `run:` step in .github/workflows, optionally restricted to
// the steps a PULL REQUEST actually executes. Used by scripts/check-test-runners.sh.
//
// Usage: workflow-run-steps.mjs <repo-root> <all|pr>
//
// WHY THIS IS A PARSE AND NOT A GREP. This started as an awk line scanner, and a review of
// #290 found five separate false results in it - three false greens and two false failures.
// All five were one fact: YAML nests, and a line scanner cannot see nesting. It read
// `branches: [pull_request]` as a trigger, `with: { run: ... }` as a shell step, and
// `!= 'pull_request_target'` as excluding pull_request. Patching a sixth case would have left
// a seventh (verification.md, "a parser beats a regex the moment nesting is involved").
//
// js-yaml is a DECLARED devDependency of this repo and `npm ci` runs before the guard in the
// test job, so it is present wherever this runs. It is also the right parser rather than an
// available one: PyYAML is YAML 1.1, where the bare key `on:` parses as the BOOLEAN true, so
// `doc['on']` is undefined and every workflow reads as having no triggers. js-yaml keeps it a
// string in all three spellings (`on:`, `'on':`, `"on":`).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let yaml
try {
  yaml = require('js-yaml')
} catch {
  // Never fall through to a partial answer. A guard that cannot parse must not report a clean
  // tree - that is the failure it exists to prevent, pointed at itself.
  console.error('FATAL: js-yaml is not installed. Run `npm ci` before the shell-suite guards.')
  process.exit(1)
}

const [root = '.', mode = 'all'] = process.argv.slice(2)
if (mode !== 'all' && mode !== 'pr') {
  console.error(`FATAL: mode must be "all" or "pr", got "${mode}"`)
  process.exit(1)
}

const EVENT = 'pull_request'

// --- GitHub expression evaluation, three-valued -------------------------------------------
//
// The question is never "what does this `if:` mean" in general - it is only "can this be true
// when github.event_name is 'pull_request'". Everything else in the expression is an unknown,
// and unknowns propagate by Kleene logic: `unknown && false` is false, `unknown || true` is
// true, and only the cases that genuinely depend on the unknown stay unknown.
//
// That matters for correctness in both directions. `needs.x.ok == 'true' && event_name !=
// 'pull_request'` is FALSE on a pull request whatever needs.x.ok is, so the step is excluded;
// and `matrix.leg == '1' || event_name == 'pull_request'` is TRUE, so it is not.
const and3 = (a, b) => (a === false || b === false ? false : a === true && b === true ? true : null)
const or3 = (a, b) => (a === true || b === true ? true : a === false && b === false ? false : null)
const not3 = (a) => (a === null ? null : !a)

// Replace every comparison of github.event_name against a literal with the answer it has when
// the event IS a pull request. Both operand orders, both quote styles. Note this is what makes
// `!= 'pull_request_target'` come out TRUE rather than being substring-matched as an exclusion.
function substituteEventComparisons(s) {
  const ev = String.raw`github\s*\.\s*event_name`
  const lit = String.raw`'([^']*)'|"([^"]*)"`
  const answer = (op, v) => ((op === '==' ? v === EVENT : v !== EVENT) ? 'true' : 'false')
  return s
    .replace(new RegExp(`${ev}\\s*(==|!=)\\s*(?:${lit})`, 'g'), (_m, op, a, b) => answer(op, a ?? b))
    .replace(new RegExp(`(?:${lit})\\s*(==|!=)\\s*${ev}`, 'g'), (_m, a, b, op) => answer(op, a ?? b))
}

// Grammar: OR := AND ('||' AND)* ; AND := UNARY ('&&' UNARY)* ; UNARY := '!' UNARY | PRIM
//          PRIM := '(' OR ')' | ATOM
// An ATOM is any run of text up to an unquoted, unnested `&&`, `||` or closing `)`. That is
// what lets a function call such as contains(a, b) be consumed whole rather than mistaken for
// a parenthesised group: a call begins with its identifier, so PRIM never sees the `(` first.
function evaluate(src) {
  let i = 0
  const s = src
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }

  function atom() {
    const start = i
    let depth = 0
    let quote = null
    while (i < s.length) {
      const c = s[i]
      if (quote) { if (c === quote) quote = null; i++; continue }
      if (c === "'" || c === '"') { quote = c; i++; continue }
      if (c === '(') { depth++; i++; continue }
      if (c === ')') { if (depth === 0) break; depth--; i++; continue }
      if (depth === 0 && (s.startsWith('&&', i) || s.startsWith('||', i))) break
      i++
    }
    const text = s.slice(start, i).trim()
    if (text === '') throw new Error('empty operand')
    if (text === 'true') return true
    if (text === 'false') return false
    return null // something we cannot evaluate, and do not need to
  }

  function prim() {
    ws()
    if (s[i] === '(') {
      i++
      const v = or()
      ws()
      if (s[i] !== ')') throw new Error('unbalanced parenthesis')
      i++
      return v
    }
    return atom()
  }
  function unary() { ws(); if (s[i] === '!' && s[i + 1] !== '=') { i++; return not3(unary()) } return prim() }
  function and() { let v = unary(); for (;;) { ws(); if (!s.startsWith('&&', i)) return v; i += 2; v = and3(v, unary()) } }
  function or() { let v = and(); for (;;) { ws(); if (!s.startsWith('||', i)) return v; i += 2; v = or3(v, and()) } }

  const v = or()
  ws()
  if (i !== s.length) throw new Error('trailing input')
  return v
}

// true = a pull request runs this, false = it does not, null = undecidable.
function reachableOnPullRequest(cond) {
  if (cond === undefined || cond === null || cond === '') return true
  const stripped = String(cond).replace(/\$\{\{([\s\S]*?)\}\}/g, '$1').trim()
  if (stripped === '') return true
  // A condition that never mentions the event cannot be about PR reachability. Matrix legs and
  // job outputs gate plenty of steps and say nothing about which events reach them.
  if (!/github\s*\.\s*event_name/.test(stripped)) return true
  try {
    return evaluate(substituteEventComparisons(stripped))
  } catch {
    return null
  }
}

function triggersPullRequest(doc) {
  const on = doc?.on
  if (on === undefined || on === null) return false
  // ONLY the direct children of `on:` are events. A `pull_request` appearing as a branch name,
  // a path filter or any other nested value is not a trigger - crediting one was the false
  // green that let a runner in a push-only workflow pass.
  const names =
    typeof on === 'string' ? [on]
      : Array.isArray(on) ? on.filter((x) => typeof x === 'string')
        : typeof on === 'object' ? Object.keys(on)
          : []
  return names.includes('pull_request') || names.includes('pull_request_target')
}

const dir = join(root, '.github', 'workflows')
if (!existsSync(dir)) process.exit(0)

const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
const out = []

for (const file of files) {
  const path = join(dir, file)
  let doc
  try {
    doc = yaml.load(readFileSync(path, 'utf8'))
  } catch (err) {
    // Name the file. A silent parse failure makes every suite read as unrun, which is red for
    // the wrong reason and sends the next person to debug the tree instead of the workflow.
    console.error(`FATAL: could not parse ${path}: ${err.message.split('\n')[0]}`)
    process.exit(1)
  }
  if (!doc || typeof doc !== 'object') continue

  const wantPr = mode === 'pr'
  if (wantPr && !triggersPullRequest(doc)) continue

  for (const job of Object.values(doc.jobs ?? {})) {
    if (!job || typeof job !== 'object') continue
    // An undecidable condition counts as NOT reached. A false red names a step and is fixed by
    // making the condition explicit; a false green silently vouches for a suite nothing runs.
    if (wantPr && reachableOnPullRequest(job.if) !== true) continue
    for (const step of job.steps ?? []) {
      if (!step || typeof step !== 'object') continue
      // `run` as the STEP's own key. `with: { run: ... }` is input data to an action and
      // nothing executes it.
      if (typeof step.run !== 'string') continue
      if (wantPr && reachableOnPullRequest(step.if) !== true) continue
      out.push(step.run)
    }
  }
}

if (out.length > 0) process.stdout.write(out.join('\n') + '\n')
