# Spy-able `@lumenize/debug` output for tests

**Status**: Not started.
**Spawned from**: [tasks/nebula-frontend.md](nebula-frontend.md) § Phase 5.3.6 "Deferred items"; surfaced concretely by the skipped test at [apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts:116](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts).

## Objective

Make `@lumenize/debug`'s `.warn()` / `.error()` / `.debug()` / `.info()` output observable from test code, so tests can assert that specific log lines fired (e.g., the "no cached meta.eTag" warn from the bindToState middleware).

## Current behavior

`@lumenize/debug` routes every level through `console.debug` (not `console.warn` even for `.warn()`) AND gates on the `DEBUG` env var. So:

- A `console.warn` spy doesn't catch `.warn()` calls (wrong stream)
- A `console.debug` spy doesn't catch anything by default (DEBUG env var off)
- Setting `DEBUG=foo` enables output but the spy still has to deal with every other debug line in the same stream

End result: log assertions in tests don't work without bespoke setup per test, and one bindToState test (`'skips writes with no cached meta.eTag (create path) and logs a warn'`) is skipped because of this.

## Approach options

Three options listed in `nebula-frontend.md`:
1. **DEBUG env-var injection + `console.debug` spy** — set DEBUG via miniflare binding, spy on `console.debug`, filter by namespace. Cheap but noisy.
2. **Per-test `output` override on `@lumenize/debug`'s logger** — add an API like `setDebugSink(fn)` or `withSink(fn, () => { ... })` that replaces the output channel for the calling scope only. Test setup installs a sink, asserts on captured entries, tears down.
3. **Parallel `console.warn(...)` for must-be-observable warn cases** — change `.warn()` (only `.warn()`) to ALSO call `console.warn` so existing `console.warn` spies work. Conservative; doesn't help `.debug()` / `.info()` tests.

Recommended: **option 2** (sink override) — covers all levels, gives tests a clean isolated channel, doesn't change production behavior. The mesh-side change is small (one new exported function, instrument the existing `log()` helpers to check for a sink first), and the test-side use is natural (`beforeEach(() => setDebugSink(captureFn); afterEach(() => clearDebugSink())`).

## Phase 1: Add the sink API

**Goal**: `@lumenize/debug` exports `setDebugSink(fn | null)` and the logger respects it.

**Success Criteria**:
- New exported `setDebugSink(fn: ((entry: DebugEntry) => void) | null): void` (and matching `clearDebugSink()` for symmetry).
- `DebugEntry` type exposes `namespace`, `level` (`'debug' | 'info' | 'warn' | 'error'`), `message`, `args`.
- When a sink is installed, ALL `log.*(...)` calls feed entries to it. The normal `console.debug` output still fires (so DEBUG env var users see logs too) unless documented otherwise.
- Sink installation/removal is a single global slot (no stack); a second install replaces the first.

## Phase 2: Per-runtime considerations

`@lumenize/debug` ships under exports conditions (`workerd`, `worker`, `node`, `browser`) per CLAUDE.md § Cross-Platform Cloudflare Detection. The sink slot lives in the shared internal module, NOT in any of the per-condition entries — otherwise each runtime would have its own slot and node-test-injected sinks wouldn't catch logs emitted under the workerd condition.

**Success Criteria**:
- Sink works across all four runtime entries (verify with a 1-liner test per entry).
- Sink is process/isolate-scoped, not module-scoped — same sink applies across all `debug()` instances created during the test.

## Phase 3: Unskip the bindToState test

**Goal**: Convert [apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts:116](../apps/nebula/test/test-apps/baseline/nebula-client-bindtostate.test.ts) from `it.skip` to `it`.

**Approach**: rewrite the test's `warnSpy` setup to use `setDebugSink` and assert the captured entry has `namespace === <whatever the middleware uses>`, `level === 'warn'`, message contains `'no cached meta.eTag'`.

**Success Criteria**:
- Skipped test passes.
- Baseline test count goes from 169/171 → 170/171.

## Final Verification

- [ ] `@lumenize/debug` tests pass (`npx vitest run` in `packages/debug`).
- [ ] Baseline test count = 170/171 (the rollback test [#3] stays skipped pending its own task).
- [ ] No new `console.warn` calls appear at runtime when sink is null (production behavior unchanged).
- [ ] Type-check clean (`npm run type-check`).

## Notes

- Adjacent reference shape: today's `@lumenize/auth` work added per-message-type `magicLinkHeaders` overridable hooks — same general pattern (test-injectable side-channel that defaults to no-op).
- Once shipped, this pattern unlocks log assertions everywhere — nebula-frontend's 5.3.6 deferred items, future error-path tests, etc.
