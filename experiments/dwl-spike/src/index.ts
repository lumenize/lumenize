import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { preprocess, postprocess } from '@lumenize/structured-clone';
// @ts-ignore — wrangler bundles this as a text module
import MESH_BUNDLE from '../mesh-bundle.txt';

// ============================================================
// DWL Spike — Can a DO call out to a DWL isolate's WorkerEntrypoint?
//
// Experiments:
//   GET /test1  — Basic: DO calls DWL isolate's fetch()
//   GET /test2  — RPC: DO calls DWL isolate's WorkerEntrypoint method via ctx.exports proxy
//   GET /test3  — Direct: DO gets DWL stub and calls getEntrypoint() RPC method
//   GET /test4  — Bonus: Pass DO namespace binding into DWL env directly
//   GET /test5  — LumenizeWorker: DWL extends LumenizeWorker from bundled mesh
//   GET /test6  — Mesh call: DO calls DWL via lmz-style envelope
// ============================================================

// --- The user's DWL code (simulating what a vibe coder would provide as a string) ---

const USER_CODE_BASIC = `
export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({
      message: "Hello from DWL isolate!",
      hasEnv: !!env,
      envKeys: Object.keys(env),
    }));
  }
};
`;

// DWL code that exports a WorkerEntrypoint with methods
const USER_CODE_ENTRYPOINT = `
import { WorkerEntrypoint } from 'cloudflare:workers';

export class UserConfig extends WorkerEntrypoint {
  async getResourceConfig() {
    return {
      content: { debounceMs: 3_600_000, history: true },
      presence: { history: false },
    };
  }

  async guard(operation, resourceType, resourceId) {
    // Simulate a guard that checks operation type
    if (operation === 'delete' && resourceType === 'content') {
      return { allowed: false, reason: 'Cannot delete content' };
    }
    return { allowed: true };
  }

  async validate(resourceType, value) {
    if (resourceType === 'content' && !value.title) {
      return { valid: false, error: 'title is required' };
    }
    return { valid: true };
  }
}

export default {
  async fetch(request, env) {
    return new Response("DWL with entrypoint active");
  }
};
`;

// DWL code that tries to use a DO namespace binding passed in env
const USER_CODE_WITH_DO_BINDING = `
export default {
  async fetch(request, env) {
    try {
      // Try to use the DO namespace binding
      const id = env.SPIKE_DO.idFromName('test-from-dwl');
      const stub = env.SPIKE_DO.get(id);
      const response = await stub.fetch(new Request('http://fake/ping'));
      const text = await response.text();
      return new Response(JSON.stringify({
        success: true,
        doResponse: text,
        message: "DWL successfully called DO via namespace binding!"
      }));
    } catch (e) {
      return new Response(JSON.stringify({
        success: false,
        error: e.message,
        errorType: e.constructor.name,
        message: "DWL could NOT use DO namespace binding"
      }));
    }
  }
};
`;

// DWL code that extends LumenizeWorker from the bundled mesh module
const USER_CODE_LUMENIZE_WORKER = `
import { LumenizeWorker } from './mesh-bundle.js';

// Mark methods as mesh-callable using the global symbol
const MESH_CALLABLE = Symbol.for('lumenize.mesh.callable');

export class MyApp extends LumenizeWorker {
  getResourceConfig() {
    return {
      content: { debounceMs: 3_600_000, history: true },
      presence: { history: false },
    };
  }

  testLmzAccess() {
    // Test that this.lmz exists and has expected shape
    // Note: callContext throws outside of a mesh call — wrap in try/catch
    let callContextResult;
    try {
      callContextResult = { available: true, value: this.lmz.callContext };
    } catch (e) {
      callContextResult = { available: false, error: e.message };
    }
    return {
      hasLmz: !!this.lmz,
      type: this.lmz?.type,
      bindingName: this.lmz?.bindingName,
      callContext: callContextResult,
    };
  }

  testCtn() {
    // Test that this.ctn() works (continuation proxy)
    try {
      const chain = this.ctn();
      return {
        hasCtn: true,
        ctnType: typeof chain,
      };
    } catch (e) {
      return {
        hasCtn: false,
        error: e.message,
      };
    }
  }

  // This method is mesh-callable — will be called via __executeOperation
  getCallContextInfo() {
    const ctx = this.lmz.callContext;
    return {
      hasCallContext: true,
      originAuth: ctx.originAuth,
      callChainLength: ctx.callChain?.length,
      callerType: ctx.callChain?.[0]?.type,
      callerBinding: ctx.callChain?.[0]?.bindingName,
    };
  }

  // Guard test — reads originAuth claims
  runGuardCheck(operation, resourceType) {
    const ctx = this.lmz.callContext;
    const role = ctx.originAuth?.claims?.role;
    if (operation === 'upsert' && resourceType === 'settings' && role !== 'admin') {
      return { allowed: false, reason: 'Admin only for settings upsert', role };
    }
    return { allowed: true, role };
  }
}

// Mark methods as mesh-callable (since we can't use @mesh decorator in plain JS)
MyApp.prototype.getResourceConfig[MESH_CALLABLE] = true;
MyApp.prototype.testLmzAccess[MESH_CALLABLE] = true;
MyApp.prototype.testCtn[MESH_CALLABLE] = true;
MyApp.prototype.getCallContextInfo[MESH_CALLABLE] = true;
MyApp.prototype.runGuardCheck[MESH_CALLABLE] = true;

export default {
  async fetch(request, env) {
    return new Response("DWL with LumenizeWorker active");
  }
};
`;

