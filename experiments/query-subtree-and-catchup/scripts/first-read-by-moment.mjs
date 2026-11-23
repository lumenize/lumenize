#!/usr/bin/env node
/**
 * A follow-up to RESULTS.md: what would a FIRST read cost if it paged by moment from the
 * beginning, as a catch-up does, instead of by resource id over current rows?
 *
 *   BASE=… node scripts/first-read-by-moment.mjs && node scripts/logs.mjs results/run-<time>-first-read-by-moment.json
 *
 * All on `all`, `Deal`, no filter, the whole tree. Writes a run file scripts/logs.mjs can join.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeId, SUBTREES, subtree } from '../src/fixture.js';
import { BASE, call, current, RESULTS } from './lib.mjs';

const ROUNDS = 5;
const json = JSON.stringify(subtree(SUBTREES.n4111).map(nodeId).sort());
const FROM = 'Snapshots INDEXED BY idx_Snapshots_typeMoment';
const cases = {
  // Today's design (DI17): current rows only, by resource id.
  'current rows, by resource id': { kind: 'sql', sql: `SELECT resourceId, nodeId, validFrom, value FROM Snapshots INDEXED BY idx_Snapshots_current WHERE ${current('Deal')} AND nodeId IN (SELECT value FROM json_each(?)) ORDER BY resourceId`, params: [json] },
  // By moment, sending every version in write order.
  'every version, by moment': { kind: 'catchup', moment: '', find: [{ sql: `SELECT resourceId, validFrom, nodeId, deleted, value FROM ${FROM} WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId`, params: ['Deal', ''] }] },
  // By moment as ONE page: ids from the index, then each resource's last version by key. The least a by-moment read can do.
  'ids by moment, then each resource once by key': { kind: 'catchup', moment: '', keyReads: 'both', find: [{ sql: `SELECT resourceId, validFrom FROM ${FROM} WHERE typeName = ? AND validFrom > ? ORDER BY validFrom, resourceId`, params: ['Deal', ''] }] },
};
const run = new Date().toISOString().replace(/[:.]/g, '-');
const out = { run, base: BASE, startedAt: new Date().toISOString(), noops: [], records: [] };
for (const [id, op] of Object.entries(cases)) out.records.push({ id, first: await call('all', { ...op, explain: true, reps: 1 }), timed: [] });
for (let round = 0; round < ROUNDS; round++) {
  for (const [i, op] of Object.values(cases).entries()) {
    const t = await call('all', { ...op, reps: 2 });
    out.records[i].timed.push({ seq: t.seq, round, reps: 2, workerMs: t.workerMs });
  }
}
out.finishedAt = new Date().toISOString();
const file = join(RESULTS, `run-${run}-first-read-by-moment.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(file);
