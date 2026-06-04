/**
 * Render bench-output.json into Markdown tables suitable for RESULTS.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const input = resolve(__dirname, '../results/bench-output.json');
const output = resolve(__dirname, '../results/tables.md');

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

interface BenchData {
  generatedAt: string;
  node: string;
  perfRepeats: number;
  sizes: number[];
  operations: string[];
  formats: string[];
  cells: Cell[];
}

const data = JSON.parse(readFileSync(input, 'utf8')) as BenchData;

function cellOf(format: string, operation: string, N: number): Cell | undefined {
  return data.cells.find((c) => c.format === format && c.operation === operation && c.N === N);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

const lines: string[] = [];
lines.push(`<!-- Generated from results/bench-output.json on ${data.generatedAt} -->`);
lines.push(`<!-- Node ${data.node}, perf mean of ${data.perfRepeats} runs -->`);
lines.push('');

// Snapshot size table per N
for (const N of data.sizes) {
  lines.push(`### Snapshot size at N=${N}`);
  lines.push('');
  lines.push(`| Format | Raw | Gzipped | vs tuple (raw) | vs tuple (gz) |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  const tupleCell = cellOf('tuple', data.operations[0]!, N)!;
  const tupleRaw = tupleCell.snapshotRawBytes;
  const tupleGz = tupleCell.snapshotGzipBytes;
  for (const f of data.formats) {
    const c = cellOf(f, data.operations[0]!, N)!;
    const rawDelta = ((c.snapshotRawBytes - tupleRaw) / tupleRaw) * 100;
    const gzDelta = ((c.snapshotGzipBytes - tupleGz) / tupleGz) * 100;
    lines.push(
      `| ${f} | ${fmtBytes(c.snapshotRawBytes)} | ${fmtBytes(c.snapshotGzipBytes)} | ${rawDelta >= 0 ? '+' : ''}${rawDelta.toFixed(1)}% | ${gzDelta >= 0 ? '+' : ''}${gzDelta.toFixed(1)}% |`,
    );
  }
  lines.push('');
}

// Patch size per (operation × N)
for (const N of data.sizes) {
  lines.push(`### Patch size at N=${N} (gzipped)`);
  lines.push('');
  lines.push(
    `| Format | ${data.operations.join(' | ')} |`,
  );
  lines.push(
    `|---|${data.operations.map(() => '---:').join('|')}|`,
  );
  for (const f of data.formats) {
    const cells = data.operations.map((op) => {
      const c = cellOf(f, op, N)!;
      return fmtBytes(c.patchGzipBytes);
    });
    lines.push(`| ${f} | ${cells.join(' | ')} |`);
  }
  lines.push('');
}

// Perf table at N=10000
{
  const N = 10000;
  lines.push(`### Encode / decode / patch perf at N=${N} (ms, mean over ${data.perfRepeats} runs)`);
  lines.push('');
  lines.push(`| Format | Operation | Encode | Decode | Diff | Apply |`);
  lines.push(`|---|---|---:|---:|---:|---:|`);
  for (const f of data.formats) {
    for (const op of data.operations) {
      const c = cellOf(f, op, N)!;
      lines.push(
        `| ${f} | ${op} | ${c.encodeMs.toFixed(1)} | ${c.decodeMs.toFixed(1)} | ${c.diffMs.toFixed(1)} | ${c.applyMs.toFixed(1)} |`,
      );
    }
  }
}

writeFileSync(output, lines.join('\n') + '\n');
console.log(`Wrote ${output}`);
