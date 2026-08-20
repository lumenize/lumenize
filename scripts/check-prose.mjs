#!/usr/bin/env node
// Prose-voice budgets for hand-read documents (ADRs, docs/vision, task files,
// .claude/rules). See .claude/rules/prose-voice.md for what each budget is for
// and where its number came from.
//
//   node scripts/check-prose.mjs [file ...]     # defaults to every governed file
//   npm run audit:prose
//
// Exits non-zero if any GATE is exceeded. REPORT-only metrics never fail the
// run; they are printed so a drift shows up before it needs a gate.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()

// Bare abstract nouns used as the subject of a sentence — the single metric that
// separated the hand-reviewed documents from the rest by more than 5x.
const ABSTRACT_SUBJECTS =
  /\b(?:the|its|that|this)\s+(reflex|shape|class|mechanism|property|invariant|asymmetry|inversion|framing|altitude|surface|posture|primitive|substrate|tell|move)\b/gi

const GOVERNED = [
  { dir: 'docs/adr', kind: 'adr', maxBytes: 13_000 },
  { dir: 'docs/vision', kind: 'vision', maxBytes: 60_000 },
  { dir: 'tasks', kind: 'task', maxBytes: null, skip: /\/(archive|icebox|nightly)\// },
  { dir: '.claude/rules', kind: 'rule', maxBytes: null },
  { dir: '.claude/skills', kind: 'rule', maxBytes: null },
]

// Budgets are per GENRE, because the hand-written documents differ by genre and the
// difference is real: a task file is a cold-start spec and packs decision, rationale and
// citation into one sentence, where a vision doc leads a reader. Every number is set at
// what the hand-written reference for THAT genre measures.
//   adr/vision  → docs/vision/auth.md, docs/adr/015-passage-and-dominion.md
//   task/rule   → tasks/archive/nebula-invite.md § Context..Constraints (Larry, by hand)
const BY_KIND = {
  adr:    { maxBulletWords: 150, avgSentenceWords: 22 },
  vision: { maxBulletWords: 150, avgSentenceWords: 22 },
  task:   { maxBulletWords: 185, avgSentenceWords: 27 },
  rule:   { maxBulletWords: 185, avgSentenceWords: 27 },
  prose:  { maxBulletWords: 185, avgSentenceWords: 27 },
}

const LABEL = { adr: 'an ADR', vision: 'a vision doc', task: 'a task file', rule: 'a rule', prose: 'prose' }

const GATES = {
  // ⚠️ density is deliberately NOT gated — see prose-voice.md § *The moves that make the
  // difference*. It is the one budget whose cheapest satisfying edit makes a document
  // worse (delete a true warning to hit a number), and a file whose subject is traps
  // SHOULD carry many. The count is still reported, as data rather than as a gate.
  // Rate alone is unstable on a short file — two fair uses in 6KB reads as 0.32.
  // Both conditions must hold: enough of them to be a habit, dense enough to bite.
  abstractPerKb: 0.30,   // target 0.15 — ADR-015 sits at 0.09, ADR-019 at 0.87
  abstractMinCount: 4,
}

function stripCode(t) {
  return t.replace(/```[\s\S]*?```/g, '').replace(/^---\n[\s\S]*?\n---\n/, '')
}

// Warnings are counted everywhere EXCEPT inside a table row: a table cell naming
// the glyph is documentation of the metric, not a warning being spent.
const countWarn = (t) =>
  t.split('\n')
    .filter((l) => !l.trim().startsWith('|'))
    .reduce((n, l) => n + (l.match(/⚠️/g) || []).length, 0)

// Date / Status / Deciders / Evidence are header FIELDS, not prose. They are
// excluded from every prose metric and reported separately, so a legitimately
// long Status line does not spend a document's warning budget.
const HEADER_FIELD = /^\*\*(?:Date|Status|Deciders|Evidence)\*\*:/
function splitHeader(t) {
  const lines = t.split('\n')
  const header = []
  const body = []
  let inField = false
  for (const l of lines) {
    if (HEADER_FIELD.test(l)) { inField = true; header.push(l); continue }
    if (inField && l.trim() && !/^#/.test(l)) { header.push(l); continue }
    inField = false
    body.push(l)
  }
  return { header: header.join('\n'), body: body.join('\n') }
}

function sentences(t) {
  const body = stripCode(t)
    .split('\n')
    .filter((l) => !l.trim().startsWith('|'))
    .join('\n')
    .replace(/[*`_>#[\]]/g, '')
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().split(/\s+/).length)
    .filter((n) => n > 3)
}

function bullets(t) {
  const out = []
  let cur = null
  for (const line of stripCode(t).split('\n')) {
    if (/^\s*(?:[-*]\s|\d+\.\s)/.test(line)) {
      if (cur) out.push(cur)
      cur = line
    } else if (cur && line.trim() && !/^\s*(?:[#|]|>)/.test(line)) {
      cur += ' ' + line
    } else {
      if (cur) out.push(cur)
      cur = null
    }
  }
  if (cur) out.push(cur)
  return out.map((b) => b.trim().split(/\s+/).length)
}

function paragraphs(t) {
  return stripCode(t)
    .split(/\n\s*\n/)
    .filter((p) => p.trim() && !/^\s*(?:[|#]|---|\*\*(?:Date|Status|Deciders|Evidence))/.test(p))
    .map((p) => p.trim().split(/\s+/).length)
}

function sections(t) {
  const parts = []
  let head = '(preamble)'
  let buf = []
  for (const line of t.split('\n')) {
    if (/^#{2,4}\s/.test(line)) {
      parts.push({ head, body: buf.join('\n') })
      head = line.replace(/^#+\s*/, '').trim()
      buf = []
    } else buf.push(line)
  }
  parts.push({ head, body: buf.join('\n') })
  return parts
}

// Six-word shingles shared between a later section and an earlier one — the
// backward restatement that costs a reader the most (a forward-looking summary
// is fine and is not what this catches, because it looks ahead, not behind).
// A phase's reader is the implementer transcribing it at /build-task, not Larry — he
// reads only the Pass-1 sections. So a Pass-1 point reappearing in a phase is the
// cross-file case, not the backward one, and the test to apply there is different:
// the phase keeps the INSTRUCTION, the rationale stays upstream. See
// .claude/rules/prose-voice.md § *Duplication — the reader decides it*.
const isPhaseHead = (head) => /^phase\s*\d/i.test(head)

function backwardRestatements(t) {
  const secs = sections(stripCode(t)).filter((s) => s.body.trim())
  const seen = new Map()
  const hits = []
  const shingle = (body) => {
    const w = body
      .replace(/\]\([^)]*\)/g, ' ')          // markdown link targets
      .replace(/https?:\/\/\S+/g, ' ')       // bare URLs
      .replace(/`[^`]*`/g, ' ')              // inline code / symbol names
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((x) => x.length > 2)
    const out = []
    for (let i = 0; i + 6 <= w.length; i++) out.push(w.slice(i, i + 6).join(' '))
    return out
  }
  for (const s of secs) {
    for (const sh of shingle(s.body)) {
      if (seen.has(sh) && seen.get(sh) !== s.head) {
        hits.push({ from: seen.get(sh), to: s.head, text: sh, toPhase: isPhaseHead(s.head) })
      } else if (!seen.has(sh)) seen.set(sh, s.head)
    }
  }
  const uniq = []
  const key = new Set()
  for (const h of hits) {
    const k = `${h.from}->${h.to}`
    if (key.has(k)) continue
    key.add(k)
    uniq.push(h)
  }
  return uniq
}

function analyze(path, kind, maxBytes) {
  const raw = readFileSync(path, 'utf8')
  const { header, body: t } = splitHeader(raw)
  const kb = t.length / 1000
  const sent = sentences(t)
  const bul = bullets(t)
  const par = paragraphs(t).sort((a, b) => a - b)
  const warnTotal = countWarn(t)
  const abstract = (t.match(ABSTRACT_SUBJECTS) || []).length

  const failures = []
  const push = (cond, msg) => cond && failures.push(msg)

  const k = BY_KIND[kind] ?? BY_KIND.prose
  const over = bul.filter((n) => n > k.maxBulletWords)
  push(
    over.length > 0,
    `${over.length} bullet(s) over ${k.maxBulletWords} words for ${LABEL[kind] ?? kind} (longest ${Math.max(...bul, 0)})`,
  )
  const avg = sent.length ? sent.reduce((a, b) => a + b, 0) / sent.length : 0
  push(avg > k.avgSentenceWords, `avg sentence ${avg.toFixed(1)}w (budget ${k.avgSentenceWords} for ${LABEL[kind] ?? kind})`)
  const abstractRate = abstract / kb
  push(
    abstract >= GATES.abstractMinCount && abstractRate > GATES.abstractPerKb,
    `${abstract} bare-abstract-noun subjects, ${abstractRate.toFixed(2)}/KB (budget ${GATES.abstractPerKb}/KB, target 0.15)`,
  )
  push(maxBytes && raw.length > maxBytes, `${(t.length / 1000).toFixed(1)}KB (budget ${maxBytes / 1000}KB)`)
  if (kind === 'adr') {
    const dated = raw.match(/(?:✅|❌).{0,80}\b(?:as of|conformant|shipped|built)\b.{0,20}\d{4}-\d{2}-\d{2}/gi)
    push(dated, `dated build status in an ADR body: "${dated?.[0]?.slice(0, 60)}…" — belongs in the task file`)
  }

  return {
    path: relative(ROOT, path),
    kind,
    kb,
    warnTotal,
    avg,
    medianPara: par[Math.floor(par.length / 2)] || 0,
    maxBullet: Math.max(...bul, 0),
    abstractRate,
    restated: backwardRestatements(t),
    headerWords: header.trim() ? header.trim().split(/\s+/).length : 0,
    softBullets: bul.filter((n) => n > 100).length,
    failures,
  }
}

function walk(dir, skip) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p, skip))
    else if (extname(p) === '.md' && !(skip && skip.test('/' + relative(ROOT, p)))) out.push(p)
  }
  return out
}

