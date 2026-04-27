# `@lumenize/ts-runtime-parser-validator` — Batch Parse Mode and Test Entry-Point Cleanup

**Status**: Not started — design pinned 2026-04-26 (revised 2026-04-26 after review)
**Package**: `packages/ts-runtime-parser-validator/`
**Detour from**: review of [nebula-5.2.4.2-validator-galaxy-integration.md](./nebula-5.2.4.2-validator-galaxy-integration.md)

## Objective

Two coupled changes shipped before 5.2.4.2 starts:

1. **Batch mode** — add a heterogeneous batch entry point to the emitted parser-validator module so a single facet-RPC hop can parse N values of mixed types instead of N separate hops. Plumb the new shape through `ParserValidator` and `getParserValidatorFacet`. Nebula's `Resources.transaction()` will then call a single `await facet.parseBatch(items)` per transaction rather than a loop of `await facet.parse(...)` calls.
2. **Test entry-point cleanup** — delete the broken HTTP `/parse` path on the test `PrimaryDO` (JSON serialization can't round-trip the rich types the parity tests exist to verify), rename `rpcParse` → `parse` (the prefix only existed to disambiguate from the HTTP handler), and migrate the 8 existing tests that depend on either pattern. Done in this task because the new batch tests need the cleaned-up entrypoint, and the package is unreleased so there's no migration risk.

## Why now

`@lumenize/ts-runtime-parser-validator` is unreleased. 5.2.4.2's review surfaced that `facet.parse()` is async — each call crosses the facet RPC boundary (an event-loop microtask) at ~1 ms warm. `Resources.transaction()` calls validate in a per-op loop (Step 5), so today that's one input-gate open per op and N×~1 ms of latency stacked sequentially.

The eTag double-check pattern in `Resources.transaction()` (pre-check outside `transactionSync`, authoritative re-check inside) keeps correctness intact across input-gate openings. So batching is **a perf optimization, not a correctness fix** — but at the price of a small package API addition before its first release, we collapse N hops into 1, which:

- Removes N–1 input-gate openings per transaction (and the N–1 chances for unrelated requests to interleave)
- Cuts end-to-end transaction latency by ~(N–1) ms in the warm-facet case
- Helps bulk imports (5–50 ops) most; trivial for 1-op transactions but no regression there

Cost: small. The package isn't published, so no migration story; tests already exercise the emitted module shape; the `getParserValidatorFacet` helper is one extra type-line. The test cleanup is opportunistic — same files are getting touched, same package is unreleased, so the cost of doing it now (one extra phase) is far below the cost of doing it as a follow-up after the broken HTTP path has spread to more tests.

## Design

### Shape: `Map<string, ParseRequest>` → `Map<string, ParseResult>`

```typescript
type ParseRequest = { value: unknown; typeName: string };

class ParserValidator extends DurableObject {
  parse(value: unknown, typeName: string): ParseResult;
  parseBatch(items: Map<string, ParseRequest>): Map<string, ParseResult>;  // NEW
}
```

- **Heterogeneous** — items can target different typeNames in one call (matches Nebula's mixed-typeName transactions).
- **Map keys are caller-defined identity** — the package treats keys as opaque strings and echoes them back unchanged on the result Map. The caller (Nebula uses `resourceId`) maps results back via direct `results.get(key)` lookup, no parallel arrays. Order is preserved (Map iteration order = insertion order).
- **Per-item results, not all-or-nothing** — each entry in the result Map is either `{ valid: true, data }` or `{ valid: false, errors }`. Caller decides how to react (Nebula collects all errors for the transaction error map; doesn't short-circuit).
- **Empty input** — `parseBatch``(new Map())` returns `new Map()`. No special-casing.
- **`ParseResult`**** is unchanged** — no `id` smuggled into it; identity lives on the Map key.
- **Duplicate keys can't happen by construction** — the Map type guarantees uniqueness, so the package doesn't need to specify behavior for them.

Keys are typed `string` for ergonomics. If a real caller needs non-string keys, widen to `Map<TKey, ParseRequest>` then.

### Why not other shapes

- **Array of \****`{id, value, typeName}`**\*\* items** — earlier draft. Forces `id` to be smuggled into `ParseResult`, leaves duplicate-id behavior undefined, and requires the caller to walk an array and re-key by id at the call site. The Map shape subsumes all three concerns.
- **Two parallel arrays (****`keys[]`****, \****`items[]`**\*\*)** — same problems as the array-of-items shape, plus a parallel-array bookkeeping hazard at every call site.
- **`parseBatch(typeName, values[])`** — homogeneous. Doesn't fit Nebula's mixed-typeName transactions. Loses on the actual hot caller.
- **`parseBatch(Record<typeName, values[]>)`** — homogeneous-grouped; loses per-item key identity and ordering.
- **`parseBatch(items, options: { stopOnFirstError })`** — over-engineered for the unreleased package. Add later if a real caller needs it.

### Async, but a single hop

`parseBatch` is sync inside the facet (no I/O — just N `validators[typeName](value)` calls and the filler). The Promise comes from the facet RPC boundary (an event-loop microtask). So:

- One facet RPC boundary crossing for the whole batch instead of N
- Inside the facet, just a tight loop over the input Map
- Per-byte payload work scales the same either way; what we save is the N–1 microtask boundary crossings, not the byte-shuffling cost
- `Map` structured-clones cleanly across Workers RPC

### Unknown type handling

Matches `parse()`: if `validators[typeName]` is missing for a given key, that key's result is `{ valid: false, errors: [{ path: ', expected: typeName, value, description: 'unknown type' }] }`. Other items in the same batch are unaffected.

### Filler behavior

`__fillDefaults` runs per-item exactly as in `parse()`. Each item gets its own fresh `seen` WeakMap, so cycles within an item are still tracked with no cross-item interference.

## Phase 1: Emit + helper types

**Goal**: `parseBatch` on the emitted module, plumbed through the package's public types.

**Work**:
- Add the `parseBatch(items)` method body to the emitted `ParserValidator` class in `src/generate-parse-module.ts`. Tight loop over `items.entries()` calling the existing single-item logic (filler + validator + result-shape) and `set()`-ing into an output `Map` keyed by the same key. Don't introduce error handling that `parse()` doesn't already have.
- Update `ParserValidatorClass` (internal brand) and `ParserValidator` (public stub type) in `src/facet-helper.ts` to add `parseBatch(items: ``Map<string, ParseRequest>): Promise<Map<string, ParseResult>>` (Promise on the public type because facet RPC is async; sync `Map<...>` on the brand because the class itself is sync).
- Export `ParseRequest` from `src/index.ts` alongside `ParseResult`. (No `BatchItem` / `BatchParseResult` types — the Map shape doesn't need wrappers.)

**Success Criteria**:
- [ ] Emitted module has `parseBatch(items)` returning `Map<string, ParseResult>` keyed by the input keys
- [ ] `ParserValidator` public type advertises `parseBatch(items: ``Map<string, ParseRequest>): Promise<Map<string, ParseResult>>`
- [ ] `ParseRequest` exported from `src/index.ts`
- [ ] No new runtime imports inside the emitted module (keep it self-contained per [nebula-5.2.4.1-validator-engine-upgrade.md](./archive/nebula-5.2.4.1-validator-engine-upgrade.md))

## Phase 2: Test entry-point cleanup

**Goal**: Delete the broken HTTP `/parse` path on `PrimaryDO`, rename `rpcParse` → `parse`, and migrate the 8 existing tests that depend on either pattern. Done before Phase 3 so the new batch tests are written against the cleaned-up entrypoint from the start.

**Work**:
- On `PrimaryDO` in `test/test-worker-and-dos.ts`:
  - Rename `rpcParse``(typeDefinitions, value, typeName, bundleId)` → `parse(typeDefinitions, value, typeName, bundleId)`. The `rpc` prefix only existed to distinguish from the HTTP `fetch('/parse')` entry; once that goes (next bullet), the prefix is meaningless. `await stub.parse(...)` already reads as RPC at the call site.
  - Delete the HTTP `fetch('/parse')` handler on `PrimaryDO` and the corresponding worker-level `/parse` route in `default { fetch }`. The HTTP path is fundamentally broken — JSON serialization loses fidelity on `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `TypedArray`, and cyclic refs (the very rich-type cases the parity tests exist to verify). Tests using it have been accidentally validating the round-trip degradation, not the parser. Not referenced anywhere in `website/docs/`. The RPC entry covers every test correctly.
