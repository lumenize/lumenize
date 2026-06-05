import { DurableObject, WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';

// Replicates codemode's ToolDispatcher — an RpcTarget that dispatches
// tool calls from the sandboxed Worker back to the host via RPC.
class CodemodeToolDispatcher extends RpcTarget {
  #fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  constructor(fns: Record<string, (...args: unknown[]) => Promise<unknown>>) {
    super();
    this.#fns = fns;
  }
  async call(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
    try {
      const result = await fn(argsJson ? JSON.parse(argsJson) : {});
      return JSON.stringify({ result });
    } catch (err: any) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ============================================================
// DWL Benchmarks — Measuring isolation overhead
//
// All benchmarks run inside a DO to match the real-world pattern
// (host DO calls out to DWL isolate).
//
// Endpoints:
//   GET /bench/isolate-creation?n=50    — First load vs cached isolate
//   GET /bench/rpc-latency?n=50         — Simple return vs complex object
//   GET /bench/module-loading?n=20      — 1KB vs 100KB vs 500KB modules
//   GET /bench/global-outbound?n=50     — null vs unrestricted
//   GET /bench/codemode?n=20            — DynamicWorkerExecutor vs raw DWL
//   GET /bench/all?n=20                 — Run all benchmarks
// ============================================================

// --- User code strings for benchmarks ---

const CODE_SIMPLE_RETURN = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class Bench extends WorkerEntrypoint {
  ping() { return 'pong'; }
}
export default { async fetch() { return new Response('ok'); } };
`;

const CODE_COMPLEX_RETURN = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class Bench extends WorkerEntrypoint {
  getComplex() {
    return {
      users: Array.from({ length: 100 }, (_, i) => ({
        id: 'user-' + i,
        name: 'User ' + i,
        email: 'user' + i + '@example.com',
        roles: ['reader', 'writer'],
        metadata: { created: '2026-01-01', active: true, score: Math.random() },
      })),
      pagination: { page: 1, total: 1000, hasNext: true },
    };
  }
}
export default { async fetch() { return new Response('ok'); } };
`;

const CODE_WITH_OUTBOUND_NULL = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class Bench extends WorkerEntrypoint {
  ping() { return 'pong'; }
}
export default { async fetch() { return new Response('ok'); } };
`;

// Generate a helper module of approximately the given size in bytes.
// DWL only allows functions/handlers as top-level exports, so we put
// bulk data in a separate helper module that the main module imports.
function generateHelperModule(sizeBytes: number): string {
  const lines: string[] = [];
  let currentSize = 0;
  let i = 0;
  while (currentSize < sizeBytes - 100) {
    const padding = 'x'.repeat(80);
    const line = `export const v${i} = "${padding}";`;
    lines.push(line);
    currentSize += line.length + 1;
    i++;
  }
  return lines.join('\n');
}

const MODULE_LOADING_MAIN = `
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as data from './helper.js';
export class Bench extends WorkerEntrypoint {
  ping() { return 'pong-' + Object.keys(data).length; }
}
export default { async fetch() { return new Response('ok'); } };
`;

// Codemode-compatible user code (plain async function, no imports)
const CODEMODE_USER_CODE = `
const result = await codemode.echo({ message: "hello from sandbox" });
return result;
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
}

function summarize(label: string, timings: number[]): TimingResult {
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
  };
}

// --- The DO that runs benchmarks ---

