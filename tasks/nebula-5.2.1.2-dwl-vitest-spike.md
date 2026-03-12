# Phase 5.2.1.2: DWL-in-vitest-pool-workers Spike

**Status**: Pending
**Package**: `experiments/dwl-vitest-spike/`
**Depends on**: Phase 5.2.1.1 (Wrangler Upgrade)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Goal

Prove that Dynamic Worker Loader (DWL) works inside `vitest-pool-workers` tests. Phase 5.2.1's round-trip echo tests depend on this — if DWL doesn't work in vitest, we need a different testing strategy before writing `toTypeScript()`.

## Context

The `experiments/tsc-dwl-spike/` (Phase 4.1) proved tsc runs in DWL, but that spike is a standalone Worker project accessed via HTTP endpoints — **not** a vitest-pool-workers test. The claim that "Miniflare supports `WorkerLoader` bindings natively" in vitest-pool-workers has not been verified.

## What to Verify

### Question 1: Does DWL bind in vitest-pool-workers?

Configure `worker_loaders` in a `wrangler.jsonc` used by a vitest-pool-workers project. Can the test access `env.LOADER`?

### Question 2: Can DWL load and execute a module?

Use `env.LOADER.get()` to load a simple module that exports a value. Can the test retrieve that value?

```typescript
// Minimal test shape
it('loads a module via DWL', async () => {
  const worker = await env.LOADER.get('test-module', {
    modules: [{ name: 'test-module.js', esModule: 'export default { answer: 42 };' }],
  });
  const response = await worker.fetch('http://localhost/');
  const result = await response.json();
  expect(result.answer).toBe(42);
});
```

### Question 3: TypeScript or JavaScript only?

DWL module names must end with `.js` or `.py` (from Phase 4.1 learnings). But Cloudflare Workers auto-compile TypeScript. Test whether:
- A module named `test.js` containing TypeScript type annotations (e.g., `const x: number = 42;`) works
- A module named `test.ts` loads at all

This matters because `toTypeScript()` output contains type annotations (`: Todo`, `as TreeNode`). If DWL only runs JavaScript, round-trip tests would need to strip annotations before loading — which is fine (annotations don't affect runtime behavior), but needs to be known upfront.

### Question 4: Can complex values round-trip?

Load a module that constructs a non-trivial value (Date, Map, nested object) and returns it via `Response`. Can the test reconstruct and compare it? This validates the full round-trip pattern that `toTypeScript()` tests will use.

## Spike Structure

```
experiments/dwl-vitest-spike/
  wrangler.jsonc          # worker_loaders binding
  vitest.config.ts        # vitest-pool-workers config
  test/
    dwl.test.ts           # The spike tests (Questions 1-4)
  package.json            # devDependencies only
  tsconfig.json
```

Keep it minimal — this is a go/no-go gate, not a reusable test harness.

## Fallback if DWL Doesn't Work

If DWL is not supported in vitest-pool-workers, the round-trip echo testing strategy for Phase 5.2.1 changes to:

1. **String-based output assertions**: Assert `toTypeScript()` produces expected TypeScript strings for each type. Less powerful than round-trip (doesn't catch "compiles but wrong value" bugs) but still validates the serialization logic.
2. **Node.js vitest project for round-trip**: Use a separate vitest project (not pool-workers) that calls `toTypeScript()`, writes to a temp file, compiles with tsc via `ts.createProgram()`, and evaluates the output. No DWL needed — runs in Node.js.

Option 2 is preferred because it preserves the round-trip property. Document which fallback was chosen in the spike results so Phase 5.2.1 can reference it.

## Success Criteria

- [ ] Questions 1-4 answered with working test code or documented failure
- [ ] If DWL works: spike tests pass, document any gotchas (module naming, TS support, etc.)
- [ ] If DWL doesn't work: document the failure mode, implement fallback option 2, confirm it works
- [ ] Results recorded in this task file (update Status and add a Results section)
- [ ] Phase 5.2.1 testing strategy is unambiguous — no open questions remain about how round-trip tests will run
