// worker-bundler import removed — proven to exceed resource limits deployed.
// Spike endpoints (/spike/*) are dead code; kept for reference.
// import { createWorker } from '@cloudflare/worker-bundler';
const createWorker = (..._args: any[]): any => { throw new Error('worker-bundler removed from deploy'); };

// Pre-bundled tsc — text module (for DW module strings)
import tscBundleCode from '../dist/typescript.min.bundle';
import libMinimalDts from '../dist/lib.minimal.bundle';
// Pre-bundled tsc — JS module (for in-process use, no DW)
// @ts-expect-error — no declaration file for minified tsc bundle
import ts from '../dist/typescript.min.mjs';

// ============================================================
// Spike: Dynamic Worker Bundler
//
// Question: Can @cloudflare/worker-bundler bundle `typescript`
// (~10 MB npm package) at runtime inside a Worker?
//
// Option A: worker-bundler resolves typescript from npm
// Option B (fallback): worker-bundler compiles TS only,
//   we provide pre-bundled tsc as a text module
//
// Endpoints:
//   GET /spike/cold?n=3      — Cold start: bundler + tsc load + first check
//   GET /spike/warm?n=20     — Warm: repeated checks, same DW
//   GET /spike/bundler-timing — Just the createWorker() bundler step
//   GET /spike/e2e           — End-to-end validation examples
//   GET /spike/all?n=5       — Run all benchmarks
// ============================================================

// --- DW checker module source (TypeScript — bundler compiles it) ---

const VALIDATOR_SOURCE = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import ts from 'typescript';

// Module-scoped state — persists across calls in the same DW isolate
let cachedProgram: any = null;
let fileMap = new Map<string, string>();
let host: any = null;
let firstCallDone = false;

// Minimal lib.d.ts — just enough for type checking
const LIB_DTS = [
  'interface Array<T> { length: number; [n: number]: T; push(...items: T[]): number; map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[]; filter(predicate: (value: T) => boolean): T[]; }',
  'interface String { length: number; charAt(pos: number): string; }',
  'interface Number { toFixed(fractionDigits?: number): string; }',
  'interface Boolean {}',
  'interface Object {}',
  'interface Function {}',
  'interface RegExp {}',
  'interface IArguments {}',
  'interface Record<K extends string | number | symbol, V> { [key: string]: V; }',
  'declare type Partial<T> = { [P in keyof T]?: T[P]; };',
  'declare type Required<T> = { [P in keyof T]-?: T[P]; };',
  'declare type Readonly<T> = { readonly [P in keyof T]: T[P]; };',
  'declare type Pick<T, K extends keyof T> = { [P in K]: T[P]; };',
  'declare type Omit<T, K extends string | number | symbol> = Pick<T, Exclude<keyof T, K>>;',
  'declare type Exclude<T, U> = T extends U ? never : T;',
  'declare type Extract<T, U> = T extends U ? T : never;',
].join('\\n');

fileMap.set('lib.d.ts', LIB_DTS);

function createVirtualHost(files: Map<string, string>) {
  return {
    getSourceFile(fileName: string, languageVersion: any) {
      const content = files.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
      return undefined;
    },
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f: string) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\\n',
    fileExists: (f: string) => files.has(f),
    readFile: (f: string) => files.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
}

const compilerOptions: any = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  skipLibCheck: true,
};

export class TscChecker extends WorkerEntrypoint {
  check(typeDefinitions: string, objectLiteral: string, typeName: string, useReuse: boolean) {
    const code = typeDefinitions + '\\nconst __validate: ' + typeName + ' = ' + objectLiteral + ';';
    fileMap.set('check.ts', code);

    if (!host) {
      host = createVirtualHost(fileMap);
    }

    const createStart = performance.now();
    let program: any;
    if (useReuse && cachedProgram) {
      program = ts.createProgram(['check.ts'], compilerOptions, host, cachedProgram);
    } else {
      program = ts.createProgram(['check.ts'], compilerOptions, host);
    }
    const createTime = performance.now() - createStart;

    if (useReuse) {
      cachedProgram = program;
    }

    const diagStart = performance.now();
    const sourceFile = program.getSourceFile('check.ts');
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
    const diagTime = performance.now() - diagStart;

    const errors = diagnostics.map((d: any) => ({
      message: ts.flattenDiagnosticMessageText(d.messageText, '\\n'),
      code: d.code,
      category: d.category,
    }));

    const isFirstCall = !firstCallDone;
    firstCallDone = true;

    return {
      isFirstCall,
      createProgramMs: Math.round(createTime * 100) / 100,
      diagnosticsMs: Math.round(diagTime * 100) / 100,
      totalMs: Math.round((createTime + diagTime) * 100) / 100,
      errorCount: errors.length,
      errors,
      reused: useReuse && cachedProgram !== null,
      tsVersion: ts.version,
    };
  }

