#!/usr/bin/env node
/**
 * `npm run audit:test-assertions` — fail on a test that asserts nothing.
 *
 * A test with no assertion passes whatever the code under it does, so it can only fail by
 * crashing. `.claude/rules/testing.md` § *Tests must be capable of failing* carries the rule; this
 * is its proof. The case that prompted it (2026-10-04): four tests in
 * `packages/routing/test/unit/route-do-request.test.ts`, each named for a CORS or error-handling
 * behaviour, each calling `routeDORequest` and ending in a comment saying the behaviour was
 * verified elsewhere. They had been green since they were written, and the only tool that noticed
 * was SonarCloud, under some 1,200 style findings nobody read. This check replaced it.
 *
 * ## What counts as an assertion
 *
 * Anything reachable from the test body that fails the test on a wrong answer:
 *
 * 1. A call rooted at `expect`, `assert`, `expectTypeOf` or `assertType` — `expect(x).toBe(y)`,
 *    `expect.poll(…)`, `assert.equal(…)`, `expect.assertions(1)`.
 * 2. A call to anything imported from `node:assert` / `assert` / `node:assert/strict`, under
 *    whatever local name it was given.
 * 3. A `throw` statement — `if (!ok) throw new Error(…)` inside a `vi.waitFor` is an assertion.
 * 4. A call to a helper whose own body reaches one of the above. Helpers are followed when they are
 *    declared in the same file, or imported by a relative path from a file under a `test` or
 *    `harness` directory, through re-exports. Never into `src/`: a `throw` in the code under test
 *    is that code's error path, not an assertion.
 *    A call through a registry — `behaviorTests[name](client)`, where `behaviorTests` is an object
 *    of functions — counts only when every entry it could dispatch to asserts.
 * 5. A call to a helper this script cannot open (a package import, a method on an object) whose
 *    name starts `assert`, `expect` or `verify` followed by a capital — `assertRefused(…)`,
 *    `client.expectClosed()`. That is a naming convention, so a helper named that way MUST assert.
 *
 * Nested functions count: an `expect` inside a `vi.waitFor` callback is an assertion of the test
 * that passed the callback.
 *
 * ## What is skipped
 *
 * `it.skip` / `it.todo`, everything under `describe.skip` / `describe.todo`, and a test with no
 * body, which vitest treats as todo — a deferral is
 * `testing.md` § *Deferring ≠ deleting*, and its assertions are kept but not run. `it.skipIf` and
 * `it.runIf` are checked, because the test does run on one side of the condition.
 *
 * ## Opting out
 *
 * A test whose whole claim is "this does not throw" does fail when it throws. Prefer saying so in
 * the assertion — `expect(() => f()).not.toThrow()`, `await expect(p).resolves.toBeUndefined()` —
 * because then the claim is visible. Where that reads worse, state it on or above the test:
 *
 *     // test-assertions: <what failure this test catches without an assertion>
 *
 * The marker is a sentence rather than a bare disable for the reason `check-email-isolation.mjs`
 * gives: the reason is what the next reader needs, and writing one is where you notice you have
 * none.
 *
 * ## Usage
 *
 *   node scripts/audit-test-assertions.mjs [paths...]
 *
 * Exits 1 and prints every test that asserts nothing. Defaults to every committed test lane.
 * `experiments/` is out of scope (spikes are not maintained, per `workflow.md` § *Experiments*), as
 * is the vendored typia fork, whose tests are not ours to restyle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const DEFAULT_PATHS = ['packages', 'apps', 'tooling', 'doc-test'];
const TEST_FILE = /\.test\.(ts|mts|tsx|js|mjs)$/;

/** Test functions, and the vitest modifiers that may sit between them and the call. */
const TEST_ROOTS = new Set(['it', 'test']);
const SUITE_ROOTS = new Set(['describe', 'suite']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'each', 'for', 'concurrent', 'sequential', 'fails', 'skipIf', 'runIf', 'shuffle']);
const DEFERRED = new Set(['skip', 'todo']);