const argv = process.argv.slice(2)

// --regression <file> : compare the working copy against HEAD and fail ONLY where this
// edit made things worse. 50 of 97 governed files predate this check; a hook that fired
// on legacy debt would be switched off within a day, which is the failure this whole
// rule is about.
if (argv[0] === '--regression') {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const file = argv[1]
  const rel = relative(ROOT, file)
  const g = GOVERNED.find((x) => rel.startsWith(x.dir))
  if (!g || (g.skip && g.skip.test('/' + rel))) process.exit(0)

  let before = null
  try {
    const head = execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const dir = mkdtempSync(join(tmpdir(), 'prose-'))
    const tmp = join(dir, 'head.md')
    writeFileSync(tmp, head)
    before = analyze(tmp, g.kind, g.maxBytes)
  } catch {
    before = null // new file — every gate applies
  }

  const after = analyze(file, g.kind, g.maxBytes)
  if (!after.failures.length) process.exit(0)

  const num = (msg) => { const m = msg.match(/[\d.]+/); return m ? parseFloat(m[0]) : Infinity }
  const worse = after.failures.filter((f) => {
    if (!before) return true
    const prior = before.failures.find((b) => b.split('(')[0].replace(/[\d.]+/g, '') === f.split('(')[0].replace(/[\d.]+/g, ''))
    if (!prior) return true          // this gate was passing before your edit
    return num(f) > num(prior)       // it was failing, and you made it worse
  })
  if (!worse.length) process.exit(0)

  console.error(`\nProse voice — ${rel} (see .claude/rules/prose-voice.md)\n`)
  for (const w of worse) console.error(`  · ${w}`)
  console.error(
    before
      ? '\nThese got worse in this edit. Pre-existing budget breaches are not your problem; these are.\n'
      : '\nNew file — every budget applies.\n',
  )
  process.exit(2)
}
let targets
if (argv.length) {
  targets = argv.map((a) => {
    const rel = relative(ROOT, a)
    const g = GOVERNED.find((x) => rel.startsWith(x.dir))
    return { path: a, kind: g?.kind ?? 'prose', maxBytes: g?.maxBytes ?? null }
  })
} else {
  targets = GOVERNED.flatMap((g) => {
    let files = []
    try { files = walk(join(ROOT, g.dir), g.skip) } catch { return [] }
    return files.map((p) => ({ path: p, kind: g.kind, maxBytes: g.maxBytes }))
  })
}

