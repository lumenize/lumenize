#!/usr/bin/env node
/**
 * `npm run audit:act-readers` — every place our code reads a token's or a record's `act`.
 *
 * `act` says who acted for the subject. It is recorded and shown, and it never decides what a call
 * may do: who may act as whom is settled once, at the impersonation mint (ADR-016 § *`act` is
 * recorded, and never decides what a call may do*, `.claude/rules/security.md` § *Delegation*). A
 * check that reads `act` to allow or refuse something has been proposed and built more than once,
 * so this fails on any reader it has not been told about.
 *
 * It parses the source and finds every READ of a property named `act`: `x.act`, `x?.act`,
 * `x['act']` and `const { act } = x`. A comment or an object literal's `act:` key reads nothing and
 * is not counted. Each reader is named by its file and the function it sits in, and must be in
 * `ALLOWED` below.
 *
 * ⚠️ When this fails on a reader you just wrote, decide which it is before touching the list:
 *   - it RECORDS or DISPLAYS who acted, or it is the mint's own gate or the client's mirror of
 *     that gate: add it to `ALLOWED` with its kind and a line saying what it does with `act`. This
 *     list is the only one: `security.md` § *Delegation* defines the kinds and names no reader;
 *   - it decides what a call may do: that is the defect. Decide from the subject's own claims.
 * It also fails on an `ALLOWED` entry that no longer reads `act`, so the list stays what is true.
 *
 * Pass directories to scan them in place of the defaults, which is how the check itself is tested.
 * CI runs it after the tests. It prints what it found on every run, so an empty failure list is
 * never the only output.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_TREES = ['packages/mesh/src', 'packages/resources/src', 'apps/nebula/src'];

/** Generated files, which hold other code as text. */
const SKIPPED_FILES = new Set(['apps/nebula/src/validator-seeds.ts', 'apps/nebula/src/platform-embed.ts']);

/**
 * Every reader of `act`, by file and enclosing function.
 *   record: builds or walks a record of who acted, for attribution or display.
 *   mint:   the impersonation mint's own gate, which decides what to issue.
 *   client: a client's mirror of the mint's gate, or its choice of how to tear itself down.
 */
const ALLOWED = [
  { file: 'packages/mesh/src/auth/access-claims.ts', fn: 'toRecordedClaims', kind: 'record', why: 'the one projection every record goes through' },
  { file: 'packages/mesh/src/lmz-api.ts', fn: 'actForRecord', kind: 'record', why: '`lmz.actFor`: nests a stored record\'s chain beneath the node\'s agent principal' },
  { file: 'packages/resources/src/snapshots.ts', fn: 'toWireRecordedClaims', kind: 'record', why: 'copies a stored record\'s chain onto the wire' },
  { file: 'packages/resources/src/snapshots.ts', fn: 'identityKey', kind: 'record', why: 'compares two records\' chains to tell a caller its own repeat' },
  { file: 'apps/nebula/src/participants.ts', fn: 'deriveParticipants', kind: 'record', why: 'walks a stored record\'s chain for a byline' },
  { file: 'apps/nebula/src/galaxy.ts', fn: 'commitIdentities', kind: 'record', why: 'names the agent as a commit\'s committer when the agent is the outermost actor' },
  { file: 'apps/nebula/src/galaxy.ts', fn: 'wireClaims', kind: 'record', why: 'sends a client who a call was for and who acted, for display' },
  { file: 'packages/mesh/src/auth/worker-token.ts', fn: 'mintImpersonationToken', kind: 'mint', why: 'only a root identity may open an impersonation' },
  { file: 'packages/mesh/src/impersonation.ts', fn: 'assertCanImpersonate', kind: 'client', why: 'mirrors the mint\'s gate so the refusal reads accurately' },
  { file: 'packages/mesh/src/mesh-client.ts', fn: 'logout', kind: 'client', why: 'a token minted for someone else\'s session ends by teardown' },
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
}

/** The name of the nearest function, method or accessor around `node`, or `(top level)`. */
function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
      if (n.name) return n.name.getText();
    }
    if (ts.isConstructorDeclaration(n)) return 'constructor';
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent;
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return p.name.getText();
    }
  }
  return '(top level)';
}

function readersIn(file) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('act')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const note = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push({ fn: enclosingName(node), line: line + 1, text: text.split('\n')[line].trim() });
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'act') note(node);
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'act') note(node);
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && (node.propertyName ?? node.name).getText() === 'act') note(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const trees = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TREES.map((t) => join(ROOT, t));
const files = [];
for (const t of trees) walk(t, files);

const unknown = [];
const seen = new Set();
let readers = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  if (SKIPPED_FILES.has(rel)) continue;
  for (const r of readersIn(file)) {
    readers += 1;
    const entry = ALLOWED.find((a) => a.file === rel && a.fn === r.fn);
    if (entry) { seen.add(entry); console.log(`  ${entry.kind.padEnd(6)} ${rel}:${r.line}  ${r.fn}`); }
    else unknown.push({ rel, ...r });
  }
}
const stale = ALLOWED.filter((a) => !seen.has(a));

console.log(`\n${files.length} file(s) scanned, ${readers} read(s) of \`act\`, ${ALLOWED.length} reader(s) allowed.`);
for (const u of unknown) {
  console.error(`\n✗ ${u.rel}:${u.line}  in ${u.fn}\n    ${u.text}\n    This reads \`act\` and is not on the list. If it records or displays who acted, or is the mint's\n    own gate, add it to ALLOWED in scripts/audit-act-readers.mjs, with its kind.\n    If it decides what a call may do, that is the defect: decide from the subject's own claims (ADR-016).`);
}
for (const s of stale) {
  console.error(`\n✗ ALLOWED lists ${s.file} ${s.fn}, which no longer reads \`act\`. Remove the entry.`);
}
process.exit(unknown.length || stale.length ? 1 : 0);
