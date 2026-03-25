# Task: Run ts-runtime-validator in a Dynamic Worker

**Status:** Draft
**Depends on:** nebula-5.2.3 (validate package complete)
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

### 1. Create a validator Worker module

A small Worker that imports the bundled tsc and exposes `validate()`, `toTypeScript()`, and `extractTypeMetadata()`:

```typescript
// src/validator-worker.ts
import { validate, toTypeScript, extractTypeMetadata } from '@lumenize/ts-runtime-validator';

export default {
  async fetch(request: Request): Promise<Response> {
    const { fn, args } = await request.json();

    switch (fn) {
      case 'validate':
        return Response.json(validate(...args));
      case 'toTypeScript':
        return Response.json(toTypeScript(...args));
      case 'extractTypeMetadata':
        return Response.json(extractTypeMetadata(...args));
      default:
        return Response.json({ error: 'Unknown function' }, { status: 400 });
    }
  }
};
```

### 2. Create a `createValidator()` helper

Returns the same API surface as direct imports, but calls are routed to the DW:

```typescript
export function createValidator(loader: DynamicWorkerLoader) {
  const worker = loader.load(validatorWorkerCode);

  return {
    validate(value: unknown, typeName: string, typeDefinitions: string) {
      // Call the DW
    },
    toTypeScript(value: unknown, typeName: string) {
      // Call the DW
    },
    extractTypeMetadata(typeDefinitions: string) {
      // Call the DW
    },
  };
}
```

### 3. Wrangler binding

```jsonc
// wrangler.jsonc
{
  "worker_loader": {
    "binding": "LOADER"
  }
}
```

### 4. Documentation

- Add a "Running in a Dynamic Worker" section to the ts-runtime-validator docs
- Update the Tradeoffs table in index.mdx — memory row should mention the DW escape hatch
- Update the blog post with the DW option

## Design Decisions

- **fetch-based RPC vs Workers RPC**: The DW API uses `fetch()`. Consider whether Workers RPC stubs would be cleaner, but be aware of wall-clock billing implications (holding stubs keeps the DO alive).
- **Caching**: The DW could cache the tsc program instance across calls. First call pays the ~1ms setup, subsequent calls are faster.
- **Error handling**: The wrapper must faithfully propagate `TypeError` throws from `toTypeScript()` (functions, etc.) back to the caller.
- **Structured clone**: `validate()` returns `ValidationResult` which is a plain object — serializes fine over fetch. But `toTypeScript()` returns a string and `extractTypeMetadata()` returns objects with arrays — all JSON-safe.

## Testing

- Unit test: `createValidator()` returns same results as direct `validate()` calls
- Integration test: DO uses `createValidator(env.LOADER)` to validate resources
- Memory test (if possible): measure parent DO memory with and without DW validation

## Scope

This task creates the wrapper and documents it. It does NOT:
- Make DW the default in Nebula (that depends on the memory answer)
- Change existing `validate()` imports in apps/nebula
- Add DW support to the test infrastructure
