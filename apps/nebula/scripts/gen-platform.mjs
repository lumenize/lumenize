// Generates src/platform-embed.ts — the PLATFORM LAYER of the guidance tree, embedded in
// the Worker bundle so a deploy ships it atomically and nothing else holds a copy
// (tasks/nebula-guidance-file-tree.md § Storage is files in git; ADR-010's one authoritative
// copy). Two sources, one embed:
//   - apps/nebula/platform/   → `.platform/AGENTS.md`, `.platform/skills/<name>/SKILL.md`
//   - website/docs/nebula/*.md → `.platform/docs/<file>.md`  (shipped AS-IS — they are already
//                                 the LLM-facing set; no second edition to maintain)
// The always-on skills CATALOG is rendered from each SKILL.md's frontmatter into the one
// marker line `platform/AGENTS.md` carries, so a stale description cannot ship. Run
// `node scripts/gen-platform.mjs` after editing either source; the OUTPUT IS COMMITTED. A
// one-shot generator, not a build step — nothing in the dev loop runs it (no-build-in-dev);
// `wrangler dev` picks the committed embed up like any source file.
//
// Two drift gates, as the scaffold's: `--check` (wired into the package `test` script) needs
// the DISK — byte drift, the link/bare-path check, the frontmatter — and exits non-zero on any;
// test/platform-embed-drift.test.ts asserts what can be asserted from PLATFORM_FILES alone
// (a workerd isolate has no filesystem).
// (Pattern: scripts/gen-scaffold.mjs.)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platformRoot = join(here, '..', 'platform');
const docsRoot = join(here, '..', '..', '..', 'website', 'docs', 'nebula');
const target = join(here, '..', 'src', 'platform-embed.ts');

/** The marker line in platform/AGENTS.md the rendered catalog replaces. */
export const CATALOG_MARKER_PREFIX = '<!-- SKILLS CATALOG';

/** Every `.platform/…` path mentioned in a file — a link target or a bare path. Ends on a
 *  path character, so a sentence's trailing period or a closing backtick is not swallowed;
 *  a `#anchor` is stripped, because the read tool is path-grained. */
const PLATFORM_PATH_RE = /\.platform\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-/]/g;

const fail = (msg) => { console.error(`gen-platform: ${msg}`); process.exit(1); };

/** Walk a directory, sorted. The platform tree is hand-shaped markdown, so only `.md` files
 *  are embedded and dot-entries are skipped: a Finder-created `.DS_Store` would otherwise red
 *  `--check` and, on the next regenerate, ship as the key `.platform/.DS_Store`. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Parse the three-line frontmatter a SKILL.md opens with — `name` and `description` only. */
function parseFrontmatter(text, path) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) fail(`${path}: no frontmatter block`);
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
    // A YAML plain-scalar continuation (an indented line after `description: foo`) folds into
    // the value for a YAML reader and vanishes here — both gates green on a truncated line.
    else if (line.trim()) fail(`${path}: frontmatter line is not \`key: value\` — ${JSON.stringify(line)}`);
  }
  if (!fields.name) fail(`${path}: frontmatter has no \`name\``);
  if (!fields.description) fail(`${path}: frontmatter has no \`description\` — the catalog line is generated from it`);
  // A YAML block scalar (`description: >` or `|` with an indented paragraph) would ship the
  // catalog line as `- name — > (…)` with both drift gates green, since they parse alike.
  // The catalog is one line per skill by design, so the description MUST be one line.
  if (/^[>|]/.test(fields.description)) fail(`${path}: \`description\` must be a single line (no YAML block scalar) — the catalog renders it verbatim`);
  return fields;
}

/** One catalog line — the shape test/platform-embed-drift.test.ts parses back. */
export function catalogLine(name, description, location) {
  return `- ${name} — ${description} (${location})`;
}

// ── Collect ──────────────────────────────────────────────────────────────────