  ping() {
    return { ok: true, tsVersion: ts.version };
  }
}

export default { async fetch() { return new Response('ok'); } };
`;

// --- Timing utility ---

interface TimingResult {
  label: string;
  iterations: number;
  timingsMs: number[];
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  extra?: Record<string, unknown>;
}

function summarize(label: string, timings: number[], extra?: Record<string, unknown>): TimingResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label,
    iterations: sorted.length,
    timingsMs: sorted.map(t => Math.round(t * 100) / 100),
    meanMs: Math.round((sum / sorted.length) * 100) / 100,
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    extra,
  };
}

// --- Test fixtures ---

const SIMPLE_TYPES = `
interface Todo {
  title: string;
  done: boolean;
  priority?: number;
}
`;

const VALID_LITERAL = `{ title: "Fix bug", done: false, priority: 1 }`;
const INVALID_LITERAL = `{ title: 42, done: "yes" }`;

const COMPLEX_TYPES = `
interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
}

interface ContactInfo {
  email: string;
  phone?: string;
  address: Address;
}

type Role = "admin" | "editor" | "viewer";

interface User {
  id: string;
  name: string;
  role: Role;
  contact: ContactInfo;
  tags: string[];
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
  active: boolean;
}
`;

const VALID_USER = `{
  id: "user-1",
  name: "Alice",
  role: "admin",
  contact: {
    email: "alice@example.com",
    phone: "+1234567890",
    address: { street: "123 Main St", city: "Springfield", state: "IL", zip: "62701" }
  },
  tags: ["team-lead", "engineering"],
  metadata: { department: "eng", level: 5, remote: true },
  createdAt: "2026-01-15T10:30:00Z",
  active: true
}`;

const INVALID_USER = `{
  id: 123,
  name: "Alice",
  role: "superadmin",
  contact: { email: "alice@example.com", address: { street: "123 Main St", city: "Springfield" } },
  tags: "not-an-array",
  metadata: {},
  createdAt: "2026-01-15T10:30:00Z",
  active: true
}`;

// --- Pre-bundled DW checker code (from tsc-dwl-spike) ---

const TSC_CHECKER_CODE = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import ts from './typescript.min.js';
import libDts from './lib-text.js';

let cachedProgram = null;
let fileMap = new Map();
let host = null;
let firstCallDone = false;

fileMap.set('lib.d.ts', libDts);

function createVirtualHost(files) {
  return {
    getSourceFile(fileName, languageVersion) {
      const content = files.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion, true);
      }
      return undefined;
    },
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\\n',
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
}

const compilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  skipLibCheck: true,
};

export class TscChecker extends WorkerEntrypoint {
  check(typeDefinitions, objectLiteral, typeName, useReuse) {
    const code = typeDefinitions + '\\nconst __validate: ' + typeName + ' = ' + objectLiteral + ';';
    fileMap.set('check.ts', code);

    if (!host) {
      host = createVirtualHost(fileMap);
    }

    const createStart = performance.now();
    let program;
    if (useReuse && cachedProgram) {
      program = ts.createProgram(['check.ts'], compilerOptions, host, cachedProgram);
    } else {
      program = ts.createProgram(['check.ts'], compilerOptions, host);
    }
    const createTime = performance.now() - createStart;

    if (useReuse) {
      cachedProgram = program;
    }

    const diagStart = performance.now();
    const sourceFile = program.getSourceFile('check.ts');
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);
    const diagTime = performance.now() - diagStart;

    const errors = diagnostics.map(d => ({
      message: ts.flattenDiagnosticMessageText(d.messageText, '\\n'),
      code: d.code,
      category: d.category,
    }));

    const isFirstCall = !firstCallDone;
    firstCallDone = true;

    return {
      isFirstCall,
      createProgramMs: Math.round(createTime * 100) / 100,
      diagnosticsMs: Math.round(diagTime * 100) / 100,
      totalMs: Math.round((createTime + diagTime) * 100) / 100,
      errorCount: errors.length,
      errors,
      reused: useReuse && cachedProgram !== null,
      tsVersion: ts.version,
    };
  }

  ping() {
    return { ok: true, tsVersion: ts.version };
  }
}

export default { async fetch() { return new Response('ok'); } };
`;