const ASSERT_ROOTS = new Set(['expect', 'assert', 'expectTypeOf', 'assertType']);
const ASSERT_MODULE = /^(node:)?assert(\/strict)?$/;
const ASSERTING_NAME = /^(assert|expect|verify)[A-Z0-9_]/;
const OPT_OUT = /test-assertions:\s*\S/;

function walk(path, out = []) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'forks' || entry.startsWith('.')) continue;
      walk(join(path, entry), out);
    }
  } else if (TEST_FILE.test(path)) {
    out.push(path);
  }
  return out;
}

// ── Modules: one parse per file, with what a call into it needs ─────────────────────────────

/** @type {Map<string, Module | null>} */
const modules = new Map();

/**
 * @typedef {object} Module
 * @property {ts.SourceFile} sf
 * @property {string} file
 * @property {Map<string, ts.Node[]>} functions  every named function body in the file, any depth
 * @property {Map<string, ts.Node[]>} registries  every named object literal — `const tests = { a, b }`
 * @property {Set<string>} assertImports          local names bound to a `node:assert` import
 * @property {Map<string, { from: string, name: string }>} imports   relative named/default imports
 * @property {Map<string, { from: string, name: string }>} reExports `export { a as b } from './x'`
 * @property {string[]} starExports               `export * from './x'`
 */

function scriptKind(file) {
  const ext = extname(file);
  return ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.js' || ext === '.mjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** The file a relative specifier names, trying the extensions TS and Node would. */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts'), join(base, 'index.js')];
  for (const c of candidates) {
    const st = statSync(c, { throwIfNoEntry: false });
    if (st?.isFile()) return c;
  }
  return null;
}

