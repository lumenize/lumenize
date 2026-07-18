/**
 * DO-class consistency gate for the FIRST (and every subsequent) prod deploy of apps/nebula.
 * The `wrangler.jsonc` DO-class registry is a ONE-WAY DOOR: once the first prod deploy lands, a
 * class add/rename/delete can never be cleanly undone (old rows may not be trimmable). So this is
 * the last thing checked before cutting a deploy — `deploy.sh` runs it as a preflight
 * (nebula-release-process.md Phase 0/A + Phase 3).
 *
 * (Named `audit-migrations` for history; the registry moved from the imperative `migrations` array
 * to the declarative `exports` map — tasks/archive/do-exports-and-toolchain-upgrade.md — and this gate reads
 * `exports` now.) It asserts, on the HARDCODED single prod `apps/nebula/wrangler.jsonc` (never a glob
 * — the bench worker's chain intentionally diverges):
 *   1. the durable_objects.bindings class_names == the `type: "durable-object"` `exports` keys
 *      (set-equality), each set sized EXACTLY {@link EXPECTED_DO_CLASS_COUNT} (the size tripwire
 *      guards against a silent parse→{} vacuous-passing the comparison);
 *   2. every durable-object export is `storage: "sqlite"` — a non-SQLite prod DO makes sync storage
 *      throw → hard deploy failure (see .claude/rules/durable-objects.md § DO class registration);
 *   3. the non-DO exports `default` (the fetch handler) and `NebulaEmailSender` (a WorkerEntrypoint)
 *      are ABSENT from the bindings and from the durable-object exports (a `type: "worker"` export is
 *      allowed, a durable-object one is a hard failure);
 *   4. `src/worker.ts` re-exports each of the registered DO classes.
 *
 * Why PARSE, never substring-grep (the criterion that drove this script): a class name can be a
 * substring of another export (e.g. a `Profil` prefix of `Profile`), so a grep false-passes. We parse
 * the JSONC into sets and the worker.ts `export {…}` clauses into a token set — exact membership.
 *
 * The {@link auditMigrations} core is a PURE function (string in → result out) so the capable-of-failing
 * mutations in `scripts/audit-migrations.selftest.mjs` (plain Node, run via `npm run audit:migrations:selftest`
 * — NOT a vitest test, NOT in `npm run test:code`/CI) feed it mutated config/worker text with no filesystem.
 * The CLI block at the bottom reads the hardcoded prod files and exits non-zero on any failure.
 */

/**
 * Freeze-time count of registered DO classes: NebulaClientGateway, Universe, Galaxy, Star,
 * DevStudio, DevContainer, NebulaAuthRegistry, Profile — 8. (The `Profile` DO was added post-
 * pre-alpha; the per-scope `NebulaAuth` DO was dissolved earlier — tasks/nebula-auth-surrogate-sub.md.)
 * The gate is a one-way-door tripwire, so when the registry LEGITIMATELY changes (a DO class added or
 * removed), bump this DELIBERATELY in the same change that edits bindings + exports + worker.ts — that
 * conscious edit is the discipline, and it keeps a silent parse failure (→ empty set, size 0) from
 * vacuous-passing. (⚠️ Coordinate with tasks/nebula-devstudio-collapse.md, which removes DevContainer:
 * whichever lands second sets the final count 8→7.)
 */
export const EXPECTED_DO_CLASS_COUNT = 8;

/** Non-DO exports that must never be a `durable_objects` binding NOR a `type: "durable-object"` export. */
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
  const exportsMap = config?.exports;
  if (!exportsMap || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    return { ok: false, errors: ['exports is missing or not an object'] };
  }

  const bindingClasses = new Set(bindings.map((b) => b?.class_name).filter(Boolean));

  // Durable-object exports, TYPE-AWARE: an `exports` value may be a DurableObjectExport OR a
  // WorkerEntrypointExport (`type: "worker"`) — so scope the DO checks to `type: "durable-object"`
  // entries. Collect the DO class set and flag any that isn't storage:"sqlite" (a non-SQLite prod DO
  // throws on first sync-storage access = hard deploy failure — the invariant the old new_classes ban held).
  const doClasses = new Set();
  const nonSqlite = [];
  for (const [name, cfg] of Object.entries(exportsMap)) {
    if (cfg?.type !== 'durable-object') continue; // e.g. a WorkerEntrypoint export — not a DO
    doClasses.add(name);
    if (cfg?.storage !== 'sqlite') nonSqlite.push(`${name} (storage: ${cfg?.storage ?? 'missing'})`);
  }

  // SQLite invariant — every durable-object export must be storage:"sqlite" (NOT just a valid enum:
  // legacy-kv/missing is a hard prod failure). This preserves the force of the old new_classes ban.
  if (nonSqlite.length) {
    errors.push(
      `durable-object exports must be storage:"sqlite" (a non-SQLite DO throws on sync storage — ` +
        `hard deploy failure): ${nonSqlite.join(', ')}`,
    );
  }

  // Size tripwire: both sets EXACTLY the freeze-time count (a silent parse→{} → size 0 → red).
  if (bindingClasses.size !== EXPECTED_DO_CLASS_COUNT) {
    errors.push(
      `expected ${EXPECTED_DO_CLASS_COUNT} durable_objects.bindings DO classes, found ` +
        `${bindingClasses.size}: [${[...bindingClasses].join(', ')}]`,
    );
  }
  if (doClasses.size !== EXPECTED_DO_CLASS_COUNT) {
    errors.push(
      `expected ${EXPECTED_DO_CLASS_COUNT} durable-object exports, found ` +
        `${doClasses.size}: [${[...doClasses].join(', ')}]`,
    );
  }

  // Set-equality between the binding class_names and the durable-object exports.
  const onlyInBindings = [...bindingClasses].filter((c) => !doClasses.has(c));
  const onlyInExports = [...doClasses].filter((c) => !bindingClasses.has(c));
  if (onlyInBindings.length) {
    errors.push(`classes in durable_objects.bindings but not exports: ${onlyInBindings.join(', ')}`);
  }
  if (onlyInExports.length) {
    errors.push(`classes in exports but not durable_objects.bindings: ${onlyInExports.join(', ')}`);
  }

  // Non-DO exports (`default`, `NebulaEmailSender`) must NOT be a durable-object binding NOR a
  // durable-object export. (They may legitimately be a `type: "worker"` export — hence the DO-scoped
  // check above — but never a DO.)
  for (const forbidden of NON_DO_EXPORTS) {
    if (bindingClasses.has(forbidden)) {
      errors.push(`${forbidden} must NOT be a durable_objects binding (it is not a DO)`);
    }
    if (doClasses.has(forbidden)) {
      errors.push(`${forbidden} must NOT be a durable-object export (non-DO — hard deploy failure)`);
    }
  }

  // worker.ts re-exports each registered DO class so the runtime can locate it.
  const exported = parseReexports(workerTs);
  const registered = new Set([...bindingClasses, ...doClasses]);
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
        `✅ DO-registry audit clean — ${EXPECTED_DO_CLASS_COUNT} DO classes consistent across ` +
          `durable_objects.bindings, the wrangler \`exports\` map, and src/worker.ts re-exports.`,
      );
      process.exit(0);
    }
    console.error('❌ DO-registry audit FAILED (the prod DO-class registry is a one-way door — do not deploy):');
    for (const e of errors) console.error(`   • ${e}`);
    process.exit(1);
  })();
}