// --- Helper: create or get the DW with worker-bundler ---

async function getChecker(env: Env, id: string) {
  const worker = env.LOADER.get(id, async () => {
    const { mainModule, modules } = await createWorker({
      entryPoint: 'src/validator.ts',
      minify: true,
      files: {
        'src/validator.ts': VALIDATOR_SOURCE,
        'package.json': JSON.stringify({
          dependencies: { typescript: '^5.9.2' },
        }),
      },
    });
    return {
      mainModule,
      modules,
      compatibilityDate: '2026-03-12',
      globalOutbound: null,
    };
  });
  return worker.getEntrypoint('TscChecker') as any;
}

// --- Helper: create or get the DW with pre-bundled tsc ---

function getCheckerPreBundled(env: Env, id: string) {
  const worker = env.LOADER.get(id, () => ({
    compatibilityDate: '2026-03-12',
    mainModule: 'checker.js',
    modules: {
      'checker.js': TSC_CHECKER_CODE,
      'typescript.min.js': tscBundleCode,
      'lib-text.js': `export default ${JSON.stringify(libMinimalDts)};`,
    },
    globalOutbound: null,
  }));
  return worker.getEntrypoint('TscChecker') as any;
}

// --- In-process tsc checker (no DW) ---

let inProcessProgram: any = null;
const inProcessFileMap = new Map<string, string>();
inProcessFileMap.set('lib.d.ts', libMinimalDts);

let inProcessHost: any = null;

function createInProcessHost() {
  return {
    getSourceFile(fileName: string, languageVersion: any) {
      const content = inProcessFileMap.get(fileName);
      if (content !== undefined) {
        return (ts as any).createSourceFile(fileName, content, languageVersion, true);
      }
      return undefined;
    },
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f: string) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (f: string) => inProcessFileMap.has(f),
    readFile: (f: string) => inProcessFileMap.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
}

const inProcessOptions = {
  strict: true,
  noEmit: true,
  target: (ts as any).ScriptTarget.ESNext,
  module: (ts as any).ModuleKind.ESNext,
  skipLibCheck: true,
};

function inProcessCheck(typeDefinitions: string, objectLiteral: string, typeName: string) {
  const code = typeDefinitions + '\nconst __validate: ' + typeName + ' = ' + objectLiteral + ';';
  inProcessFileMap.set('check.ts', code);

  if (!inProcessHost) {
    inProcessHost = createInProcessHost();
  }

  const program = (ts as any).createProgram(['check.ts'], inProcessOptions, inProcessHost, inProcessProgram);
  inProcessProgram = program;

  const sourceFile = program.getSourceFile('check.ts');
  const diagnostics = (ts as any).getPreEmitDiagnostics(program, sourceFile);

  const errors = diagnostics.map((d: any) => ({
    message: (ts as any).flattenDiagnosticMessageText(d.messageText, '\n'),
    code: d.code,
    category: d.category,
  }));

  return { errorCount: errors.length, errors, tsVersion: (ts as any).version };
}

function inProcessE2E(): unknown {
  return {
    validTodo: inProcessCheck(SIMPLE_TYPES, VALID_LITERAL, 'Todo'),
    invalidTodo: inProcessCheck(SIMPLE_TYPES, INVALID_LITERAL, 'Todo'),
    validUser: inProcessCheck(COMPLEX_TYPES, VALID_USER, 'User'),
    invalidUser: inProcessCheck(COMPLEX_TYPES, INVALID_USER, 'User'),
    missingFields: inProcessCheck(SIMPLE_TYPES, `{ title: "hello" }`, 'Todo'),
    extraFields: inProcessCheck(SIMPLE_TYPES, `{ title: "hello", done: true, extra: "nope" }`, 'Todo'),
  };
}

// --- Plain Worker (Service Binding) benchmark implementations ---

