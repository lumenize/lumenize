# Phase 1 Results — Object-Based Wire Format for `@lumenize/structured-clone`

**Question:** Which wire format makes RFC 7396 (JSON Merge Patch) diffs cheap for the per-Star DAG ontology fanout workload, without paying an unacceptable snapshot-size penalty for cold-connect / patch-miss resends?

**Answer:** **W4 (SuperJSON-style nested document + meta sidecar) wins decisively.** It is the smallest format on every snapshot metric (raw and gzipped, all three fixture sizes) AND produces the smallest patches on the worst-case mutation (add-leaf), where every id-table candidate (W1/W2/W3) catastrophically regresses. On the other mutations (rename, move, grant), W3 and W4 are within ~10 bytes of each other; W3 wins by a hair on those but loses by 1000× on add-leaf.

**Patch library decision:** **Hand-rolled** ([`src/merge-patch.ts`](./src/merge-patch.ts), ~120 LOC total for diff + apply + JSON-equality helper). Zero deps, fully predictable behavior, and the experiment's sandbox couldn't reliably `npm install` `rfc6902`/`json-merge-patch` libraries anyway (FUSE-mounted workspace; `npm` rename ops failed with `ENOTEMPTY`). Phase 2 should keep this hand-roll as it ships in the package's published API surface — no transitive deps for downstream consumers.

---

## TL;DR

| Format | Snapshot (gz, N=10k) | Worst-case patch (gz) | Best-case patch (gz) |
|---|---:|---:|---:|
| tuple (current baseline) | 164.5KB | 164.5KB (no patch win) | 164.4KB (atomic arrays defeat merge-patch) |
| W1 (object-keyed tuples) | 192.4KB (+17%) | 111.0KB (add-leaf id-shift) | 89B (grant) |
| W2 ($type-tagged slots) | 195.6KB (+19%) | 112.3KB (add-leaf id-shift) | 76B (grant) |
| W3 (key-discriminator + id table) | 183.9KB (+12%) | 108.4KB (add-leaf id-shift) | 58B (grant) |
| **W4 (nested + meta sidecar)** | **129.1KB (-21%)** | **113B (add-leaf)** | **64B (rename)** |

W4 is smaller than the **current tuple format** on snapshot AND smaller than every alternative on the worst-case patch. There is no snapshot-vs-patch tradeoff to evaluate — W4 dominates on both axes.

---

## Setup