- Migrate **5 test files** off `SELF.fetch('/parse')` to `stub.parse(...)`: `test/facet-roundtrip.test.ts`, `test/typia-tags.test.ts`, `test/default-fill.test.ts`, `test/relationships.test.ts`, `test/parity/types.test.ts`. Each currently declares a local `parse(...)` helper hitting `SELF.fetch` plus its own `ParseResult`-with-`{ result: ... }`-envelope type. Mechanical changes per file: replace the helper with the RPC-stub pattern from `test/parity/values.test.ts`, drop the JSON envelope, drop the `.result.` accessor in assertions.
- Migrate **3 test files** off `rpcParse` to `parse`: `test/parity/values.test.ts`, `test/for-docs/additional-constraints.test.ts`, `test/for-docs/default.test.ts`. Search-and-replace.

**Success Criteria**:
- [ ] `PrimaryDO.parse` is the only parse entry on the test DO; HTTP `/parse` handler and worker route are gone
- [ ] All 8 migrated test files run green and use `stub.parse(...)`
- [ ] No test file references `SELF.fetch('/parse')` or `rpcParse` anywhere in the package
- [ ] Existing `parse()` tests still pass — no regressions

## Phase 3: Batch tests

**Goal**: Cover the heterogeneous + key-preserving + per-item-success/failure surface, including the existing rich-types path. Written against the cleaned-up `parse` / new `parseBatch` entries from Phase 2.

