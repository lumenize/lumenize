#!/usr/bin/env node
/**
 * Generate TypeScript schema files of varying sizes and benchmark tsgo --noEmit.
 *
 * This simulates the Nebula use case: vibe-coders define TypeScript types
 * (resource schemas, guard contracts) that need to be type-checked before
 * being accepted. The question is how long tsgo takes for 10, 100, and 1000 types.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, 'schemas');
const TSGO = join(__dirname, 'node_modules', '.bin', 'tsgo');
const ITERATIONS = 5;

// Generate a realistic-looking TypeScript type (not just padding)
function generateType(i) {
  return `
export interface Resource${i} {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  metadata: Resource${i}Metadata;
  tags: string[];
  status: 'active' | 'inactive' | 'pending';
}

export interface Resource${i}Metadata {
  version: number;
  author: string;
  description?: string;
  config: Resource${i}Config;
}

export interface Resource${i}Config {
  debounceMs: number;
  history: boolean;
  maxSize: number;
  permissions: Record<string, 'read' | 'write' | 'admin'>;
}

export type Resource${i}Event =
  | { type: 'created'; payload: Resource${i} }
  | { type: 'updated'; payload: Partial<Resource${i}> & { id: string } }
  | { type: 'deleted'; payload: { id: string } };

export function validateResource${i}(input: unknown): input is Resource${i} {
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.name === 'string';
}
`;
}

// Generate a file that imports and uses all types (to force full checking)
function generateIndex(count) {
  const imports = [];
  const uses = [];
  for (let i = 0; i < count; i++) {
    imports.push(`import type { Resource${i}, Resource${i}Event } from './type${i}';`);
    uses.push(`  Resource${i} | Resource${i}Event`);
  }
  return `${imports.join('\n')}

export type AllResources =
${uses.join(' |\n')};

export type AllResourceIds = AllResources extends { id: string } ? AllResources['id'] : never;
`;
}

function generateTsconfig() {
  return JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['*.ts'],
  }, null, 2);
}

function setupSchemas(count) {
  const dir = join(SCHEMAS_DIR, `types-${count}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });

  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `type${i}.ts`), generateType(i));
  }
  writeFileSync(join(dir, 'index.ts'), generateIndex(count));
  writeFileSync(join(dir, 'tsconfig.json'), generateTsconfig());
  return dir;
}

function benchmarkTsgo(dir, label) {
  const timings = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      execSync(`${TSGO} --noEmit`, { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      // tsgo may report errors for our generated code; we care about timing
      // Check if it's a genuine crash vs type errors
      if (e.status > 1) {
        console.error(`  ${label} iteration ${i}: tsgo crashed (exit ${e.status})`);
        console.error(e.stderr?.toString().slice(0, 200));
        return null;
      }
    }
    timings.push(performance.now() - start);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label,
    iterations: ITERATIONS,
    timingsMs: sorted.map(t => Math.round(t)),
    meanMs: Math.round(sum / sorted.length),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

// Also benchmark standard tsc for comparison
function benchmarkTsc(dir, label) {
  const timings = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      execSync(`npx tsc --noEmit`, { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      if (e.status > 1) {
        console.error(`  ${label} iteration ${i}: tsc crashed (exit ${e.status})`);
        return null;
      }
    }
    timings.push(performance.now() - start);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label,
    iterations: ITERATIONS,
    timingsMs: sorted.map(t => Math.round(t)),
    meanMs: Math.round(sum / sorted.length),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

// --- Main ---

console.log('tsgo benchmark: TypeScript type-checking at different schema sizes');
console.log(`tsgo version: ${execSync(`${TSGO} --version`, { encoding: 'utf8' }).trim()}`);
console.log(`Iterations per size: ${ITERATIONS}\n`);

const sizes = [10, 100, 1000];
const results = [];

for (const count of sizes) {
  console.log(`Setting up ${count} types...`);
  const dir = setupSchemas(count);

  const fileCount = count + 2; // type files + index.ts + tsconfig.json
  const dirSize = execSync(`du -sh ${dir}`, { encoding: 'utf8' }).trim().split('\t')[0];
  console.log(`  ${fileCount} files, ${dirSize} on disk`);

  console.log(`  Benchmarking tsgo --noEmit (${count} types)...`);
  const tsgoResult = benchmarkTsgo(dir, `tsgo-${count}-types`);
  if (tsgoResult) {
    results.push(tsgoResult);
    console.log(`  tsgo: median ${tsgoResult.medianMs}ms, mean ${tsgoResult.meanMs}ms`);
  }
}

console.log('\n--- Results ---');
console.log(JSON.stringify(results, null, 2));
