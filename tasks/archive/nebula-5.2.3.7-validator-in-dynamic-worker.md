# Task: Run ts-runtime-validator in a Dynamic Worker

**Status:** Draft — blocked on spike results
**Depends on:** nebula-5.2.3 (validate package complete), nebula-5.2.3.6.5 (DW bundler spike)
**Blocks:** nebula-5.2.4-docs.md (need to document this pattern)
**Reference:** [Dynamic Workers blog post](https://blog.cloudflare.com/dynamic-workers/), [Cloudflare docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)

---

## Problem

`validate()` loads the bundled tsc compiler (~3.4 MB, ~40-50 MB memory). In a Durable Object with a 128 MB isolate limit, that's a significant chunk of the budget. If validation runs in the same isolate as the DO's business logic, the memory pressure limits what else the DO can do.

## Solution

Offload validation to a Dynamic Worker. Cloudflare's Dynamic Workers run in the **same thread** as the parent — no network hop, no IPC overhead. Spike A1 confirmed tsc runs in a DW at ~1ms/call.

## Open Question

**Do Dynamic Workers share the parent's 128 MB isolate memory, or get their own budget?**

- Asked on Cloudflare Discord (#dynamic-worker-loader) on 2026-03-25 — awaiting reply
- If **separate budgets**: this is the recommended default architecture. The memory tradeoff row in the docs essentially disappears.
- If **shared budget**: still valuable for isolating the tsc bundle from the main Worker's startup and keeping the DO code clean, but doesn't solve the memory constraint.

**Proceed with implementation regardless** — the API wrapper is useful either way, and the answer only affects how we position it in docs.

## Implementation

### 1. Bundle the validator as a DW module string

DW code is provided as a **string** — the DW runs in its own isolate, not as a regular module import. Two bundling approaches are being evaluated in the spike (task 5.2.3.6.5):

- **`@cloudflare/worker-bundler`** — resolves npm deps and bundles at runtime inside the parent Worker. No build step. Spike will determine if typescript is too large for this.
- **Pre-bundle with esbuild** — our existing approach from `tsc-dwl-spike`. Requires a build step (acceptable at publish time, not ideal during development).

The DW exports a `WorkerEntrypoint` class so the parent can call methods via Workers RPC (not fetch — avoids JSON serialization overhead):

```typescript
// The DW code (will be bundled into a string at build time):
import { WorkerEntrypoint } from 'cloudflare:workers';
import { validate, toTypeScript, extractTypeMetadata } from '@lumenize/ts-runtime-validator';

export class Validator extends WorkerEntrypoint {
  validate(value: unknown, typeName: string, typeDefinitions: string) {
    return validate(value, typeName, typeDefinitions);
  }

  toTypeScript(value: unknown, typeName: string) {
    return toTypeScript(value, typeName);
  }

  extractTypeMetadata(typeDefinitions: string) {
    return extractTypeMetadata(typeDefinitions);
  }
}
```

The bundled string is loaded via `env.LOADER.get()` (not `load()`) so the DW stays warm across calls — the tsc program instance doesn't need to be re-initialized on every request:

```typescript
const worker = env.LOADER.get('validator', () => ({
  compatibilityDate: '2026-03-12',
  mainModule: 'validator.js',
  modules: { 'validator.js': VALIDATOR_BUNDLE },
  globalOutbound: null, // no network access needed
}));
```

### 2. Create a `createValidator()` helper

Returns the same API surface as direct imports, but calls are routed to the DW via RPC using `getEntrypoint()`:

```typescript
export function createValidator(env: Env) {
  const worker = env.LOADER.get('validator', () => ({
    compatibilityDate: '2026-03-12',
    mainModule: 'validator.js',
    modules: { 'validator.js': VALIDATOR_BUNDLE },
    globalOutbound: null,
  }));

  using entrypoint = worker.getEntrypoint('Validator');

  return {
    async validate(value: unknown, typeName: string, typeDefinitions: string) {
      return await entrypoint.validate(value, typeName, typeDefinitions);
    },
    async toTypeScript(value: unknown, typeName: string) {
      return await entrypoint.toTypeScript(value, typeName);
    },
    async extractTypeMetadata(typeDefinitions: string) {
      return await entrypoint.extractTypeMetadata(typeDefinitions);
    },
  };
}
```

**Notes:**
- `get()` with a stable ID (`'validator'`) keeps the DW warm — subsequent calls reuse the same isolate and tsc program instance
- `getEntrypoint('Validator')` returns an RPC stub to the named entrypoint class
- The `using` keyword ensures the RPC stub is disposed after use, avoiding wall-clock billing
- Methods become `async` because RPC calls cross the stub boundary; since DWs run in the same thread, this is fast — no network hop

### 3. Wrangler binding

```jsonc
// wrangler.jsonc
{
  "worker_loaders": [
    {
      "binding": "LOADER"
    }
  ]
}
```

### 4. Documentation

- Add a "Running in a Dynamic Worker" section to the ts-runtime-validator docs
- Update the Tradeoffs table in index.mdx — memory row should mention the DW escape hatch
- Update the blog post with the DW option

## Design Decisions

- **`WorkerEntrypoint` + `getEntrypoint()`, no `RpcTarget`**: Each `validate()` call is an independent RPC request — fire-and-forget, no persistent handle. `RpcTarget` would keep a connection open and incur wall-clock billing in DO contexts, which doesn't fit our use case (validating incoming call parameters on the fly). This also aligns with our broader stance of avoiding `RpcTarget` and Cap'n Web in the Lumenize stack.
- **Workers RPC, not fetch**: Avoids manual JSON serialization. Use `using` keyword to dispose the entrypoint stub promptly after use.
- **Future: NebulaWorker wrapper**: Once we know the memory-sharing answer from Discord, a `NebulaWorker` base class (analogous to `LumenizeWorker`) could wrap DW communication behind `this.lmz.call()`. Deferred — see `tasks/nebula-scratchpad.md` "NebulaWorker for Dynamic Workers" entry.
- **`get()` not `load()`**: Using `get('validator', callback)` keeps the DW warm by ID. The tsc program instance persists across calls — first call pays ~1ms setup, subsequent calls are faster. `load()` would create a fresh isolate each time.
- **Error handling**: The wrapper must faithfully propagate `TypeError` throws from `toTypeScript()` (functions, etc.) back to the caller. Workers RPC propagates exceptions natively.
- **Structured clone**: Workers RPC uses structured clone, not JSON. All return types (`ValidationResult`, strings, metadata objects) are structured-clone-safe.

## Testing

- Unit test: `createValidator()` returns same results as direct `validate()` calls
- Integration test: DO uses `createValidator(env)` to validate resources
- Memory test (if possible): measure parent DO memory with and without DW validation

## Scope

This task creates the wrapper and documents it. It does NOT:
- Make DW the default in Nebula (that depends on the memory answer)
- Change existing `validate()` imports in apps/nebula
- Add DW support to the test infrastructure