**Work**:
- Add `parseBatch(typeDefinitions, items, bundleId)` on `PrimaryDO` alongside the renamed `parse`, mirroring its `(typeDefinitions, ..., bundleId)` framing. `bundleId` defaults to `'rpc-default'` for both so they share the loaded facet — both live on the same emitted `ParserValidator` class.
- Add `test/batch-parse.test.ts` covering:
  - Empty Map → empty Map
  - Single-item batch — result keyed by the input key, content matches `parse()` shape
  - Heterogeneous batch (mixed typeNames) — keys preserved, per-item results correct
  - Mix of valid + invalid items in one batch — invalid keys carry `errors`, valid keys carry `data` with defaults filled
  - Unknown `typeName` for one key — that key fails with the canonical `unknown type` error, others succeed
  - `@default` filling — each item gets its own filled `data` (separate, not shared)
  - Cycles within an item — still safe (existing `__fillDefaults` `seen` semantics)
  - Rich types via the RPC entry point — `Set`, `Map`, `Date` round-trip across the facet boundary in a batch (mirrors the migrated `test/parity/values.test.ts` style)

**Success Criteria**:
- [ ] All new tests pass under `vitest-pool-workers`
- [ ] Coverage stays at or above current level (statement / branch)
- [ ] All new tests pass under `vitest-pool-workers`
- [ ] Existing `parse()` tests still pass — no regressions
- [ ] Coverage stays at or above current level (statement / branch)

## Phase 4: Docs

**Goal**: `parseBatch` documented at the same fidelity as `parse`. No standalone post — this is one entry-point added to existing docs.

**Work**:
- Add a `parseBatch` section to `website/docs/ts-runtime-parser-validator/api-reference.md` with the signature (Map → Map), a short example, and a one-line note on when to prefer `parseBatch` over `parse` ("when validating multiple values per facet call — collapses N RPC hops into 1").
- Add a 5–10 line "validating many values" follow-up to step 3 of `getting-started.md` showing `parseBatch` (step 3 currently shows `parse()`).
- Annotate the new code blocks with `@check-example` pointing at the new test file (per `.claude/rules/documentation.md` — never `@skip-check-approved`, always `@check-example` when finalizing).
- Update the package `README.md` only if it currently lists API methods; otherwise leave alone.

