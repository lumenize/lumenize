/**
 * Capable-of-failing proof for the migrations audit gate ({@link ./audit-migrations.mjs}).
 * Runs the REAL prod config/worker (must pass) plus the mutations the task pins as
 * must-red (nebula-release-process.md Phase 0/A success criteria) — each a one-string
 * edit that a vacuous gate would let through:
 *   (a) a 9th class only in new_sqlite_classes        → set-size + set-equality red
 *   (b) a DO class removed from worker.ts re-exports   → re-export red
 *   (c) a new_classes entry                            → non-SQLite red
 *   (d) NebulaEmailSender added to migrations          → non-DO-exclusion red
 *   (e) worker.ts exports NebulaAuthRegistry but not the standalone NebulaAuth
 *       → re-export red (a SUBSTRING grep false-passes here — this proves we parse)
 *   (f) malformed JSONC                                → parse failure, NOT a vacuous pass
 *
 * Plain Node (no vitest/tsc): the gate is a tooling script, and `scripts/**` is outside
 * the tsconfig/vitest globs. Run: `node scripts/audit-migrations.selftest.mjs`
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

// Baseline: the real prod config + worker must pass.
{
  const { ok, errors } = auditMigrations({ wranglerJsonc, workerTs });
  assert.ok(ok, `baseline: real config should PASS, got errors:\n   ${errors.join('\n   ')}`);
  passed++;
  console.log('  ✅ baseline (real prod config) — passes');
}

// (a) 9th class only in new_sqlite_classes.
expectRed('(a) 9th class only in new_sqlite_classes',
  { wranglerJsonc: wranglerJsonc.replace('"new_sqlite_classes": [', '"new_sqlite_classes": [\n        "GhostDO9",'), workerTs },
  /GhostDO9|9|migrations but not/);

// (b) a DO class removed from worker.ts re-exports.
expectRed('(b) Star missing from worker.ts',
  { wranglerJsonc, workerTs: workerTs.replace(/\n\s*Star,/, '') },
  /re-export.*Star/);

// (c) a new_classes entry (non-SQLite DO — sync storage would throw).
expectRed('(c) new_classes entry',
  { wranglerJsonc: wranglerJsonc.replace('"new_sqlite_classes": [', '"new_classes": ["LegacyKvDO"],\n      "new_sqlite_classes": ['), workerTs },
  /new_classes/);

// (d) NebulaEmailSender (a WorkerEntrypoint, not a DO) added to migrations.
expectRed('(d) NebulaEmailSender in migrations',
  { wranglerJsonc: wranglerJsonc.replace('"new_sqlite_classes": [', '"new_sqlite_classes": [\n        "NebulaEmailSender",'), workerTs },
  /NebulaEmailSender/);

// (e) worker.ts exports NebulaAuthRegistry but NOT the standalone NebulaAuth.
//     A substring grep for "NebulaAuth" would match inside "NebulaAuthRegistry" → false pass.
expectRed('(e) parse-not-grep: NebulaAuth absent, NebulaAuthRegistry present',
  { wranglerJsonc, workerTs: workerTs.replace('NebulaAuth, NebulaAuthRegistry', 'NebulaAuthRegistry') },
  /re-export.*\bNebulaAuth\b/);

// (f) malformed JSONC must surface a parse failure, never silently pass on empty sets.
expectRed('(f) malformed JSONC parse failure',
  { wranglerJsonc: '{ this is not json ]]', workerTs },
  /parse failed/);

console.log(`\n✅ migrations-audit selftest: ${passed} checks passed (baseline + 6 must-red mutations).`);
