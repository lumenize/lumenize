/**
 * Phase 1 benchmark runner.
 *
 * Reports, for every (format × mutation × N) cell:
 *   - Snapshot bytes (raw JSON)
 *   - Snapshot bytes (gzipped)
 *   - Patch bytes (raw JSON)
 *   - Patch bytes (gzipped)
 *   - Encode time (ms, mean of K)
 *   - Decode time (ms, mean of K)
 *   - Patch-generate time (ms, mean of K)
 *   - Patch-apply time (ms, mean of K)
 *
 * Output: writes a self-contained JSON to ../results/bench-output.json.
 * Use `tsx scripts/run-report.ts` to render the markdown tables for RESULTS.md.
 */

import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSyntheticDag,
  mutateAddLeaf,
  mutateRenameLabel,
  mutateMoveSingle,
  mutateMoveSubtree50,
  mutateGrantPermission,
  type DagTreeState,
  type Mutation,
} from '../src/dag';
import { ALL_FORMATS } from '../src/formats';
import { applyMergePatch, diff, type JsonValue } from '../src/merge-patch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SIZES = [100, 1000, 10000];
const OPS: Array<[string, (s: DagTreeState, seed?: number) => Mutation]> = [
  ['add-leaf', mutateAddLeaf],
  ['rename-label', mutateRenameLabel],
  ['move-single', mutateMoveSingle],
  ['move-subtree-50', mutateMoveSubtree50],
  ['grant-permission', mutateGrantPermission],
];

const PERF_REPEATS = 5;

interface Cell {
  format: string;
  operation: string;
  N: number;
  snapshotRawBytes: number;
  snapshotGzipBytes: number;
  patchRawBytes: number;
  patchGzipBytes: number;
  encodeMs: number;
  decodeMs: number;
  diffMs: number;
  applyMs: number;
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function meanMs(fn: () => void, n: number): number {
  let total = 0;
  // Warmup
  fn();
  for (let i = 0; i < n; i++) total += timeMs(fn);
  return total / n;
}

function bytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

function gzBytes(v: unknown): number {
  return gzipSync(JSON.stringify(v)).byteLength;
}

const cells: Cell[] = [];

console.log('Building fixtures...');
const fixtures: Record<number, DagTreeState> = {};
for (const N of SIZES) {
  process.stdout.write(`  N=${N}... `);
  fixtures[N] = buildSyntheticDag(N, 1);
  console.log('ok');
}

console.log('\nRunning benchmarks...');
for (const N of SIZES) {
  const state = fixtures[N]!;
  for (const [opName, opFn] of OPS) {
    const mutation = opFn(state, 99);
    for (const fmt of ALL_FORMATS) {
      const wireBefore = fmt.encode(mutation.before) as unknown as JsonValue;
      const wireAfter = fmt.encode(mutation.after) as unknown as JsonValue;
      // Re-encode through JSON to normalize (matches what hits the wire).
      const stableBefore = JSON.parse(JSON.stringify(wireBefore)) as JsonValue;
      const stableAfter = JSON.parse(JSON.stringify(wireAfter)) as JsonValue;
      const patch = diff(stableBefore, stableAfter);

      const snapshotRawBytes = bytes(stableAfter);
      const snapshotGzipBytes = gzBytes(stableAfter);
      const patchRawBytes = bytes(patch ?? {});
      const patchGzipBytes = gzBytes(patch ?? {});

      const encodeMs = meanMs(() => {
        fmt.encode(mutation.after);
      }, PERF_REPEATS);
      const decodeMs = meanMs(() => {
        fmt.decode(stableAfter as never);
      }, PERF_REPEATS);
      const diffMs = meanMs(() => {
        diff(stableBefore, stableAfter);
      }, PERF_REPEATS);
      const applyMs = meanMs(() => {
        applyMergePatch(stableBefore, patch);
      }, PERF_REPEATS);

      cells.push({
        format: fmt.name,
        operation: opName,
        N,
        snapshotRawBytes,
        snapshotGzipBytes,
        patchRawBytes,
        patchGzipBytes,
        encodeMs,
        decodeMs,
        diffMs,
        applyMs,
      });
      process.stdout.write(
        `  ${fmt.name.padEnd(6)} ${opName.padEnd(18)} N=${String(N).padEnd(5)} ` +
        `snap=${String(snapshotRawBytes).padStart(8)}B/${String(snapshotGzipBytes).padStart(7)}gz  ` +
        `patch=${String(patchRawBytes).padStart(8)}B/${String(patchGzipBytes).padStart(7)}gz  ` +
        `enc=${encodeMs.toFixed(1)}ms dec=${decodeMs.toFixed(1)}ms diff=${diffMs.toFixed(1)}ms apply=${applyMs.toFixed(1)}ms\n`,
      );
    }
  }
}

const outPath = resolve(__dirname, '../results/bench-output.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      perfRepeats: PERF_REPEATS,
      sizes: SIZES,
      operations: OPS.map(([n]) => n),
      formats: ALL_FORMATS.map((f) => f.name),
      cells,
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);