/** @type {Record<string, string>} keyed by the `.platform/…` path the read tool resolves */
const files = {};
for (const full of walk(platformRoot)) {
  const rel = relative(platformRoot, full).split('\\').join('/');
  files[`.platform/${rel}`] = readFileSync(full, 'utf8');
}
for (const entry of readdirSync(docsRoot).sort()) {
  if (!entry.endsWith('.md')) continue;
  files[`.platform/docs/${entry}`] = readFileSync(join(docsRoot, entry), 'utf8');
}

// ── The catalog, from frontmatter ────────────────────────────────────────────

const skillPaths = Object.keys(files).filter((p) => /^\.platform\/skills\/[^/]+\/SKILL\.md$/.test(p)).sort();
if (skillPaths.length === 0) fail('no skills found under platform/skills/');
const catalog = skillPaths.map((p) => {
  const dir = p.split('/')[2];
  const fm = parseFrontmatter(files[p], p);
  if (fm.name !== dir) fail(`${p}: frontmatter name \`${fm.name}\` must equal its directory \`${dir}\``);
  return catalogLine(fm.name, fm.description, p);
});

const agentsKey = '.platform/AGENTS.md';
if (!files[agentsKey]) fail('platform/AGENTS.md is missing');
const agentsLines = files[agentsKey].split('\n');
const markerAt = agentsLines.findIndex((l) => l.startsWith(CATALOG_MARKER_PREFIX));
if (markerAt < 0) fail(`platform/AGENTS.md has no catalog marker line (starts with \`${CATALOG_MARKER_PREFIX}\`)`);
if (agentsLines.filter((l) => l.startsWith(CATALOG_MARKER_PREFIX)).length > 1) fail('platform/AGENTS.md has more than one catalog marker');
agentsLines.splice(markerAt, 1, ...catalog);
files[agentsKey] = agentsLines.join('\n');

// ── The link / bare-path check ───────────────────────────────────────────────
// Every `.platform/…` path any embedded file names must resolve: a file that is a key, or a
// directory some key sits under. The docs' OUTBOUND links (other site sections, GitHub) are
// out of scope by decision — only `.platform/` references are ours to keep true.

const keys = new Set(Object.keys(files));
const resolves = (p) => keys.has(p) || (p.endsWith('/') && [...keys].some((k) => k.startsWith(p)));
const dangling = [];
for (const [key, text] of Object.entries(files)) {
  for (const hit of text.match(PLATFORM_PATH_RE) ?? []) {
    const path = hit.replace(/#.*$/, '');
    if (!resolves(path)) dangling.push(`${key} → ${path}`);
  }
}
if (dangling.length > 0) fail(`dangling .platform/ reference(s):\n  ${dangling.join('\n  ')}`);

// ── Emit ─────────────────────────────────────────────────────────────────────

const entries = Object.keys(files).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(files[k])},`);
const out = `// GENERATED by scripts/gen-platform.mjs — do not hand-edit. The platform layer of the
// guidance tree (apps/nebula/platform/ + website/docs/nebula/*.md), keyed by the
// \`.platform/…\` path the read tool resolves, with the skills catalog rendered into
// AGENTS.md from each SKILL.md's frontmatter. Re-run the generator after editing either
// source; \`--check\` in the package \`test\` script reds on drift, and
// test/platform-embed-drift.test.ts asserts the catalog and every \`.platform/\` reference
// from this embed alone.
export const PLATFORM_FILES: Record<string, string> = {
${entries.join('\n')}
};

/** The always-on platform layer — the system bundle every turn carries. */
export const PLATFORM_AGENTS_MD: string = PLATFORM_FILES[${JSON.stringify(agentsKey)}]!;
`;

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    fail('src/platform-embed.ts is MISSING — run `node scripts/gen-platform.mjs` and commit it');
  }
  if (current !== out) {
    fail('platform-embed DRIFT: platform/ or website/docs/nebula/ changed — run `node scripts/gen-platform.mjs` and commit src/platform-embed.ts');
  }
  console.log(`platform-embed in sync (${Object.keys(files).length} files, ${catalog.length} skills)`);
} else {
  writeFileSync(target, out);
  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0);
  console.log(`wrote src/platform-embed.ts — ${Object.keys(files).length} files, ${catalog.length} skills, ${kb} KiB`);
}
