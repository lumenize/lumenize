# Mesh Call Tracing & ID Primitives

## Objective

Add per-call IDs to Mesh's `callChain[]` so `@lumenize/debug` (and any other observer) can reconstruct full call trees — including forks where one node makes multiple outgoing `lmz.call()`s — by reading `lmz.callContext`. As a paired change, standardize unique-ID generation across `@lumenize/mesh` and `apps/nebula` on two blessed primitives that close out a known footgun (non-monotonic ULID in Workers).

## Why now

About to start creating millions of resources in Nebula. Migrating ID generation now keeps the audit small; doing it later means migrating live data. The tracing piece also makes log correlation usable before the volume hits.

## Design Decisions

### traceId is `callChain[0].callId`

Don't add a separate `traceId` field. Once each `callChain[]` entry has a `callId`, the root entry's callId IS the trace identifier — stable across all descendants because the chain is propagated. Current hop is `callChain.at(-1).callId`. Forks reconstruct cleanly because each branch carries the shared prefix and diverges only at its own callId.

### Two blessed ID primitives in `@lumenize/mesh`

- **`uniqueId()`** — monotonic ULID. Default for everything trackable: callIds, entity IDs, log correlation, anything where ordering and debuggability are wins.
- **`secureToken()`** — full-entropy random (`crypto.randomUUID()` or `crypto.getRandomValues`-based). For secrets and anywhere the ULID timestamp prefix would leak sensitive timing (session tokens, refresh tokens, CSRF tokens, bearer credentials).

Two primitives, not one — because ULIDs leak creation time in their first 48 bits. That's a feature for trackable IDs, a vulnerability for secrets.

Why `@lumenize/mesh` and not a separate `@lumenize/ids` package: it's a design decision for mesh and nebula. Small enough to mimic with a one-line export elsewhere if needed.

### Monotonic mode is non-negotiable

`ulid-workers` defaults to non-monotonic. In Workers, `Date.now()` is pinned within an invocation (see `feedback_cf_clock_traps.md`), so non-monotonic mode produces ULIDs with identical timestamps and pure-random suffixes — ordering becomes lexical-random, useless for log sequencing. The blessed `uniqueId()` MUST pre-bind monotonic mode. Anyone reaching for raw `ulid-workers` is the lint target.

### `@lumenize/debug` reads `lmz.callContext`, not ALS

Treat ALS as a callContext implementation detail. `@lumenize/debug` should call `lmz.callContext` (or equivalent public accessor) and no-op gracefully when Mesh isn't loaded — same try-import pattern as the `cloudflare:workers` detection in CLAUDE.md. This keeps debug from coupling to ALS semantics that may change.

### Open design question (decide in Phase 2)

Where does `callId` live on a chain entry? Options:

1. **Field on `NodeIdentity`** — simplest but conflates identity (who) with call instance (which call to/from this node). The same node can appear in callChain multiple times.
2. **New `CallChainEntry` wrapper type** — `{ callId: string; identity: NodeIdentity }`. Cleaner separation. Breaking change to the chain shape.
3. **Parallel array** — `callIds: string[]` alongside `callChain: NodeIdentity[]`. Avoids reshaping but easy to desync.

Recommendation: option 2. Also need to specify whether an entry's callId is "the call that arrived at this node" or "the call originating from this node" — either is consistent as long as the convention is documented.

## Phase 1: ID primitives in `@lumenize/mesh`

**Goal**: `uniqueId()` and `secureToken()` exist, are exported from the package's public surface, and are documented.

**Implementation notes**:
- `uniqueId()` wraps `ulid-workers` with monotonic mode pre-bound
- `secureToken()` wraps `crypto.randomUUID()` (or `crypto.getRandomValues` if a different shape is wanted)
- Both exported from `packages/mesh/src/index.ts`
- Single-file implementation; no need for new directories

**Success criteria**:
- [ ] Both functions exported and importable as `import { uniqueId, secureToken } from '@lumenize/mesh'`
- [ ] Test that demonstrates monotonic ordering within a single Workers invocation: generate N IDs in a tight loop with pinned `Date.now()`, assert they sort lexically in generation order
- [ ] Test for `secureToken()` confirms no timestamp prefix correlation (sanity check, not a cryptographic proof)
- [ ] JSDoc on each explains when to use which, with the timestamp-leak rationale

## Phase 2: per-entry `callId` on callChain

**Goal**: every entry in `callContext.callChain` carries a unique `callId` (from `uniqueId()`), generated at the hop where the entry is added, propagated unchanged thereafter.