/** @returns {Module | null} */
function loadModule(file) {
  if (modules.has(file)) return modules.get(file);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { modules.set(file, null); return null; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  /** @type {Module} */
  const mod = { sf, file, functions: new Map(), registries: new Map(), assertImports: new Set(), imports: new Map(), reExports: new Map(), starExports: [] };
  modules.set(file, mod);

  const add = (table, name, node) => {
    if (!node) return;
    const list = table.get(name) ?? [];
    list.push(node);
    table.set(name, list);
  };
  const addFn = (name, body) => add(mod.functions, name, body);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        const bindings = clause.namedBindings;
        if (ASSERT_MODULE.test(spec)) {
          if (clause.name) mod.assertImports.add(clause.name.text);
          if (bindings && ts.isNamespaceImport(bindings)) mod.assertImports.add(bindings.name.text);
          if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) mod.assertImports.add(el.name.text);
        } else {
          const from = resolveRelative(file, spec);
          if (from) {
            if (clause.name) mod.imports.set(clause.name.text, { from, name: 'default' });
            if (bindings && ts.isNamedImports(bindings)) {
              for (const el of bindings.elements) mod.imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // `export { local as exported }` — an alias for something declared in this file.
      for (const el of node.exportClause.elements) {
        if (el.propertyName) mod.reExports.set(el.name.text, { from: file, name: el.propertyName.text });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = resolveRelative(file, node.moduleSpecifier.text);
      if (from) {
        if (!node.exportClause) mod.starExports.push(from);
        else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) mod.reExports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addFn(node.name.text, node.body);
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) addFn('default', node.body);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      addFn(node.name.text, node.initializer.body);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)) {
      add(mod.registries, node.name.text, node.initializer);
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      addFn(node.name.text, node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mod;
}

/**
 * Whether a file holds test code, and so may be followed into. The code UNDER test must not be:
 * its own `throw`s are its error paths, not assertions, and following into `routeDORequest` is
 * exactly what let the routing tests above read as asserting. A file counts when it sits under a
 * `test` or `harness` directory and not under a `src` one.
 */
function isTestSide(file) {
  const parts = relative(process.cwd(), file).split(/[\\/]/);
  return parts.some((p) => p === 'test' || p === 'tests' || p === 'harness') && !parts.includes('src');
}

/**
 * Declarations of `name` in one of a module's tables (`functions` or `registries`), as seen from
 * `mod`: declared there, imported into it, or re-exported by it.
 * @returns {{ mod: Module, node: ts.Node }[]}
 */
function lookup(mod, table, name, depth = 0) {
  if (depth > 8) return [];
  const local = mod[table].get(name);
  if (local) return local.map((node) => ({ mod, node }));
  const link = mod.imports.get(name) ?? mod.reExports.get(name);
  if (link) {
    const target = isTestSide(link.from) ? loadModule(link.from) : null;
    return target ? lookup(target, table, link.name, depth + 1) : [];
  }
  return mod.starExports.flatMap((from) => {
    const target = isTestSide(from) ? loadModule(from) : null;
    return target ? lookup(target, table, name, depth + 1) : [];
  });
}

/** Function bodies for `name` as seen from `mod`. */
function bodiesFor(mod, name) {
  return lookup(mod, 'functions', name).map(({ mod: m, node }) => ({ mod: m, body: node }));
}

/**
 * The function bodies a registry call can dispatch to: `tests.increment(t)` reaches one entry,
 * `tests[name](t)` reaches every entry. Null when the callee is not rooted at a known registry.
 */
function registryTargets(mod, callee) {
  const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text
    : ts.isElementAccessExpression(callee) ? null
    : undefined;
  if (member === undefined || !ts.isIdentifier(callee.expression)) return null;
  const registries = lookup(mod, 'registries', callee.expression.text);
  if (!registries.length) return null;

  const targets = [];
  for (const { mod: m, node } of registries) {
    for (const prop of node.properties) {
      const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
      if (member !== null && key !== member) continue;
      if (ts.isMethodDeclaration(prop) && prop.body) targets.push({ mod: m, body: prop.body });
      else if (ts.isShorthandPropertyAssignment(prop)) targets.push(...bodiesFor(m, prop.name.text));
      else if (ts.isPropertyAssignment(prop)) {
        const init = prop.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) targets.push({ mod: m, body: init.body });
        else if (ts.isIdentifier(init)) targets.push(...bodiesFor(m, init.text));
      }
    }
  }
  return targets;
}

// ── Does a body reach an assertion? ──────────────────────────────────────────────────────────

/** The identifier a call chain is rooted at: `expect` for `expect(x).not.toBe(y)`. */
function rootIdentifier(expr) {
  let e = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    else return null;
  }
}

/** The name the callee is called by: `assertRefused` for both `assertRefused()` and `h.assertRefused()`. */
function calleeName(callee) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/**
 * Bodies already shown to assert. Only a yes is cached: a no reached while a caller further up is
 * still being visited (mutual recursion) is partial, and caching it would turn a helper that
 * asserts into one that does not.
 */
const asserting = new Set();

function reachesAssertion(mod, body, seen = new Set()) {
  if (asserting.has(body)) return true;
  if (seen.has(body)) return false;
  seen.add(body);

  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isThrowStatement(node)) { found = true; return; }
    if (ts.isCallExpression(node)) {
      const root = rootIdentifier(node.expression);
      if (root && (ASSERT_ROOTS.has(root) || mod.assertImports.has(root))) { found = true; return; }
      const name = calleeName(node.expression);
      if (name && ASSERTING_NAME.test(name)) { found = true; return; }
      if (ts.isIdentifier(node.expression)) {
        for (const target of bodiesFor(mod, node.expression.text)) {
          if (reachesAssertion(target.mod, target.body, seen)) { found = true; return; }
        }
      }
      // A registry dispatch asserts only if EVERY entry it can reach does: which one runs is
      // decided at runtime, so a single empty entry is a test that asserts nothing.
      const targets = registryTargets(mod, node.expression);
      if (targets?.length && targets.every((t) => reachesAssertion(t.mod, t.body, new Set(seen)))) {
        found = true; return;
      }
      // A function passed by name — `vi.waitFor(check)`, `it.each(rows)('…', runCase)`.
      for (const arg of node.arguments) {
        if (!ts.isIdentifier(arg)) continue;
        for (const target of bodiesFor(mod, arg.text)) {
          if (reachesAssertion(target.mod, target.body, seen)) { found = true; return; }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  if (found) asserting.add(body);
  return found;
}

// ── Find the tests ───────────────────────────────────────────────────────────────────────────

/**
 * If `call` is rooted at one of `roots`, its modifier chain (`['each']` for
 * `it.each(rows)('…', fn)`); otherwise null. Only the vitest modifiers are accepted, so
 * `pattern.test(s)` is not a test.
 */
function modifiersOf(call, roots) {
  const mods = [];
  let e = call.expression;
  for (;;) {
    if (ts.isIdentifier(e)) return roots.has(e.text) ? mods : null;
    if (ts.isPropertyAccessExpression(e)) {
      if (!MODIFIERS.has(e.name.text)) return null;
      mods.push(e.name.text);
      e = e.expression;
    } else if (ts.isCallExpression(e)) {
      // `it.each(rows)` / `it.skipIf(cond)` — the outer call is the test.
      e = e.expression;
    } else return null;
  }
}

/** The test body: the first argument after the name that is, or names, a function. */
function testBody(mod, call) {
  for (const arg of call.arguments.slice(1)) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return [{ mod, body: arg.body }];
    if (ts.isIdentifier(arg)) {
      const found = bodiesFor(mod, arg.text);
      if (found.length) return found;
    }
  }
  return null;
}

function testName(call) {
  const first = call.arguments[0];
  if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
  return first ? first.getText().slice(0, 80) : '(unnamed)';
}

function findingsFor(file) {
  const mod = loadModule(file);
  if (!mod) return { tests: 0, findings: [] };
  const findings = [];
  let tests = 0;

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      // Everything under `describe.skip` / `describe.todo` is deferred along with it.
      const suiteMods = modifiersOf(node, SUITE_ROOTS);
      if (suiteMods?.some((m) => DEFERRED.has(m))) return;
      const mods = modifiersOf(node, TEST_ROOTS);
      if (mods && !mods.some((m) => DEFERRED.has(m))) {
        const bodies = testBody(mod, node);
        if (bodies) {
          tests += 1;
          const asserts = bodies.some((b) => reachesAssertion(b.mod, b.body));
          // getFullText includes the comments directly above the call.
          if (!asserts && !OPT_OUT.test(node.getFullText())) {
            const { line } = mod.sf.getLineAndCharacterOfPosition(node.getStart());
            findings.push({ file: relative(process.cwd(), file), line: line + 1, name: testName(node) });
          }
          return; // a test does not declare tests
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return { tests, findings };
}

const paths = process.argv.slice(2);
const files = (paths.length ? paths : DEFAULT_PATHS).flatMap((p) => walk(p));
let tests = 0;
const findings = [];
for (const file of files) {
  const r = findingsFor(resolve(file));
  tests += r.tests;
  findings.push(...r.findings);
}

if (findings.length === 0) {
  console.log(`✅ every test asserts something or says why not (${tests} tests in ${files.length} files)`);
  process.exit(0);
}

console.error(`❌ ${findings.length} test(s) assert nothing, so they pass whatever the code does:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    ${f.name}`);
}
console.error('\n  → assert the behaviour the test is named for. If its whole claim is "does not throw", say so:');
console.error('      expect(() => f()).not.toThrow()  ·  await expect(p).resolves.toBeUndefined()');
console.error('    or state the failure it catches on or above the test:');
console.error('      // test-assertions: <what failure this test catches without an assertion>');
console.error('    A test that duplicates coverage elsewhere should be deleted, not given an assertion.');
process.exit(1);