async function workerCheck(env: Env): Promise<unknown> {
  const checker = (env as any).TSC_CHECKER;
  return await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo');
}

async function workerWarm(env: Env, n: number): Promise<unknown[]> {
  const checker = (env as any).TSC_CHECKER;
  const results: unknown[] = [];
  for (let i = 0; i < n; i++) {
    results.push(await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo'));
  }
  return results;
}

async function workerE2E(env: Env): Promise<unknown> {
  const checker = (env as any).TSC_CHECKER;
  const validTodo = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo');
  const invalidTodo = await checker.check(SIMPLE_TYPES, INVALID_LITERAL, 'Todo');
  const validUser = await checker.check(COMPLEX_TYPES, VALID_USER, 'User');
  const invalidUser = await checker.check(COMPLEX_TYPES, INVALID_USER, 'User');
  const missingFields = await checker.check(SIMPLE_TYPES, `{ title: "hello" }`, 'Todo');
  const extraFields = await checker.check(SIMPLE_TYPES, `{ title: "hello", done: true, extra: "nope" }`, 'Todo');
  return { validTodo, invalidTodo, validUser, invalidUser, missingFields, extraFields };
}

// --- Pre-bundled benchmark implementations ---

async function preBundledCold(env: Env): Promise<unknown> {
  const id = `pre-cold-${Date.now()}`;
  const checker = getCheckerPreBundled(env, id);
  const result = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', false);
  return { label: 'pre-bundled cold (tsc load + check)', result };
}

async function preBundledWarm(env: Env, n: number): Promise<TimingResult[]> {
  const warmId = 'pre-warm-fixed';
  const checker = getCheckerPreBundled(env, warmId);

  const warmupResult = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true);
  const firstCallResult = warmupResult;

  const results: unknown[] = [];
  for (let i = 0; i < n; i++) {
    results.push(await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true));
  }

  return [
    { label: 'pre-bundled first-call', iterations: 1, timingsMs: [0], meanMs: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0, extra: { result: firstCallResult } } as TimingResult,
    { label: 'pre-bundled steady-state', iterations: n, timingsMs: [], meanMs: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0, extra: { sampleResult: results[0] } } as TimingResult,
  ];
}

async function preBundledE2E(env: Env): Promise<unknown> {
  const checkerId = 'pre-e2e';
  const checker = getCheckerPreBundled(env, checkerId);

  const validTodo = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true);
  const invalidTodo = await checker.check(SIMPLE_TYPES, INVALID_LITERAL, 'Todo', true);
  const validUser = await checker.check(COMPLEX_TYPES, VALID_USER, 'User', true);
  const invalidUser = await checker.check(COMPLEX_TYPES, INVALID_USER, 'User', true);
  const missingFields = await checker.check(SIMPLE_TYPES, `{ title: "hello" }`, 'Todo', true);
  const extraFields = await checker.check(
    SIMPLE_TYPES,
    `{ title: "hello", done: true, extra: "nope" }`,
    'Todo',
    true,
  );

  return { validTodo, invalidTodo, validUser, invalidUser, missingFields, extraFields };
}

// --- Bundler benchmark implementations ---

async function benchCold(env: Env): Promise<unknown> {
  // Single cold start per request — client measures wall-clock and calls N times
  const id = `bundler-cold-${Date.now()}`;

  const start = performance.now();
  const checker = await getChecker(env, id);
  const result = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', false);
  const totalMs = performance.now() - start;

  return {
    label: 'cold-start (bundler + tsc load + check)',
    internalMs: Math.round(totalMs * 100) / 100,
    result,
  };
}

async function benchWarm(env: Env, n: number): Promise<TimingResult[]> {
  const warmId = 'bundler-warm-fixed';
  const checker = await getChecker(env, warmId);

  // First call warms the isolate
  const warmupStart = performance.now();
  const warmupResult = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true);
  const warmupTime = performance.now() - warmupStart;

  // Steady-state
  const timings: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true);
    timings.push(performance.now() - start);
  }

  return [
    summarize('warm-first-call (includes tsc load in DW)', [warmupTime], { result: warmupResult }),
    summarize('warm-steady-state (reuse, simple types)', timings),
  ];
}

