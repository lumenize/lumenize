/**
 * Migrations / DO-class consistency gate for the FIRST (and every subsequent) prod
 * deploy of apps/nebula. The `wrangler.jsonc` `migrations` block is a ONE-WAY DOOR:
 * once the first prod deploy lands, the DO-class registry is append-only forever
 * (a class add/rename/delete is a migration that can never be undone; old rows may
 * not be trimmable). So this is the last thing checked before cutting a deploy —
 * `deploy.sh` runs it as a preflight (nebula-release-process.md Phase 0/A + Phase 3).
 *
 * It asserts, on the HARDCODED single prod `apps/nebula/wrangler.jsonc` (never a glob —
 * the bench worker's chain intentionally diverges):
 *   1. the durable_objects.bindings class_names == the migrations new_sqlite_classes
 *      (set-equality), each set sized EXACTLY {@link EXPECTED_DO_CLASS_COUNT} (the
 *      size tripwire guards against a silent parse→[] vacuous-passing the comparison);
 *   2. zero `new_classes` entries (sync storage throws on a non-SQLite DO → hard
 *      deploy failure — see .claude/rules/durable-objects.md § DO class registration);
 *   3. the non-DO exports `default` (the fetch handler) and `NebulaEmailSender` (a
 *      WorkerEntrypoint) are ABSENT from both bindings and migrations — adding
 *      NebulaEmailSender to `migrations` is a hard deploy failure;
 *   4. `src/worker.ts` re-exports each of the registered DO classes.
 *
 * Why PARSE, never substring-grep (the criterion that drove this script): `NebulaAuth`
 * is a substring of `NebulaAuthRegistry` and `NebulaEmailSender` shares an export line,
 * so a grep false-passes. We parse the JSONC into sets and the worker.ts `export {…}`
 * clauses into a token set — exact membership, no substring collisions.
 *
 * The {@link auditMigrations} core is a PURE function (string in → result out) so the
 * capable-of-failing mutation tests (test/audit-migrations.test.ts) can feed it mutated
 * config/worker text with no filesystem. The CLI block at the bottom reads the hardcoded
 * prod files and exits non-zero on any failure.
 */

/**
 * Freeze-time count of registered DO classes (NebulaClientGateway, Universe, Galaxy,
 * Star, DevStudio, DevContainer, NebulaAuth, NebulaAuthRegistry). The gate is the
 * one-way-door tripwire, so when the append-only registry LEGITIMATELY grows (a new DO
 * class post-pre-alpha), bump this DELIBERATELY in the same change that adds the class
 * to bindings + migrations + worker.ts — that conscious edit is the discipline, and it
 * keeps a silent parse failure (→ empty set, size 0) from vacuous-passing.
 */
export const EXPECTED_DO_CLASS_COUNT = 8;

/** Non-DO exports that must never appear in `durable_objects.bindings` or `migrations`. */
const NON_DO_EXPORTS = ['default', 'NebulaEmailSender'];

/**
 * Strip `//` line and `/* *​/` block comments from JSONC, string-aware (a `//` or `/*`
 * inside a `"..."` value is preserved). JSON uses only `"` for strings, so we track just
 * that delimiter; apostrophes live only inside comments (consumed by the skip) or string
 * values (inside `"`), never as a delimiter.
 */
function stripComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i += 2; continue; } // copy the escaped char verbatim
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && c2 === '/') { i += 2; while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop trailing commas before `}`/`]`, string-aware. Run AFTER {@link stripComments}. */
function stripTrailingCommas(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') { i++; continue; } // drop the trailing comma
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC. THROWS on malformed input (so a parse failure can't vacuous-pass). */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

/**
 * Collect identifiers re-exported by `export { A, B as C } from '…'` clauses. Tokenized
 * (not substring-matched) so `NebulaAuth` and `NebulaAuthRegistry` are distinct, and the
 * `[^}]*` capture spans the multi-line clause in worker.ts.
 */
function parseReexports(workerTs) {
  const names = new Set();
  const re = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(workerTs))) {
    for (let tok of m[1].split(',')) {
      tok = tok.trim();
      if (!tok) continue;
      const asMatch = tok.match(/\bas\s+(\w+)\s*$/);
      names.add(asMatch ? asMatch[1] : tok); // re-exported name is the part after `as`
    }
  }
  return names;
}

/**
 * Audit the prod migrations/DO-class consistency. Pure: pass the file CONTENTS, not paths.
 * @param {{ wranglerJsonc: string, workerTs: string }} files
 * @returns {{ ok: boolean, errors: string[] }} ok=true only when every invariant holds.
 */
export function auditMigrations({ wranglerJsonc, workerTs }) {
  const errors = [];

  let config;
  try {
    config = parseJsonc(wranglerJsonc);
  } catch (e) {
    return { ok: false, errors: [`wrangler.jsonc parse failed: ${e.message}`] };
  }

  const bindings = config?.durable_objects?.bindings;
  if (!Array.isArray(bindings)) {
    return { ok: false, errors: ['durable_objects.bindings is missing or not an array'] };
  }
  const migrations = config?.migrations;
  if (!Array.isArray(migrations)) {
    return { ok: false, errors: ['migrations is missing or not an array'] };
  }

  const bindingClasses = new Set(bindings.map((b) => b?.class_name).filter(Boolean));

  // Union new_sqlite_classes across every tag (append-only chain); collect any forbidden
  // new_classes entries.
  const sqliteClasses = new Set();
  const newClasses = [];
  for (const tag of migrations) {
    for (const c of tag?.new_sqlite_classes ?? []) sqliteClasses.add(c);
    for (const c of tag?.new_classes ?? []) newClasses.push(c);
  }

  // (c) zero new_classes — a non-SQLite DO makes sync storage throw (hard deploy failure).
  if (newClasses.length) {
    errors.push(
      `migrations register new_classes (must be new_sqlite_classes — sync storage throws ` +
        `on a non-SQLite DO): ${newClasses.join(', ')}`,
    );
  }

  // Size tripwire: both sets EXACTLY the freeze-time count (a silent parse→[] → size 0 → red).
  if (bindingClasses.size !== EXPECTED_DO_CLASS_COUNT) {
    errors.push(
      `expected ${EXPECTED_DO_CLASS_COUNT} durable_objects.bindings DO classes, found ` +
        `${bindingClasses.size}: [${[...bindingClasses].join(', ')}]`,
    );
  }
  if (sqliteClasses.size !== EXPECTED_DO_CLASS_COUNT) {
    errors.push(
      `expected ${EXPECTED_DO_CLASS_COUNT} migrations new_sqlite_classes, found ` +
        `${sqliteClasses.size}: [${[...sqliteClasses].join(', ')}]`,
    );
  }

  // Set-equality between the binding class_names and the registered SQLite classes.
  const onlyInBindings = [...bindingClasses].filter((c) => !sqliteClasses.has(c));
  const onlyInMigrations = [...sqliteClasses].filter((c) => !bindingClasses.has(c));
  if (onlyInBindings.length) {
    errors.push(`classes in durable_objects.bindings but not migrations: ${onlyInBindings.join(', ')}`);
  }
  if (onlyInMigrations.length) {
    errors.push(`classes in migrations but not durable_objects.bindings: ${onlyInMigrations.join(', ')}`);
  }

  // (3) Non-DO exports must be absent from both bindings and migrations.
  for (const forbidden of NON_DO_EXPORTS) {
    if (bindingClasses.has(forbidden)) {
      errors.push(`${forbidden} must NOT be a durable_objects binding (it is not a DO)`);
    }
    if (sqliteClasses.has(forbidden)) {
      errors.push(`${forbidden} must NOT appear in migrations (non-DO — hard deploy failure)`);
    }
  }

  // (4) worker.ts re-exports each registered DO class so the runtime can locate it.
  const exported = parseReexports(workerTs);
  const registered = new Set([...bindingClasses, ...sqliteClasses]);
  const missing = [...registered].filter((c) => !NON_DO_EXPORTS.includes(c) && !exported.has(c));
  if (missing.length) {
    errors.push(`src/worker.ts does not re-export: ${missing.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

// --- CLI: read the HARDCODED prod files and exit non-zero on any failure. -------------
// Guarded so importing this module (the mutation tests) never touches the filesystem.
if (globalThis.process?.argv?.[1]?.endsWith('audit-migrations.mjs')) {
  (async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const wranglerPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
    const workerPath = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
    const { ok, errors } = auditMigrations({
      wranglerJsonc: readFileSync(wranglerPath, 'utf8'),
      workerTs: readFileSync(workerPath, 'utf8'),
    });
    if (ok) {
      console.log(
        `✅ migrations audit clean — ${EXPECTED_DO_CLASS_COUNT} DO classes consistent across ` +
          `durable_objects.bindings, migrations.new_sqlite_classes, and src/worker.ts re-exports.`,
      );
      process.exit(0);
    }
    console.error('❌ migrations audit FAILED (the prod DO-class registry is a one-way door — do not deploy):');
    for (const e of errors) console.error(`   • ${e}`);
    process.exit(1);
  })();
}