**Success Criteria**:
- [ ] `api-reference.md` documents `parseBatch` with `@check-example`-validated code samples
- [ ] `npm run check-examples` passes for the package's docs
- [ ] No `@skip-check` left in the changed sections

## Phase 5: Wire into `tasks/nebula-5.2.4.2`

**Goal**: Once Phases 1–4 ship, update 5.2.4.2's Phase 3 to call `parseBatch` once per transaction over a Map.

**Work**:
- In [nebula-5.2.4.2-validator-galaxy-integration.md](./nebula-5.2.4.2-validator-galaxy-integration.md), Phase 3 "Validation in `Resources.transaction`":
  - Replace the per-op loop description with: build `requests: Map<string, ParseRequest>` from the entries that actually need parsing, using `resourceId` as the key. Skip `delete`/`move` ops, `create`/`put` with `op.value == null`, and `put` with no current snapshot (mirroring today's loop continues at `resources.ts:282-305`). If `requests.size === 0`, skip the call entirely. Otherwise call `await facet.parseBatch(requests)` once and walk the returned Map — each entry shares the input key so the caller maps back via direct `results.get(resourceId)`.
  - For each successful per-item result, write `result.data` back onto the corresponding `op.value` so downstream Step 7+ sees the `@default`-filled value (same requirement as the single-`parse()` path already documented in 5.2.4.2 Phase 3).
  - Update Decision #4's call-site example to show `parseBatch` as the hot-path call (keep `parse` mentioned as the single-item form).
  - **Rewrite Decision #9** — no public method should reinforce "validate"; it's a "parse, don't validate" pipeline now:

    > **`parseBatch()`**** is the transaction hot-path call (****`parse()`**** is the single-item form).** `Resources.transaction()` calls `parseBatch()` once per transaction over a `Map<resourceId, { value, typeName }>` built from the entries that need parsing. The previous tsc-based method is removed entirely. `@default` filling happens inside the parser; callers discriminate on `result.valid` to narrow to `data` (success) or `errors` (failure). The resulting `data` overwrites `op.value` so downstream Step 7+ sees the filled object. Input-gate openings collapse from N to 1 per transaction; correctness across input-gate windows is still guaranteed by the existing eTag double-check.

**Success Criteria**:
- [ ] 5.2.4.2 Phase 3 references `parseBatch` and a single async hop per transaction
- [ ] Decision #4 example shows `parseBatch` for the multi-op case
- [ ] Decision #9 reworded — no occurrence of "validate" framing the new pipeline

## Notes

### Trade-offs considered

- **Single API vs two APIs.** Could fold single-item into batch (`parseBatch``(new Map([[k, { value, typeName }]]))` instead of `parse(value, typeName)`). Rejected: ergonomics matter for the common 1-item case, and the docs land cleaner with both shapes available. Implementation cost of keeping `parse` is one extra method body.
- **Emit a fused validator that takes mixed types directly.** Considered (rejected): typia validators are per-type; fusing would mean a runtime dispatcher inside the validator, which is exactly what `parseBatch` already is. No win.
- **Stream results back as they complete.** Considered (rejected): facet RPC is request/response, not streaming. Even if streaming worked, a transaction can't act on partial results — it needs the full set to decide commit vs reject.

### Out of scope

- Concurrency inside the facet (running validators in parallel via `Promise.all`). Validators are sync; there's nothing to parallelize.
- A separate `assertBatch`-style throw-on-error variant. Add later if a caller asks.
- Caching parse results across calls. Out of scope; values are user input, not amenable to caching.

### Open questions

- **`ParseRequest`**** field naming.** `{ value, typeName }`: `value` matches the existing `parse(value, typeName)` argument order; `typeName` matches the existing typeName parameter. No `id` field — identity is the Map key.
- **Error if batch contains 10,000 items?** No explicit limit in the API. Workers RPC payload limits will apply naturally — exact ceiling isn't documented here; trust the platform error to surface it. If a real caller hits this, add chunking guidance to docs rather than baking a limit into the API.