export class BenchDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const n = parseInt(url.searchParams.get('n') || '20', 10);

    try {
      let results: TimingResult[];

      switch (url.pathname) {
        case '/bench/isolate-creation':
          results = await this.benchIsolateCreation(n);
          break;
        case '/bench/rpc-latency':
          results = await this.benchRpcLatency(n);
          break;
        case '/bench/module-loading':
          results = await this.benchModuleLoading(n);
          break;
        case '/bench/global-outbound':
          results = await this.benchGlobalOutbound(n);
          break;
        case '/bench/codemode':
          results = await this.benchCodemode(n);
          break;
        case '/bench/all':
          results = [
            ...await this.benchIsolateCreation(n),
            ...await this.benchRpcLatency(n),
            ...await this.benchModuleLoading(Math.min(n, 10)),
            ...await this.benchGlobalOutbound(n),
            ...await this.benchCodemode(Math.min(n, 10)),
          ];
          break;
        default:
          return new Response(
            'DWL Benchmarks\n\n' +
            'GET /bench/isolate-creation?n=50\n' +
            'GET /bench/rpc-latency?n=50\n' +
            'GET /bench/module-loading?n=20\n' +
            'GET /bench/global-outbound?n=50\n' +
            'GET /bench/codemode?n=20\n' +
            'GET /bench/all?n=20\n',
            { headers: { 'Content-Type': 'text/plain' } }
          );
      }

      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: e.message,
        stack: e.stack,
      }, null, 2), { status: 500 });
    }
  }

  // Benchmark 1: Isolate creation — first load (unique id) vs cached (same id)
  async benchIsolateCreation(n: number): Promise<TimingResult[]> {
    const coldTimings: number[] = [];
    const warmTimings: number[] = [];

    // Cold: each iteration uses a unique id → forces new isolate
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      const worker = this.env.LOADER.get(`bench-cold-${Date.now()}-${i}`, () => ({
        compatibilityDate: '2025-09-12',
        mainModule: 'main.js',
        modules: { 'main.js': CODE_SIMPLE_RETURN },
      }));
      const ep = worker.getEntrypoint('Bench') as any;
      await ep.ping();
      coldTimings.push(performance.now() - start);
    }

    // Warm: all iterations use the same id → may reuse isolate
    const warmId = 'bench-warm-fixed';
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      const worker = this.env.LOADER.get(warmId, () => ({
        compatibilityDate: '2025-09-12',
        mainModule: 'main.js',
        modules: { 'main.js': CODE_SIMPLE_RETURN },
      }));
      const ep = worker.getEntrypoint('Bench') as any;
      await ep.ping();
      warmTimings.push(performance.now() - start);
    }

    return [
      summarize('isolate-creation-cold (unique id each time)', coldTimings),
      summarize('isolate-creation-warm (same id, may cache)', warmTimings),
    ];
  }

  // Benchmark 2: RPC latency — simple vs complex return value
  async benchRpcLatency(n: number): Promise<TimingResult[]> {
    const simpleTimings: number[] = [];
    const complexTimings: number[] = [];

    // Pre-create workers (use fixed ids so they're warm)
    const simpleWorker = this.env.LOADER.get('bench-rpc-simple', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': CODE_SIMPLE_RETURN },
    }));
    const complexWorker = this.env.LOADER.get('bench-rpc-complex', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': CODE_COMPLEX_RETURN },
    }));

    // Warmup
    const simpleEp = simpleWorker.getEntrypoint('Bench') as any;
    const complexEp = complexWorker.getEntrypoint('Bench') as any;
    await simpleEp.ping();
    await complexEp.getComplex();

    // Simple: returns 'pong' string
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await simpleEp.ping();
      simpleTimings.push(performance.now() - start);
    }

    // Complex: returns nested object with 100 users
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await complexEp.getComplex();
      complexTimings.push(performance.now() - start);
    }

    return [
      summarize('rpc-latency-simple (string return)', simpleTimings),
      summarize('rpc-latency-complex (100 users object)', complexTimings),
    ];
  }

  // Benchmark 3: Module loading — small vs medium vs large module dictionaries
  async benchModuleLoading(n: number): Promise<TimingResult[]> {
    const smallHelper = generateHelperModule(1_000);      // ~1 KB
    const mediumHelper = generateHelperModule(100_000);    // ~100 KB
    const largeHelper = generateHelperModule(500_000);     // ~500 KB

    const sizes = [
      { label: 'module-loading-1KB', helper: smallHelper, sizeKB: Math.round(smallHelper.length / 1024) },
      { label: 'module-loading-100KB', helper: mediumHelper, sizeKB: Math.round(mediumHelper.length / 1024) },
      { label: 'module-loading-500KB', helper: largeHelper, sizeKB: Math.round(largeHelper.length / 1024) },
    ];

    const results: TimingResult[] = [];

    for (const { label, helper, sizeKB } of sizes) {
      const timings: number[] = [];
      for (let i = 0; i < n; i++) {
        // Use unique id each time to force fresh load
        const start = performance.now();
        const worker = this.env.LOADER.get(`${label}-${i}`, () => ({
          compatibilityDate: '2025-09-12',
          mainModule: 'main.js',
          modules: {
            'main.js': MODULE_LOADING_MAIN,
            'helper.js': helper,
          },
        }));
        const ep = worker.getEntrypoint('Bench') as any;
        await ep.ping();
        timings.push(performance.now() - start);
      }
      results.push(summarize(`${label} (${sizeKB}KB actual)`, timings));
    }

    return results;
  }

  // Benchmark 4: globalOutbound: null vs unrestricted
  async benchGlobalOutbound(n: number): Promise<TimingResult[]> {
    const nullTimings: number[] = [];
    const openTimings: number[] = [];

    // With globalOutbound: null
    const nullWorker = this.env.LOADER.get('bench-outbound-null', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': CODE_WITH_OUTBOUND_NULL },
      globalOutbound: null,
    }));

    // Without globalOutbound (unrestricted)
    const openWorker = this.env.LOADER.get('bench-outbound-open', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': CODE_WITH_OUTBOUND_NULL },
    }));

    // Warmup
    const nullEp = nullWorker.getEntrypoint('Bench') as any;
    const openEp = openWorker.getEntrypoint('Bench') as any;
    await nullEp.ping();
    await openEp.ping();

    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await nullEp.ping();
      nullTimings.push(performance.now() - start);
    }

    for (let i = 0; i < n; i++) {
      const start = performance.now();
      await openEp.ping();
      openTimings.push(performance.now() - start);
    }

    return [
      summarize('globalOutbound-null', nullTimings),
      summarize('globalOutbound-unrestricted', openTimings),
    ];
  }

  // Benchmark 5: codemode-style wrapping overhead vs raw DWL
  //
  // We replicate what DynamicWorkerExecutor does internally:
  // 1. Wraps user code in a WorkerEntrypoint with console capture
  // 2. Creates a Proxy for codemode.* tool dispatch
  // 3. Adds setTimeout-based timeout
  // 4. Uses ToolDispatcher (RpcTarget) for tool callbacks
  // 5. Always uses crypto.randomUUID() as id (always cold)
  //
  // Direct import of @cloudflare/codemode fails because zod-to-ts
  // pulls in the TypeScript compiler which uses __filename (CJS).
  // This is itself a noteworthy finding for the blog.
  async benchCodemode(n: number): Promise<TimingResult[]> {
    const rawTimings: number[] = [];
    const wrappedTimings: number[] = [];

    // Raw DWL: cold start, simple ping
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      const worker = this.env.LOADER.get(`bench-raw-cm-${i}`, () => ({
        compatibilityDate: '2025-09-12',
        mainModule: 'main.js',
        modules: { 'main.js': CODE_SIMPLE_RETURN },
      }));
      const ep = worker.getEntrypoint('Bench') as any;
      await ep.ping();
      rawTimings.push(performance.now() - start);
    }

    // Codemode-equivalent: replicate DynamicWorkerExecutor's wrapping pattern.
    // The user code calls codemode.echo() which goes through:
    //   Proxy → RPC to host → ToolDispatcher.call() → echo function → JSON back
    const userCode = 'async function() { return await codemode.echo({ message: "hello" }); }';
    const timeoutMs = 30_000;

    const wrappedModule = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      '',
      'export default class CodeExecutor extends WorkerEntrypoint {',
      '  async evaluate(dispatcher) {',
      '    const __logs = [];',
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      '    const codemode = new Proxy({}, {',
      '      get: (_, toolName) => async (args) => {',
      '        const resJson = await dispatcher.call(String(toolName), JSON.stringify(args ?? {}));',
      '        const data = JSON.parse(resJson);',
      '        if (data.error) throw new Error(data.error);',
      '        return data.result;',
      '      }',
      '    });',
      '',
      '    try {',
      '      const result = await Promise.race([',
      '        (',
      userCode,
      '        )(),',
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
      '      ]);',
      '      return { result, logs: __logs };',
      '    } catch (err) {',
      '      return { result: undefined, error: err.message, logs: __logs };',
      '    }',
      '  }',
      '}',
    ].join('\n');

    // Create a ToolDispatcher-equivalent using RpcTarget
    const dispatcher = new CodemodeToolDispatcher({
      echo: async (input: unknown) => input,
    });

    for (let i = 0; i < n; i++) {
      const start = performance.now();
      const worker = this.env.LOADER.get(`bench-codemode-${crypto.randomUUID()}`, () => ({
        compatibilityDate: '2025-09-12',
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'executor.js',
        modules: { 'executor.js': wrappedModule },
        globalOutbound: null,
      }));
      const result = await (worker.getEntrypoint() as any).evaluate(dispatcher);
      wrappedTimings.push(performance.now() - start);
    }

    return [
      summarize('raw-dwl-cold (baseline)', rawTimings),
      summarize('codemode-equivalent (console+proxy+timeout+RPC dispatch)', wrappedTimings),
    ];
  }
}

// --- Worker entrypoint — routes to DO ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.BENCH_DO.idFromName('bench');
    const stub = env.BENCH_DO.get(id);
    return stub.fetch(request);
  },
};
