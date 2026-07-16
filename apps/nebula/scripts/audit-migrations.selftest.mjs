/**
 * Capable-of-failing proof for the exports audit gate ({@link ./audit-migrations.mjs}).
 * Runs the REAL prod config/worker (must pass) plus the mutations pinned as must-red
 * (nebula-release-process.md Phase 0/A + do-exports-and-toolchain-upgrade.md Phase 4) — each a
 * one-string edit that a vacuous gate would let through:
 *   (a) a 9th class only in `exports`                    → set-size + set-equality red
 *   (b) a DO class removed from worker.ts re-exports      → re-export red
 *   (c) a durable-object export flipped to legacy-kv      → SQLite-invariant red (the non-SQLite ban)
 *   (d) NebulaEmailSender as a durable-object export      → non-DO-exclusion red
 *   (e) a `Profil` export (a PREFIX of the real `Profile`) not re-exported → re-export red
 *       (a SUBSTRING grep for `Profil` false-passes on `Profile` — this proves we PARSE, not grep)
 *   (f) malformed JSONC                                   → parse failure, NOT a vacuous pass
 *
 * Plain Node (no vitest/tsc): the gate is a tooling script, and `scripts/**` is outside the
 * tsconfig/vitest globs. Run: `node scripts/audit-migrations.selftest.mjs`
 * (or `npm run audit:migrations:selftest`). Exits non-zero on the first surprise.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditMigrations } from './audit-migrations.mjs';

const wranglerJsonc = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
const workerTs = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');

let passed = 0;
/** Assert a mutated input reds with an error matching `errorRe`. */
function expectRed(label, files, errorRe) {
  const { ok, errors } = auditMigrations(files);
  assert.equal(ok, false, `${label}: expected ok=false but the gate PASSED (vacuous!)`);
  assert.ok(
    errors.some((e) => errorRe.test(e)),
    `${label}: expected an error matching ${errorRe}, got:\n   ${errors.join('\n   ')}`,
  );
  passed++;
  console.log(`  ✅ ${label} — red as expected`);
}

// Baseline: the real prod config (on `exports`) + worker must pass.
{
  const { ok, errors } = auditMigrations({ wranglerJsonc, workerTs });
  assert.ok(ok, `baseline: real config should PASS, got errors:\n   ${errors.join('\n   ')}`);
  passed++;
  console.log('  ✅ baseline (real prod config) — passes');
}

// Insert a durable-object export at the top of the `exports` map.
const doEntry = (name, storage = 'sqlite') => `"${name}": { "type": "durable-object", "storage": "${storage}" },`;
const addExport = (name, storage) => wranglerJsonc.replace('"exports": {', `"exports": {\n    ${doEntry(name, storage)}`);

// (a) a 9th class only in exports (absent from bindings).
expectRed('(a) 9th class only in exports',
  { wranglerJsonc: addExport('GhostDO9'), workerTs },
  /GhostDO9|exports but not durable_objects|expected 8 durable-object exports/);

// (b) a DO class removed from worker.ts re-exports.
expectRed('(b) Star missing from worker.ts',
  { wranglerJsonc, workerTs: workerTs.replace(/\n\s*Star,/, '') },
  /re-export.*Star/);

// (c) a durable-object export flipped to legacy-kv (non-SQLite → sync storage throws at runtime).
expectRed('(c) durable-object export storage:legacy-kv',
  { wranglerJsonc: wranglerJsonc.replace(
      '"NebulaClientGateway": { "type": "durable-object", "storage": "sqlite" }',
      '"NebulaClientGateway": { "type": "durable-object", "storage": "legacy-kv" }'), workerTs },
  /must be storage:"sqlite"/);

// (d) NebulaEmailSender (a WorkerEntrypoint, not a DO) registered as a durable-object export.
expectRed('(d) NebulaEmailSender as a durable-object export',
  { wranglerJsonc: addExport('NebulaEmailSender'), workerTs },
  /NebulaEmailSender must NOT be a durable-object export/);

// (e) parse-not-grep: register `Profil` (a PREFIX of the real, re-exported `Profile`) — worker.ts
//     does NOT re-export `Profil`, so the tokenized re-export check reds. A substring grep for
//     "Profil" would false-pass on "Profile"; this is why the gate parses instead of grepping.
expectRed('(e) parse-not-grep: Profil (prefix of Profile) not re-exported',
  { wranglerJsonc: addExport('Profil'), workerTs },
  /does not re-export.*\bProfil\b/);

// (f) malformed JSONC must surface a parse failure, never silently pass on empty sets.
expectRed('(f) malformed JSONC parse failure',
  { wranglerJsonc: '{ this is not json ]]', workerTs },
  /parse failed/);

console.log(`\n✅ exports-audit selftest: ${passed} checks passed (baseline + 6 must-red mutations).`);
