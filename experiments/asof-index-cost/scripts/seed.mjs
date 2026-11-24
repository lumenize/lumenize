#!/usr/bin/env node
/**
 * Builds every object: each arm's table and indexes, then the writes in order.
 *
 *   BASE=https://experiment-asof-index-cost.<account>.workers.dev node scripts/seed.mjs
 *
 * Indexes go on before the data, so each row is written as a live host would write it. A batch is
 * one transaction and names where it starts, so a rerun resumes where the last one stopped, and a
 * retried batch that had landed is skipped.
 */
import { call, ddlOf, OBJECTS, tableOf, writesOf } from './lib.mjs';

const BATCH = Number(process.env.BATCH ?? 5000);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [object, { arms }] of Object.entries(OBJECTS)) {
  if (ONLY && !ONLY.test(object)) continue;
  const total = writesOf(object);
  const tables = arms.map(([arm, n]) => tableOf(arm, n));
  await call(object, { kind: 'ddl', sql: arms.flatMap(([arm, n]) => ddlOf(arm, n)) });
  const info = await call(object, { kind: 'info', tables });
  for (const table of tables) {
    let seeded = info.seeded[table];
    let rowsWritten = 0;
    while (seeded < total) {
      const out = await call(object, { kind: 'seed', table, from: seeded, count: Math.min(BATCH, total - seeded) });
      seeded = out.seeded;
      if (out.skipped) continue;
      rowsWritten += out.rowsWritten;
      process.stdout.write(`\r${object} ${table}: ${seeded}/${total} writes, ${out.workerMs} ms last batch   `);
    }
    console.log(`\n${object} ${table}: ${rowsWritten} rows written this run`);
  }
  const after = await call(object, { kind: 'info', tables });
  console.log(`${object}: ${(after.databaseSize / 1e6).toFixed(1)} MB, ${after.indexes.length} indexes`);
}