const results = targets.map((t) => analyze(t.path, t.kind, t.maxBytes))
const failing = results.filter((r) => r.failures.length)

const head = ['file', 'KB', '⚠️', 'avgSent', 'medPara', 'maxBul', 'abs/KB']
const rows = results.map((r) => [
  r.path, r.kb.toFixed(1), String(r.warnTotal), r.avg.toFixed(1),
  String(r.medianPara), String(r.maxBullet), r.abstractRate.toFixed(2),
])
const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)))
const line = (c) => c.map((x, i) => (i ? x.padStart(w[i]) : x.padEnd(w[i]))).join('  ')
console.log(line(head))
console.log(w.map((n) => '-'.repeat(n)).join('  '))
for (const r of rows) console.log(line(r))

if (failing.length) {
  console.log('\nOVER BUDGET — see .claude/rules/prose-voice.md\n')
  for (const r of failing) {
    console.log(`  ${r.path}`)
    for (const f of r.failures) console.log(`    · ${f}`)
  }
}

const restating = results.filter((r) => r.restated.length)
if (restating.length) {
  console.log('\nBackward restatement (report only — a forward summary is fine, a backward one is not):\n')
  let anyPhase = false
  for (const r of restating) {
    console.log(`  ${r.path}`)
    for (const h of r.restated.slice(0, 4)) {
      if (h.toPhase) anyPhase = true
      console.log(`    · § ${h.from}  →  § ${h.to}${h.toPhase ? '  [phase]' : ''}   "${h.text}"`)
    }
  }
  if (anyPhase) {
    console.log(
      '\n  [phase] = the target is a phase, whose reader is the implementer rather than Larry.\n' +
      '  Repeating the INSTRUCTION there is licensed — a phase must be transcribable without\n' +
      '  scrolling up. Repeating the RATIONALE is the defect: cite the section by name instead.',
    )
  }
}

console.log(
  failing.length
    ? `\n${failing.length} of ${results.length} file(s) over budget.`
    : `\nAll ${results.length} file(s) within budget.`,
)
process.exit(failing.length ? 1 : 0)
