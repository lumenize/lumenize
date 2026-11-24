#!/usr/bin/env node
/**
 * Builds every object: the tree, the configuration's indexes, then the writes in order.
 *
 *   BASE=https://experiment-query-subtree-and-catchup.<account>.workers.dev node scripts/seed.mjs
 *
 * Indexes go on before the data, so each row is written as a live host would write it. A batch is
 * one transaction and names where it starts, so a rerun resumes where the last one stopped.
 */
import { WRITES } from '../src/fixture.js';
import { call, INSTANCES, QUERY_INDEXES } from './lib.mjs';

const BATCH = Number(process.env.BATCH ?? 4000);
for (const [instance, ddl] of Object.entries(INSTANCES)) {
  await call(instance, { kind: 'tree' });
  await call(instance, { kind: 'ddl', sql: [...QUERY_INDEXES, ...ddl], dropCurrent: instance === 'swap' });
  let { seeded } = await call(instance, { kind: 'info' });
  let rowsWritten = 0;
  while (seeded < WRITES) {
    const out = await call(instance, { kind: 'seed', from: seeded, count: Math.min(BATCH, WRITES - seeded) });
    if (out.skipped) { seeded = out.seeded; continue; } // a retried batch that had landed
    seeded = out.seeded;
    rowsWritten += out.rowsWritten;
    process.stdout.write(`\r${instance}: ${seeded}/${WRITES} writes, ${out.workerMs} ms last batch   `);
  }
  const info = await call(instance, { kind: 'info' });
  console.log(`\n${instance}: ${rowsWritten} rows written this run, ${(info.databaseSize / 1e6).toFixed(1)} MB, indexes: ${info.indexes.map((i) => i.name).join(', ')}`);
}