async function benchBundlerTiming(env: Env): Promise<unknown> {
  // Single createWorker() call — minified (what we'd use in production)
  const start = performance.now();
  const { mainModule, modules } = await createWorker({
    entryPoint: 'src/validator.ts',
    minify: true,
    files: {
      'src/validator.ts': VALIDATOR_SOURCE,
      'package.json': JSON.stringify({
        dependencies: { typescript: '^5.9.2' },
      }),
    },
  });
  const bundleMs = performance.now() - start;

  const moduleSizes: Record<string, number> = {};
  let totalBytes = 0;
  for (const [name, content] of Object.entries(modules)) {
    const size = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    moduleSizes[name] = size;
    totalBytes += size;
  }

  return {
    bundleMs: Math.round(bundleMs * 100) / 100,
    mainModule,
    moduleCount: Object.keys(modules).length,
    moduleSizes,
    totalBytes,
    totalMB: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
  };
}

async function benchE2E(env: Env): Promise<unknown> {
  const checkerId = 'bundler-e2e';
  const checker = await getChecker(env, checkerId);

  const validTodo = await checker.check(SIMPLE_TYPES, VALID_LITERAL, 'Todo', true);
  const invalidTodo = await checker.check(SIMPLE_TYPES, INVALID_LITERAL, 'Todo', true);
  const validUser = await checker.check(COMPLEX_TYPES, VALID_USER, 'User', true);
  const invalidUser = await checker.check(COMPLEX_TYPES, INVALID_USER, 'User', true);
  const missingFields = await checker.check(SIMPLE_TYPES, `{ title: "hello" }`, 'Todo', true);
  const extraFields = await checker.check(
    SIMPLE_TYPES,
    `{ title: "hello", done: true, extra: "nope" }`,
    'Todo',
    true,
  );

  return { validTodo, invalidTodo, validUser, invalidUser, missingFields, extraFields };
}

// --- Worker entrypoint ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const n = parseInt(url.searchParams.get('n') || '5', 10);

    try {
      let results: unknown;

      switch (url.pathname) {
        // --- Baseline: pure network round-trip ---
        case '/ping':
          results = { ok: true };
          break;

        // --- In-process tsc (no DW) ---
        case '/inprocess/check':
          results = inProcessCheck(SIMPLE_TYPES, VALID_LITERAL, 'Todo');
          break;
        case '/inprocess/e2e':
          results = inProcessE2E();
          break;

        // --- Plain Worker (Service Binding) endpoints ---
        case '/worker/check':
          results = await workerCheck(env);
          break;
        case '/worker/warm':
          results = await workerWarm(env, n);
          break;
        case '/worker/e2e':
          results = await workerE2E(env);
          break;

        // --- Pre-bundled DW endpoints ---
        case '/prebundled/cold':
          results = await preBundledCold(env);
          break;
        case '/prebundled/warm':
          results = await preBundledWarm(env, n);
          break;
        case '/prebundled/e2e':
          results = await preBundledE2E(env);
          break;

        // --- worker-bundler endpoints (experimental) ---
        case '/spike/cold':
          results = await benchCold(env);
          break;
        case '/spike/warm':
          results = await benchWarm(env, n);
          break;
        case '/spike/bundler-timing':
          results = await benchBundlerTiming(env);
          break;
        case '/spike/e2e':
          results = await benchE2E(env);
          break;

        default:
          return new Response(
            'dw-bundler-spike\n\n' +
            'GET /ping                  — Pure network round-trip\n\n' +
            '=== In-process tsc (no DW, no Service Binding) ===\n' +
            'GET /inprocess/check       — Single check, tsc in parent Worker\n' +
            'GET /inprocess/e2e         — 6 validations, tsc in parent Worker\n\n' +
            '=== Plain Worker (Service Binding RPC) ===\n' +
            'GET /worker/check          — Single check via Service Binding\n' +
            'GET /worker/warm?n=5       — Repeated checks via Service Binding\n' +
            'GET /worker/e2e            — 6 validations via Service Binding\n\n' +
            '=== Pre-bundled DW ===\n' +
            'GET /prebundled/cold       — Cold: load pre-bundled tsc in DW\n' +
            'GET /prebundled/warm?n=5   — Warm: repeated checks, same DW\n' +
            'GET /prebundled/e2e        — 6 validations via DW\n',
            { headers: { 'Content-Type': 'text/plain' } },
          );
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: e.message, stack: e.stack }, null, 2),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};