**Implementation notes**:
- Resolve the open design question above (recommend option 2: `CallChainEntry`)
- Update `packages/mesh/src/types.ts` — `CallContext.callChain` shape
- Update `packages/mesh/src/lmz-api.ts` — `buildOutgoingCallContext` and the `newChain` path generate the new entry's callId
- Update wire format in `packages/mesh/src/gateway-messages.ts` if callChain is serialized there
- Audit every place that constructs or extends a `callChain` — `grep -rn "callChain" packages/mesh/src/`

**Success criteria**:
- [ ] `callContext.callChain` entries include callIds at every hop (verified in a multi-hop test)
- [ ] Forking test: one node makes 2+ outgoing `lmz.call()`s; each downstream sees a chain whose leaf callId is unique to its branch but whose root callId matches the originator
- [ ] `callChain[0].callId` (the trace root) is stable across all descendants of a single originating call
- [ ] All existing mesh tests still pass (`npx vitest run` in `packages/mesh/`)

## Phase 3: `@lumenize/debug` enrichment

**Goal**: when a `debug()` call fires inside a Mesh hop, the log entry is auto-prefixed with `[<rootCallId>:<currentCallId>]` (or the full chain when verbose).

**Implementation notes**:
- Soft-import: `try { const mesh = await import('@lumenize/mesh'); ... } catch { /* not available, no-op */ }` — same pattern as the cross-platform `cloudflare:workers` detection in CLAUDE.md
- Read via the public `lmz.callContext` accessor, NOT the underlying ALS
- Format is a sketch — actual format is a debug-side decision

**Success criteria**:
- [ ] Log emitted from inside a mesh hop includes root + current callIds
- [ ] Log emitted outside a mesh context (e.g., a cron handler with no `lmz.call()` ancestry) emits as before — no error, no empty brackets
- [ ] Test for the no-op fallback runs in a Node-only environment where Mesh isn't loaded

## Phase 4: audit & migrate existing ID generation

**Goal**: every direct unique-ID call site in `@lumenize/mesh` and `apps/nebula` is replaced with `uniqueId()` or `secureToken()`. Decision is recorded once per call site, not re-decided each time someone needs an ID.

**Inventory** (run at task-execution time, not now — files drift):

```bash
# Trackable + secret call sites to classify and migrate:
grep -rn "crypto\.randomUUID\|from 'ulid-workers'\|from \"ulid-workers\"" packages/mesh/src/ apps/nebula/src/

# Also check for direct ulid() calls if the import is aliased:
grep -rn "\bulid(" packages/mesh/src/ apps/nebula/src/
```

For each match, classify:
- **Trackable** → `uniqueId()`. Examples: callIds, entity/resource IDs, mesh-internal correlation IDs, anything that ends up in logs or storage where ordering helps.
- **Secret** → `secureToken()`. Examples: session tokens, refresh tokens, CSRF tokens, bearer credentials, IDs that appear in URLs where creation-time leakage is a concern.

If a call site is ambiguous, write the rationale into the commit message; the audit's value is having the decision on record.

**Success criteria**:
- [ ] All matches from the inventory above are migrated (or explicitly justified for staying as-is — e.g., a third-party API requires a UUID format)
- [ ] All tests pass in both packages
- [ ] Spot check: pick 3 migrated call sites and verify the chosen primitive matches the trackable-vs-secret classification

## Phase 5: lint guardrail

**Goal**: prevent regression. New code reaching for `crypto.randomUUID()` or raw `ulid-workers` outside the blessed primitives gets flagged.

**Implementation notes**:
- Simplest workable form: an eslint rule (or a ripgrep-based pre-commit check) that flags `crypto\.randomUUID\(` and imports from `'ulid-workers'` outside `packages/mesh/src/<id-primitives-file>.ts`
- Allow-list the primitives file itself
- If the project already uses eslint rules, prefer that; otherwise the ripgrep approach via `.husky/` or a `lint-staged` entry is enough — this is a guardrail, not a security boundary

**Success criteria**:
- [ ] A new commit introducing `crypto.randomUUID()` outside the allow-listed file fails the check
- [ ] All allow-listed legitimate uses still pass

## Notes

- This task touches the wire format if callChain is serialized over WebSocket between Gateway and Star — if so, both sides ship together (a single deploy is the simplest path; `apps/nebula` and any deployed test workers go out atomically). Confirm during Phase 2 implementation whether a wire-version bump is needed.
- ULID's timestamp prefix being load-bearing means `uniqueId()` should NOT be used for short-lived per-process counters or any ID where time-correlation is undesired — those are the `secureToken()` cases.
- The fork-reconstruction property is what makes per-entry callIds different from a single traceId-on-root: fork branches share prefix, diverge at their own callId, and a log consumer can group by `callChain[0].callId` then tree-build by chain length and shared prefix.