// --- Proxy WorkerEntrypoint exposed to DWL via ctx.exports ---

export class DOProxy extends WorkerEntrypoint {
  async ping() {
    return 'pong from DOProxy';
  }

  async echo(msg: string) {
    return `DOProxy echoed: ${msg}`;
  }
}

// --- The Durable Object that calls out to DWL ---

export class SpikeDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      return new Response('pong from SpikeDO');
    }

    try {
      switch (url.pathname) {
        case '/test1':
          return await this.test1BasicDWL();
        case '/test2':
          return await this.test2RpcViaProxy();
        case '/test3':
          return await this.test3DirectEntrypoint();
        case '/test4':
          return await this.test4DoBindingInDwl();
        case '/test5':
          return await this.test5LumenizeWorker();
        case '/test6':
          return await this.test6MeshEnvelope();
        default:
          return new Response('Unknown test. Try /test1 through /test6', { status: 404 });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: e.message,
        stack: e.stack,
        type: e.constructor.name,
      }, null, 2), { status: 500 });
    }
  }

  // Test 1: Basic — DO spawns DWL, calls fetch() via default entrypoint
  async test1BasicDWL(): Promise<Response> {
    const worker = this.env.LOADER.get('test1-basic', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': USER_CODE_BASIC },
    }));

    // LOADER.get() returns a WorkerStub — use getEntrypoint() then fetch()
    const entrypoint = worker.getEntrypoint() as any;
    const response = await entrypoint.fetch(new Request('http://fake/'));
    const data = await response.json();
    return new Response(JSON.stringify({ test: 'test1-basic-dwl', result: data }, null, 2));
  }

  // Test 2: RPC via ctx.exports proxy — DO exposes a WorkerEntrypoint, DWL calls it
  // (This tests the REVERSE direction — DWL calling back to host — which we don't need,
  //  but it validates ctx.exports works)
  async test2RpcViaProxy(): Promise<Response> {
    // Note: ctx.exports requires the 'enable_ctx_exports' compat flag
    // For now, test if LOADER.get() accepts env with service bindings
    const worker = this.env.LOADER.get('test2-proxy', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': USER_CODE_BASIC },
      env: {
        GREETING: 'Hello from host DO!',
      },
    }));

    const entrypoint = worker.getEntrypoint() as any;
    const response = await entrypoint.fetch(new Request('http://fake/'));
    const data = await response.json();
    return new Response(JSON.stringify({ test: 'test2-rpc-via-proxy', result: data }, null, 2));
  }

  // Test 3: Direct entrypoint — DWL exports WorkerEntrypoint, DO calls its methods
  // THIS IS THE CRITICAL TEST for our architecture
  async test3DirectEntrypoint(): Promise<Response> {
    const worker = this.env.LOADER.get('test3-entrypoint', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': USER_CODE_ENTRYPOINT },
    }));

    // Try calling methods on the DWL's named entrypoint
    const entrypoint = worker.getEntrypoint('UserConfig') as any;

    const config = await entrypoint.getResourceConfig();
    const guardResult = await entrypoint.guard('delete', 'content', 'doc-1');
    const guardAllow = await entrypoint.guard('read', 'content', 'doc-1');
    const validateFail = await entrypoint.validate('content', { body: 'no title' });
    const validatePass = await entrypoint.validate('content', { title: 'Good', body: 'Has title' });

    return new Response(JSON.stringify({
      test: 'test3-direct-entrypoint',
      results: {
        resourceConfig: config,
        guardReject: guardResult,
        guardAllow: guardAllow,
        validateFail: validateFail,
        validatePass: validatePass,
      }
    }, null, 2));
  }

  // Test 4: Bonus — pass DO namespace binding directly into DWL env
  async test4DoBindingInDwl(): Promise<Response> {
    const worker = this.env.LOADER.get('test4-do-binding', () => ({
      compatibilityDate: '2025-09-12',
      mainModule: 'main.js',
      modules: { 'main.js': USER_CODE_WITH_DO_BINDING },
      env: {
        SPIKE_DO: this.env.SPIKE_DO,  // Pass the DO namespace binding through
      },
    }));

    const entrypoint = worker.getEntrypoint() as any;
    const response = await entrypoint.fetch(new Request('http://fake/'));
    const data = await response.json();
    return new Response(JSON.stringify({ test: 'test4-do-binding-in-dwl', result: data }, null, 2));
  }

  // Test 5: LumenizeWorker — DWL extends LumenizeWorker from bundled mesh module
  // THIS IS THE CRITICAL TEST for Mesh integration
  async test5LumenizeWorker(): Promise<Response> {
    const worker = this.env.LOADER.get('test5-lumenize-worker', () => ({
      compatibilityDate: '2025-09-12',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'main.js',
      modules: {
        'main.js': USER_CODE_LUMENIZE_WORKER,
        'mesh-bundle.js': MESH_BUNDLE,
      },
    }));

    const entrypoint = worker.getEntrypoint('MyApp') as any;

    // Test 5a: Can we call a simple method?
    const config = await entrypoint.getResourceConfig();

    // Test 5b: Does this.lmz exist and have the expected shape?
    const lmzAccess = await entrypoint.testLmzAccess();

    // Test 5c: Does this.ctn() work?
    const ctnTest = await entrypoint.testCtn();

    return new Response(JSON.stringify({
      test: 'test5-lumenize-worker',
      results: {
        resourceConfig: config,
        lmzAccess,
        ctnTest,
      }
    }, null, 2));
  }

  // Test 6: Mesh envelope — call DWL's __executeOperation with a proper Mesh envelope
  // This tests whether callContext propagates when using the Mesh protocol
  async test6MeshEnvelope(): Promise<Response> {
    const worker = this.env.LOADER.get('test6-mesh-envelope', () => ({
      compatibilityDate: '2025-09-12',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'main.js',
      modules: {
        'main.js': USER_CODE_LUMENIZE_WORKER,
        'mesh-bundle.js': MESH_BUNDLE,
      },
    }));

    const entrypoint = worker.getEntrypoint('MyApp') as any;

    // Build a Mesh envelope exactly like lmz.callRaw() would
    // Operation chain for: instance.getCallContextInfo()
    const chain = preprocess([
      { type: 'get', key: 'getCallContextInfo' },
      { type: 'apply', args: [] },
    ]);

    const envelope = {
      version: 1,
      chain,
      callContext: {
        callChain: [
          { type: 'LumenizeDO', bindingName: 'SPIKE_DO', instanceName: 'spike-test' },
        ],
        originAuth: {
          sub: 'user-123',
          claims: { role: 'editor', email: 'alice@example.com' },
        },
        state: {},
      },
      metadata: {
        caller: { type: 'LumenizeDO', bindingName: 'SPIKE_DO', instanceName: 'spike-test' },
        callee: { type: 'LumenizeWorker', bindingName: 'DWL_APP' },
      },
    };

    // Call __executeOperation — this is how Mesh sends calls
    const result6a = await entrypoint.__executeOperation(envelope);

    // Test 6b: Guard check with admin role
    const guardChainAdmin = preprocess([
      { type: 'get', key: 'runGuardCheck' },
      { type: 'apply', args: ['upsert', 'settings'] },
    ]);
    const envelopeAdmin = {
      ...envelope,
      chain: guardChainAdmin,
      callContext: {
        ...envelope.callContext,
        originAuth: { sub: 'admin-1', claims: { role: 'admin' } },
      },
    };
    const result6b = await entrypoint.__executeOperation(envelopeAdmin);

    // Test 6c: Guard check with editor role (should be rejected for settings upsert)
    const guardChainEditor = preprocess([
      { type: 'get', key: 'runGuardCheck' },
      { type: 'apply', args: ['upsert', 'settings'] },
    ]);
    const envelopeEditor = {
      ...envelope,
      chain: guardChainEditor,
      callContext: {
        ...envelope.callContext,
        originAuth: { sub: 'user-456', claims: { role: 'editor' } },
      },
    };
    const result6c = await entrypoint.__executeOperation(envelopeEditor);

    return new Response(JSON.stringify({
      test: 'test6-mesh-envelope',
      results: {
        callContextInfo: result6a,
        guardAdmin: result6b,
        guardEditor: result6c,
      }
    }, null, 2));
  }
}

// --- Worker entrypoint — routes to DO ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response(
        'DWL Spike Experiments\n\n' +
        'GET /test1 — Basic: DO spawns DWL, calls fetch()\n' +
        'GET /test2 — Env: DO passes env vars to DWL\n' +
        'GET /test3 — RPC: DO calls DWL WorkerEntrypoint methods (CRITICAL)\n' +
        'GET /test4 — Bonus: Pass DO namespace binding into DWL env\n' +
        'GET /test5 — LumenizeWorker: DWL extends LumenizeWorker (CRITICAL)\n',
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    // Route to a DO instance
    const id = env.SPIKE_DO.idFromName('spike-test');
    const stub = env.SPIKE_DO.get(id);
    return stub.fetch(request);
  },
};
