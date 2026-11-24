#!/usr/bin/env node
/**
 * Why a range read through an index on `json_extract(value, …)` costs about 10 µs an entry: counts
 * the same kind of range through idx_S_B1_x1 (built by MODE=extra) by its plain columns alone and
 * by its expression, and prints each statement's plan, its table seeks from EXPLAIN's bytecode, and
 * its time. Timed by the Worker's clock around the call to the object, `workerMs`, over `reps`
 * runs, so the figures include one round trip between Worker and object; they are not cpuTimeMs.
 *
 *   BASE=https://experiment-asof-index-cost.<account>.workers.dev node scripts/diagnose.mjs
 */
import { momentOf } from '../src/fixture.js';
import { call, field, writesOf } from './lib.mjs';

const object = 'd100';
const m = momentOf(writesOf(object) / 2 - 1);
const cases = {
  'plain columns only': [`SELECT count(*) AS n FROM S_B1 INDEXED BY idx_S_B1_x1 WHERE typeName = 'Contact' AND validTo > ? AND deleted = 0`, [m]],
  'expression in WHERE': [`SELECT count(*) AS n FROM S_B1 INDEXED BY idx_S_B1_x1 WHERE typeName = 'Deal' AND ${field('stage')} = 'open' AND validTo > ?`, [m]],
  'expression, and validFrom': [`SELECT count(*) AS n FROM S_B1 INDEXED BY idx_S_B1_x1 WHERE typeName = 'Deal' AND deleted = 0 AND ${field('stage')} = 'open' AND validTo > ? AND validFrom <= ?`, [m, m]],
  'arm B, expression, and validFrom': [`SELECT count(*) AS n FROM S_B1 INDEXED BY "idx_S_B1_q_Deal:stage" WHERE typeName = 'Deal' AND deleted = 0 AND ${field('stage')} = 'open' AND validTo > ? AND validFrom <= ?`, [m, m]],
};
for (const [name, [sql, params]] of Object.entries(cases)) {
  const first = await call(object, { kind: 'sql', sql, params, explain: true, rowsOut: true });
  const ms = [];
  for (let i = 0; i < 3; i++) ms.push((await call(object, { kind: 'sql', sql, params, reps: 5 })).workerMs / 5);
  const code = (await call(object, { kind: 'sql', rowsOut: true, sql: `EXPLAIN ${sql}`, params })).out;
  const seeks = code.filter((o) => /NotFound|DeferredSeek|Seek/.test(o.opcode)).map((o) => `${o.opcode} cursor ${o.p1}`);
  console.log(`${name}: counted ${first.out[0].n}, rowsRead ${first.rowsRead}, ${ms.map((x) => x.toFixed(0)).join(' / ')} ms a run\n  plan: ${first.plan.join('; ')}\n  seeks: ${seeks.join(', ')}`);
}