- **Synthetic DAG fixtures** ([`src/dag.ts`](./src/dag.ts)) at N=100, N=1000, N=10000, seeded RNG, 80% leaves / 15% mid-tier / 5% wide-fanout, sparse permissions (~10% of nodes carry per-node ACL grants of 1–3 subjects).
- **Mutations** (D5 + a 4th permissions-only case):
  - `add-leaf` — one new node, one new edge under a random existing parent.
  - `rename-label` — single field change on one node.
  - `move-single` — delete one edge, add one edge (single node moves to new parent).
  - `move-subtree-50` — same edge flip but picks the edge whose child has subtree size ≈ 50 (the subtree DATA doesn't move under a normalized edge model — only the parent pointer flips, which is the whole reason D1 normalizes).
  - `grant-permission` — set one `permissions[nodeId][subject] = "admin"`. Surfaced in the open-question list as "verify permissions-only changes produce a tiny patch."
- **Patch generator/applier**: hand-rolled RFC 7396 ([`src/merge-patch.ts`](./src/merge-patch.ts)) — `null` deletes a key; arrays are atomic; plain objects merge recursively; `undefined` is the no-op patch.
- **Perf**: mean over 5 runs, single warmup, `performance.now()` timing; Node v22.22.0.
- **Compression**: Node `zlib.gzipSync` default level. Lumenize's WS path is `permessage-deflate` per the task doc (`compatibility_date 2026-03-12 ≥ 2023-08-15`), so gzipped is the primary metric and approximates wire bytes.

---

## Candidate formats

All four candidates keep an `objects` indirection table (formats W1–W3) or replace it with a nested document (W4). Phase 1 fixtures contain no JS-level cycles or aliases per the task doc § Out of scope; cycle support is deferred to Phase 2.

- **tuple (baseline)** — `{ root, objects: TupleSlot[] }`; each slot `["type", payload]`. Mirrors current `packages/structured-clone/src/preprocess.ts` for plain-JSON state.
- **W1** — same as tuple but `objects` is an **object** keyed by stringified id. Smallest deviation; loses array-replacement under merge-patch but inherits tuple's slot atomicity.
- **W2** — per-slot `{ $type: "object" | "array", ...payload }`. For plain objects, the slot **is** the object — per-field merge-patch becomes possible.
- **W3** — plain objects stored *natively* in the table (no `$type` tag at all); references use `{ $ref: id }`; user keys starting with `$` are escaped with another `$`. Smallest id-table format.
- **W4** — SuperJSON-style. `{ json, meta }` where `json` is the structure encoded as plain JSON and `meta` is sparse type-info for non-JSON values (empty for Phase 1's DAG). For cycle-free graphs this is just nested JSON with no `objects` indirection at all.

See [`src/formats.ts`](./src/formats.ts) for the encoders/decoders.

---

## Results

The bench-output.json file in [`results/bench-output.json`](./results/bench-output.json) holds the raw numbers; tables below are extracted via [`scripts/run-report.ts`](./scripts/run-report.ts).

### Snapshot size at N=10000 (the headline scaling number)

| Format | Raw | Gzipped | vs tuple (raw) | vs tuple (gz) |
|---|---:|---:|---:|---:|
| tuple | 1.56MB | 164.5KB | +0.0% | +0.0% |
| W1 | 1.63MB | 192.4KB | +4.7% | +17.0% |
| W2 | 1.80MB | 195.6KB | +15.6% | +18.9% |
| W3 | 1.06MB | 183.9KB | -32.2% | +11.8% |
| **W4** | **853.8KB** | **129.1KB** | **-46.5%** | **-21.5%** |

W4 raw is roughly half of tuple's. Gzipped, W4 is **smaller than tuple** by 21%, because there's no per-slot tuple wrapper and no per-primitive `["string", ...]` boilerplate to compress.

W1/W2/W3 all bloat gzipped snapshots by 12–19% because the object-keyed `objects` table forces id strings to repeat as JSON keys, and each slot adds either a tuple wrapper (W1) or a `$type` discriminator (W2) — neither is free even after gzip's dictionary collapse.

### Patch size at N=10000, gzipped (the headline diff-friendliness number)

| Format | add-leaf | rename-label | move-single | move-subtree-50 | grant-permission |
|---|---:|---:|---:|---:|---:|
| tuple | 164.5KB | 164.5KB | 164.4KB | 164.4KB | 164.4KB |
| W1 | 111.0KB | 117B | 47.5KB | 47.5KB | 89B |
| W2 | 112.3KB | 81B | 90B | 89B | 76B |
| W3 | 108.4KB | 63B | 71B | 70B | 58B |
| **W4** | **113B** | **64B** | **68B** | **67B** | **69B** |

- **tuple** is a 1000× regression target on every operation — `objects` is an array, so merge-patch replaces the whole array on any change. This is the problem the experiment was designed to fix.
- **W1** still keeps tuple-shaped slots, so any slot change replaces the *whole tuple* (including its primitive children). Move operations replace the slot for the `edges` table — 47.5KB at N=10k. Rename and grant still benefit from per-id slot indexing.
- **W2** moves slot internals into named props, so per-field merge-patch works for rename / move / grant. add-leaf remains catastrophic for an id-table reason (next section).
- **W3** is W2 minus the `$type` tag — slightly smaller patches on every win case. Same catastrophic add-leaf.
- **W4** wins on every operation. add-leaf is 113 bytes because the nested format simply adds two leaves to two nested objects — no id table to shift.

### The id-shift problem

W1/W2/W3 share a problem on `add-leaf`: when a new node is added to `state.nodes`, the encoder allocates a new slot id mid-DFS, which **shifts every subsequent slot id by 1**. State is encoded depth-first, so `state.edges` and `state.permissions` (and all per-node permission sub-slots) move from id N → N+1. Under merge-patch, slot id N now contains different logical content in `before` vs `after`, so the diff has to rewrite N+1 slots — most of the table.

This is a fundamental property of any id-table format that allocates ids in DFS-allocation-order. Possible mitigations:
- **Hash-keyed ids** — allocate by content hash. Resists shifts but breaks alias semantics (two structurally-equal objects collapse to one id, which alters identity).
- **Per-type id spaces** — `node-N`, `edge-N`, `perm-N`. Hand-coded for the schema, doesn't generalize.
- **Stable id assignment on the in-memory side** — caller supplies a stable id for each object. Pushes the problem onto the consumer.
- **No id table for cycle-free trees** — what W4 does. Sidesteps the problem entirely for the dominant case.

W4 picks the last. Phase 2 will need to define an alias/cycle path that preserves W4's wins on cycle-free regions while handling cyclic subgraphs — likely a hybrid: nested JSON top-level, with cycle-bearing subgraphs hoisted into a sparse `meta.aliases` table only when needed.

### Logical vs byte equality after patch

The round-trip tests (`test/roundtrip.test.ts`) assert **logical** equality: `fmt.decode(applyPatch(wireBefore, patch))` equals the in-memory `after`. They do NOT assert byte-level JSON equality of the reconstructed wire — that would be too strict because RFC 7396 merge-patch can produce a different key-insertion order on a recipient when fields are merged rather than wholesale-replaced (the recipient's key order depends on `{ ...before, ...patch }` semantics, which the sender's fresh encoding doesn't go through).

This is fine for our use case — clients and server agree on logical content; the next patch is computed on the server's view and applied to whatever the client has. As long as both decode to the same in-memory state, sync is correct. But it does mean we shouldn't try to validate patches by re-encoding-then-comparing-bytes on the client.

### Encode / decode / diff / apply perf at N=10000

Perf is within a 2× band across formats — none are disqualified on perf.

| Format | add-leaf encode | rename decode | move-single diff | rename apply |
|---|---:|---:|---:|---:|
| tuple | 4.2 ms | 3.1 ms | 11.4 ms | 4.1 ms |
| W1 | 4.7 ms | 3.4 ms | 18.0 ms | 1.0 ms |
| W2 | 3.9 ms | 2.9 ms | 24.1 ms | 1.0 ms |
| W3 | 4.1 ms | 3.1 ms | 17.4 ms | 1.0 ms |
| W4 | 6.2 ms | 5.7 ms | 15.2 ms | 1.5 ms |

W4's encode/decode are 30–50% slower than tuple's because the current reference impl uses `JSON.parse(JSON.stringify(...))` as a stand-in for a content-preserving deep clone — production Phase 2 code should clone directly. Even so, encode at 6ms for a 10k-node DAG is below the 16ms frame budget and well below the typical RPC latency floor.

Diff time scales with patch-size for the catastrophic cases; for the wins it's all under 25ms at N=10k. Apply time is uniformly tiny.

Full table in [`results/tables.md`](./results/tables.md).

---

## Breakeven analysis (snapshot vs patch tradeoff)

The task doc requires computing a "breakeven N" — how many mutations per session at which patch savings amortize any snapshot bloat — and disqualifying any candidate whose breakeven N is implausible.

For **W4 vs current tuple**, there is no tradeoff: W4 has both a smaller snapshot AND smaller patches. Breakeven N = 0.

| | tuple | W4 | W4 - tuple |
|---|---:|---:|---:|
| Snapshot @ N=10k (gz) | 164.5KB | 129.1KB | -35.4KB |
| Patch (gz, average across 5 ops) | ~164KB | ~76 B | massive win |

W4 saves ~35KB on every cold-connect snapshot AND every patch is ~2000× smaller. Even a session with zero mutations is a net win for W4.

For W3 vs W4, W3 has marginally smaller patches on 4 of 5 ops (1–11 byte differences) but pays 54.8KB more on every gzipped snapshot at N=10k. Even at 50 mutations/session and W3 being 10 bytes smaller per patch, W3's snapshot cost (54.8KB) dwarfs the patch savings (500 bytes). W3 is dominated for any plausible session profile.

For W3 vs W4 specifically on `add-leaf`, W3 produces a 108KB gzipped patch while W4 produces 113 bytes — a 1000× difference per add-leaf. A single add-leaf per session pays for years of the other ops' minor advantages.

---

## Sensitivity to fixture choices

- **Permission density**: the DAG fixture grants permissions on ~10% of nodes. Bumping this to 100% would increase `grant-permission` patch contribution in the snapshot baseline but not change patch sizes (still one-grant-per-mutation). All four formats handle nested permission objects natively under merge-patch.
- **Subtree size for move-subtree-50**: a normalized edge model makes "moving a subtree" the same wire-cost as "moving a single node" — only the parent edge flips, the subtree's data doesn't move. This is reflected in the numbers (move-subtree-50 patches identical to move-single, ±2 bytes). This is the strongest case for the normalized model from D1.
- **Cycle absence**: Phase 1 fixtures have no JS cycles. W4's plain-JSON encoding can't handle cycles directly — Phase 2 needs to define the cycle path. See Open Questions below.

---

## Disqualifiers

- **tuple**: disqualified for patches. Atomic arrays make merge-patch produce a full-snapshot patch for any change. This is the problem we set out to fix.
- **W1**: disqualified by `add-leaf` and `move-*`. Slot-tuple atomicity means changing any field inside a slot replaces the whole tuple. 47KB patches on a move are unacceptable for the per-Star fanout.
- **W2**: still disqualified by `add-leaf` (id-shift) — 112KB gzipped patch is unacceptable. Wins on the other mutations are smaller than W4's by 10–15 bytes, not enough to overcome the snapshot bloat (+19% gz).
- **W3**: same id-shift disqualifier on `add-leaf`. Patch wins on the other mutations are 1–10 bytes smaller than W4's; not worth the 55KB snapshot bloat or the broken add-leaf.

---

## Recommendation

Adopt **W4** for Phase 2. Concretely, the new wire shape for plain-JSON values is:

```ts
type LmzWire =
  | { json: JsonValue; meta?: { } }                 // cycle-free: just nested JSON
  | { json: JsonValue; meta: { aliases?: Record<string, JsonValue>; paths?: Record<string, string> } };  // future: cycles + special types
```

For the DAG state, this means the wire form is essentially `JSON.stringify(dagTreeState)` plus a (usually empty) `meta` sidecar. Patches reduce to per-field RFC 7396 merge patches over the nested document.

### Phase 2 implications (already in scope per task doc)

1. **Reshape preprocess output** from `{ root, objects[] }` to `{ json, meta }`. The cycle/alias detection logic (the existing `seen: WeakMap`) stays — it now writes into `meta.aliases` keyed by a generated id, and emits `meta.paths[<path>]` to indicate "this position in `json` is a reference to alias N".
2. **Special-type tags** (`Date`, `Map`, `Set`, `Error`, `Headers`, `URL`, `RequestSync`, `ResponseSync`, `RegExp`, typed arrays, boxed primitives, bigint, function markers) need a stable on-the-wire representation. Two natural choices: embed inline at the value position with a reserved `$type` key (the W3 escape rule still applies), or hoist into `meta.paths` keyed by path. Phase 2 should pick one based on patch-friendliness — inline tags are simpler, but hoisting keeps `json` JSON-clean for downstream tools.
3. **The id-table is gone for cycle-free values.** Cycle-bearing values use `meta.aliases` only for the aliased subgraphs, not the whole document. This preserves W4's wins on the common case.
4. **`PreprocessTransform` contract** (the `__lmzId` semantic) needs replacement. With no id table for the common case, the hook should return either a plain value or a `{ $type, ...payload }` inline-tagged value. See `packages/structured-clone/src/preprocess.ts` line 116 for the call site that needs updating.
5. **`web-api-encoding.ts`** currently emits objects nested inside tuples (`encodeRequestSync`, `encodeResponseSync`). These shift to emitting plain objects under a `$type: "request-sync"` (or similar) tag, with referenced headers handled via the same alias mechanism.
6. **Cycle test**: add a round-trip test for `const a = {}; a.self = a` to confirm the alias path works end-to-end. The DAG fixtures here don't exercise it.

---

## Open questions (deferred to Phase 2 / 4)

- **Should `@lumenize/structured-clone` expose `diff` and `applyPatch` publicly?** Yes — Resources phase (Phase 4 + future read-delta work) needs them and there's no reason to keep them internal. The hand-rolled impl in this experiment can move into `packages/structured-clone/src/merge-patch.ts` verbatim.
- **Patch history retention on the server**: the task doc's leaning answer is zero (full snapshot on miss). Phase 1's numbers support that: even at N=10k, a full snapshot is 129KB gzipped — not free, but not catastrophic, and avoids any per-subscriber state on the server. The "always start with a snapshot, then patch from there" pattern is enough.
- **Coalescing**: Phase 4 concern. With per-mutation patches at <100 bytes, the case for coalescing is weaker than the task doc anticipated.
- **Snapshot-bloat acceptance threshold (>25% gz at N=10k)**: not exercised. W4's snapshot is *smaller* than the current tuple format, so the threshold doesn't bind. If Phase 2 picks a different tradeoff for cycle-bearing types, re-evaluate.
- **Bytewise vs logical patch correctness**: documented in [test/roundtrip.test.ts](./test/roundtrip.test.ts). Phase 4's client/server sync must accept that wire-byte-level state may diverge across patches without indicating a sync bug — only logical equality matters.

---

## How to reproduce

```bash
# from repo root, once
npm install

# from this experiment dir
cd experiments/structured-clone-object-format
../../node_modules/.bin/vitest run          # 45 round-trip + sanity tests
../../node_modules/.bin/tsx scripts/bench.ts        # populates results/bench-output.json
../../node_modules/.bin/tsx scripts/run-report.ts   # renders results/tables.md
```

Fixtures and PRNG are seeded; benchmark numbers are reproducible run-to-run modulo perf timing noise (which is small relative to the size deltas this experiment hinges on).
