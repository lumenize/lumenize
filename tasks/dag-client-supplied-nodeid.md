# Client-supplied DAG node ids (replace SQLite rowid)

**Status**: **BUILT + DEPLOYED 2026-07-02.** Phases 2–4 built (tsc-green; `dag-tree` 43/43 incl. the 3 new tests + the B1 gate; baseline+frontend 333/333; dev-studio codegen-gate 12/12; server-gen-id audit clean; docs + `@check-example` coupling synced). **Phase 1 SKIPPED** (Larry: migration-proof low-value; Phase 5 subsumes the integration deploy). **Phase 5 DONE** — deleted the `nebula` Workers project + the orphaned `nebula-devcontainer` container app, restored the 5 secrets from `.dev.vars`, redeployed the nodeId working tree onto a fresh DB; `nebula.lumenize.com` live, `/_version` match:true (`dirty` — deployed from the **uncommitted** working tree). **Next: Larry reviews the diff + commits.** Not-run lanes: chromium/ui-smoke (browser+Docker), full login→create-node prod smoke. Was sequenced ahead of `mesh-continuation-only-calls.md` and **before** root-admin Part 2 (see § Design decisions → `ROOT_NODE_ID`).
**Packages**: `apps/nebula/` (`dag-tree.ts`, `dag-ops.ts`, `errors.ts`, `resources.ts`, query-subscription surface, `client.orgTree.*`, `client-index.ts` re-exports), docs (`api-reference.md`, `coding-your-ui.md`)
**Related**: `tasks/archive/nebula-frontend.md` § 5.3.7-v3 (round-4 #8 interim limitation this fixes — **frozen**, don't edit); `tasks/on-hold/nebula-dataplane-root-admin.md` (Part 2 shares `ROOT_NODE_ID`); `tasks/mesh-continuation-only-calls.md` D8 (owns the client in-session strand — see § Scope boundary); `tasks/nebula-pre-alpha.md` § "Data-use consent flag" (the D6 pending prod migration Phase 1 verifies); feedback memory `no-server-generated-ids`; ADR-005/006 (client ids/eTags), ADR-008 (org-tree visibility — the disclosure basis).

## Goal

Make DAG `nodeId` **client-supplied** (a UUID string) instead of server-generated (`last_insert_rowid()`), so `createNode` becomes **idempotent** — a retry with the same id returns the same node — and the ambiguous-disconnect **id-recovery** gap disappears. Aligns `nodeId` with how resources already work (client `resourceId` + `newETag`, ADR-005/006).

## Why

Server-generated ids force an awaited round-trip just to learn the id and make `createNode` non-idempotent. Round-4 #8: an ambiguous in-flight disconnect (the create landed, the response was lost) rejects without returning the id — the node exists but the client can't address it; a same-slug retry errors on slug-uniqueness, a different-slug retry could duplicate. With a **client-minted UUID the client already holds the id**, so it can always address the node it may have created — the id-recovery gap closes regardless of whether the response survived. (Larry: "Don't let me ever agree to [server-generated ids] again.")

## Scope boundary (what this task does NOT do)

Client-supplied ids make retry **safe** (server-idempotent); they do **not** make the client call auto-retry. The client call site stays an **awaited `callRaw` across the WebSocket** (`nebula-client.ts:1043-1048`) — an in-session WS drop still strands the pending Promise ("thinking forever") until timeout. That in-session strand is **out of scope here and owned by `mesh-continuation-only-calls.md` D8** (which explicitly handles "the createNode exception"). This task's contract: (1) server idempotency + the client-supplied-id signature; (2) **interim** in-session recovery is reload → orgTree-resync. Do not build a client re-issue/reconcile leg here — it lands with D8, and this task is what lets D8 drop createNode from its exception list.

## Migration strategy — wipe, don't migrate (the pre-alpha model)

The `nodeId` INTEGER→TEXT change touches a **persisted** column (`Snapshots.nodeId`). Rather than hand-write a primary-key rebuild (create-copy-drop-rename, worse on a `WITHOUT ROWID` table) for prod data we don't need, follow the established pre-alpha model — *"pre-alpha sidesteps migration-testing because users already have wipe"* (`tasks/nebula-pre-alpha.md`): **delete the `apps/nebula` Workers project and redeploy fresh** (Phase 5), so the new schema is greenfield **by construction** and **no data migration is written**. This drops the review's coded-migration + backfill scope; only the **declared** column-type flips remain.

**The ordering trap (why Phase 1 exists):** the wipe destroys the only prod dataset the *currently-pending, never-deployed* in-DO migrations will ever run against — and their post-deploy check (D6) is the only prod-path proof, and the **last chance to validate `@lumenize/sql-migrations` against real data before alpha** (where wipe is gone and migration-*testing* is the hard part). So **Phase 1 deploys current HEAD and captures those proofs BEFORE any nodeId code or the wipe.**

## Design decisions (pinned)

- **id type** — UUID string (`crypto.randomUUID()`), consistent with `sub` / `resourceId`. The **server does not trust the client to send a well-formed id**: `createNode` shape-validates the supplied `nodeId` (v4 UUID) and throws on malformed, exactly as session-id handling already does (`chat-constants.ts`).
- **`createNode` idempotency — pinned ordering (satisfies ADR-005 + ADR-008; this is the security-load-bearing decision):**
  1. `requireNodeExists(parent)` + `requirePermission(parent, 'write')` — **FIRST, before the id-presence check**, re-evaluated on every attempt. This is non-negotiable: the replay path returns the node's **content** (slug + label), so it must be gated exactly like a fresh create. A retry by a caller who has since lost write **fails** (ADR-005 keeps the non-monotonic permission check authoritative per-attempt). *This deliberately differs from the file's other idempotent ops (`addEdge`/`deleteNode`, `dag-tree.ts:202-209`), which short-circuit `requirePermission` because they return only `void` and disclose nothing.*
  2. **Shape-validate** the supplied `nodeId` (UUID v4) — throw on malformed.
  3. **Replay vs conflict** (read `#cached`, after the permission gate): if `nodeId` already exists **and** its stored `slug` + the `parent→nodeId` edge match the request → **replay success**: return the existing node, skip slug-uniqueness (the existing child legitimately holds that slug). If `nodeId` exists but `(parent, slug)` **differs** → client-id collision → **throw** (typed `NodeIdCollisionError`, see below), never a silent `OR IGNORE` of a mismatched create.
  4. Else: `validateSlug` + `checkSlugUniqueness`, then the transaction with **`INSERT OR IGNORE` on Nodes AND the Edge** (today the Edge is a plain `INSERT`, `dag-tree.ts:189`) as harmless defense. **Build finding:** a genuine partial state (node landed, edge didn't) is *unreachable* under atomic `transactionSync`, and any node-already-exists case is caught by step 3 *before* the transaction — so there is no convergence-on-partial-replay path, and collision-throw is the secure choice (converging a same-slug node under a *different* parent would bypass `addEdge`'s admin-on-child guard).
  - **ADR-008 conformance:** the replay path *runs* `requirePermission` every attempt, so it is **not** a permission-skipping short-circuit — strictly more conformant than the `addEdge`/`deleteNode` analogy. The only ADR-008-relevant disclosure is the **collision throw**, which reveals only that a caller-named id exists **globally** (the `Nodes` PK is Star-wide, not parent-scoped) — sound because the tree is universally visible within the Star. If tree visibility ever goes per-branch, revisit the collision throw with the other short-circuits.
  - **Collision + existing typed errors cross the mesh hop** — custom `Error` subclasses lose `instanceof` over Star→client (`mesh.md` § Errors). `NodeIdCollisionError` follows the `OntologyStaleError` template (`override name`, a discriminating own prop, an exported `isNodeIdCollisionError` checking `name` + own-prop — **never** `instanceof`). And note `errors.ts` already carries `nodeId` on `PermissionDeniedError`/`NodeNotFoundError` whose guards assert `typeof nodeId === 'number'` — those flip to `'string'` (see Blast radius; a missed flip silently returns `false` for every real error).
- **`ROOT_NODE_ID`** — a fixed **string sentinel** constant (replaces `= 1`, `dag-ops.ts:8`), seeded at construction by `#ensureRoot`. **Sequencing:** this detour lands **before** root-admin Part 2 (last-admin protection — reviewed, unbuilt) and the Part-1 DataPlane-lift; both are authored against the string sentinel. Type-safe: every consumer imports the const, so a `1`-vs-string mismatch fails type-check, not silently. `SESSION_NODE_ID` (`chat-constants.ts`) flips type with it.
- **write-cost** — `nodeId TEXT PRIMARY KEY` **requires** `WITHOUT ROWID` on `Nodes` (else SQLite keeps a hidden rowid *and* a separate text-PK index, doubling INSERT cost — `durable-objects.md` § SQLite write-cost). Edges/Permissions are already `WITHOUT ROWID`.

## Blast radius (grep-driven — re-run at build time, don't trust a written-time list)

`nodeId` is an FK/type woven across the platform. **This is a TYPE change (`number → string`), not a text replace** — let `npm run type-check` drive most of it, but note the **silent-drift traps** below (loose SQLite typing, `typeof` guards, vacuous validation) that type-check will *not* catch. A naive `sed` of `: number` / `Set<number>` / `Map<number` also hits unrelated numerics (`workflow.md` § symbol renames). Enumerate live sites at build time:

```sh
grep -rn 'nodeId\|nodeIds' apps/nebula/src            # engine + wire + client + errors
grep -rn ': number\|Set<number>\|Map<number' apps/nebula/src/dag-tree.ts apps/nebula/src/dag-ops.ts
grep -rn 'deniedNodes' apps/nebula/src                # query-subscription channel
grep -rln 'nodeId' apps/nebula/**/test/               # ~40 test files at time of writing
```

Surfaces (all confirmed 2026-07-02):
- **Engine** — `dag-tree.ts` (Nodes PK; `createNode`; `#ensureRoot`; the three `=== ROOT_NODE_ID` guards `:295/312/329`; **~16** `number`-typed signatures incl. `evaluatePermissions(nodeIds: number[]): { allowed/denied: Set<number> }` `:422` — *not* just the 10 mutators) and `dag-ops.ts` (`EdgeKey` `` `${number}:${number}` `` → `` `${string}:${string}` ``; `makeEdgeKey`; `DagTreeState`/`DagTreeView` Map/Set generics; the pure `resolvePermission`/`detectCycle`/`checkSlugUniqueness`/traversal fns). **Engine symbol names are `EdgeKey`/`DagTreeState`/`buildDagTreeView`**; `client-index.ts:58/63/66` re-exports them under the `OrgTree*` aliases (type-only — flips with the generic, verify).
- **Declared column types (⚠️ SQLite loose-typing trap)** — three FK columns declared `INTEGER` reference `Nodes.nodeId`: `Edges.parentNodeId`/`childNodeId` (`dag-tree.ts:53-54`), `Permissions.nodeId` (`:63`), `Snapshots.nodeId` (`resources.ts:85`, FK `:95`). All must flip declared `INTEGER→TEXT`. **SQLite stores a TEXT UUID under INTEGER affinity without erroring** — no type-check, no test failure — so a missed flip silently leaves a schema that lies about its contents. **No data migration for any of them** — the fresh schema declares TEXT and Phase 5 wipes + redeploys prod, so it's greenfield by construction.
- **Typed errors** — `errors.ts`: `PermissionDeniedError.nodeId` (`:55`) and `NodeNotFoundError.nodeId` (`:78`), both fields **and** their guards' `typeof … === 'number'` checks (`:65/:87`) → `'string'`; add `NodeIdCollisionError`.
- **Resource-op wire shape** — `SnapshotMeta.nodeId`, `OperationDescriptor` create/move `nodeId`, `TransactionError.permission.nodeId` (`resources.ts:30/46/48/54`); mirrored in `codegen-gate.ts:55/57/77`, `frontend/conflict-outcome.ts:100/102`.
- **Query-subscription channel** — `deniedNodes: number[]` as **wire type** (`query-hash.ts:54`, `resource-data-plane.ts:362-365`) **and public client API** (`nebula-client.ts:98/110`); `evaluatePermissions` call at `resource-data-plane.ts:148`. Because the denied set drives request-access (ADR-008), this is a **client-facing wire-format change**.
- **orgTree broadcast** — the `DagTreeState` snapshot Map/Set key types.
- **Client API** — `client.orgTree.createNode` signature (+ its awaited `callRaw` site + the "server-assigned nodeId" comment, `nebula-client.ts:1043-1048`); `SESSION_NODE_ID` travel (`nebula-client.ts:1438`).
- **Docs** — `api-reference.md` (createNode signature; the before-check no-op / M7 disclosure list at `:449`); `coding-your-ui.md` orgTree examples + the "all-digits nodeId" collision-safety note (`:546/555`).

## Phase 1 — Deploy current HEAD + verify pending prod migrations (prerequisite; before any nodeId code)

**Goal**: capture the D6 prod-path proofs for the pending in-DO migrations that the Phase-5 wipe will erase — the last chance to validate them against real prod data before alpha. This doubles as the overdue integration deploy of everything landed since 2026-06-26 (chat thread, query subs, …).

**Success Criteria**:
- [ ] Deploy current `pre-alpha` HEAD (pre-nodeId) to `nebula.lumenize.com` via `deploy.sh`.
- [ ] Enumerate every in-DO `@lumenize/sql-migrations` migration landed since the 2026-06-26 deploy (`git log` + the migration call sites — self-verifying, not a hand-list). Known: `improveProductConsent` on `NebulaAuthRegistry.Instances` (D6, "the first prod DO schema migration") and `accessAdmin` on `Subscribers` (Child-2 query subs).
- [ ] For each: confirm it self-applied against real prod data with **no error**, the new column exists, and existing data survived + reads correctly. **Record the findings in this file** — they are not reproducible after the wipe.
- [ ] End-to-end smoke on the pre-nodeId deploy (login → claim → develop → chat) confirms the accumulated changes are healthy before building on them.

## Phase 2 — Engine + storage

**Goal**: `nodeId` is a client-supplied UUID string end-to-end inside the Star; `createNode` idempotent per the pinned ordering; `ROOT_NODE_ID` a string sentinel.

**Success Criteria**:
- [ ] `Nodes` is `nodeId TEXT PRIMARY KEY … WITHOUT ROWID`; the three FK columns (`Edges` ×2, `Permissions`) declared `TEXT`; `createNode` drops `last_insert_rowid()`, takes + shape-validates the caller id, both inserts `OR IGNORE`, with the pinned permission-**first** ordering.
- [ ] `dag-tree.ts` + `dag-ops.ts` + `errors.ts` type-check clean with `nodeId: string`; both error guards' `typeof` checks flipped to `'string'`; `NodeIdCollisionError` + `isNodeIdCollisionError` added.
- [ ] `ROOT_NODE_ID` is the string sentinel; the three guards + `#ensureRoot` + the `star.ts:122` root-admin seed still function.

**Tests** (capable-of-failing; each its own `uniqueStar()`; DagTree mutators are synchronous under a single-threaded DO, so "concurrent" reduces to sequential):
- [ ] **Server-surface idempotency** (direct `DagTree`/`Star`, not the client leg — per § Scope boundary): `createNode(id, …)` twice, same id → one node; the second returns it. A non-idempotent impl creates two / errors.
- [ ] **Replay-after-revoke (B1 security gate):** caller creates X with write; revoke write on parent; retry `createNode(sameId)` → **PermissionDenied, not replay-success**.
- [ ] **id-collision:** same id, **different** `(parent | slug)` → `NodeIdCollisionError` thrown, **not** a silent no-op. Malformed (non-UUID) id → throws.
- [x] **id-collision / mismatch** (supersedes the unreachable "partial-replay convergence" — see the createNode decision above): reused id with a **different slug** → `NodeIdCollisionError` (never a silent converge); malformed (non-UUID) id → `validateNodeId` throws. Covered by the `collision & shape` test. *(No fault-injected converge test — a node-without-edge state is unreachable under atomic `transactionSync`, and converging would be the security hole above.)*
- [ ] **Test-port work is explicit, not "translate":** delete numeric-ordering asserts (`dag-tree.test.ts:157` `toBeGreaterThan(ROOT_NODE_ID)`, any `nodeId > N`) — type-invalid on UUIDs, not translatable; change `callStarCreateNode`/create initiators (`baseline/index.ts:573-575`) to take a caller-supplied `nodeId` and drop the `lastResult as number` id-capture (~40 sites); rework returned-id assertions to "node exists under the caller's id." A bare `as number`→`as string` compiles + passes, so type-check will **not** flag this — enumerate it.
- [ ] **Client-facing e2e recovery** — `it.skip` with a pointer: the in-session strand + client re-issue land with `mesh-continuation-only-calls.md` D8, not here.

## Phase 3 — Resource + query-subscription + client wire surface

**Goal**: every off-engine surface carrying `nodeId` flips to string. **No data migration** — the fresh schema declares TEXT and Phase 5 wipes + redeploys, so it's greenfield by construction.

**Success Criteria**:
- [ ] `Snapshots.nodeId` **declared** TEXT (`resources.ts:85`); **no backfill / migration code** (Phase 5 wipe).
- [ ] Resource-op wire shape (`SnapshotMeta`/`OperationDescriptor`/`TransactionError`, `codegen-gate.ts`, `conflict-outcome.ts`) typed string; `evaluatePermissions` + `deniedNodes` (wire type **and** client API) string.
- [ ] `client.orgTree.createNode(nodeId, parentNodeId, slug, label)`; the awaited-`callRaw` comment (`nebula-client.ts:1043-1044`) updated from "server-assigned / non-replayable" to "client-supplied id, server-idempotent; in-session delivery via mesh D8"; `SESSION_NODE_ID` string.

**Tests**:
- [ ] `DagTreeState` / orgTree broadcast wire round-trip with string node/edge keys.
- [ ] A denied query returns `deniedNodes` as **string** ids across the Star→client hop (the ADR-008 disclosure path).
- [ ] Resource create/move op — assert what actually changes (typia validates the *value*, never `op.nodeId`, so "validates" alone is vacuous): a string `nodeId` round-trips the wire `OperationDescriptor`, persists to `Snapshots.nodeId` as **TEXT**, reads back identical, and `requirePermission(op.nodeId, 'write')` resolves against the string-keyed `DagTree`. *(Invariant to note, not test: the replay id-existence check reads the post-`#invalidate` `#cached` view, so a second same-id create observes the first's committed node — no cross-transaction race in a single-threaded DO.)*

## Phase 4 — Docs + audit

**Success Criteria**:
- [ ] `api-reference.md` createNode → "idempotent, caller supplies id"; the before-check no-op / disclosure list (`:449`) updated to state `createNode` is **deliberately excluded** (it enforces `requirePermission` first because it returns content, unlike the void no-ops). The client-facing caveat is **rewritten, not deleted**: "server-idempotent on a client-supplied id; in-session delivery/strand handled by mesh D8; interim recovery is reload → resync."
- [ ] `coding-your-ui.md` orgTree examples updated; the "all-digits nodeId" collision-safety rationale (`:546/555`) **re-justified** under string ids (virtual `__deleted__`/`__orphaned__` sentinels are underscore-prefixed; a UUID can never equal a sentinel — still safe, but the all-digits reasoning is now false). It lives in prose + a stripped comment, so `@check-example` can't catch it — make it an explicit criterion.
- [ ] **Bounded server-generated-id audit** ([[no-server-generated-ids]] standing sweep): `grep -rn 'last_insert_rowid\|AUTOINCREMENT' apps/nebula/src packages/*/src` returns **zero** hits, and each remaining `INTEGER PRIMARY KEY` is confirmed an intentional non-entity rowid. Resources' client `resourceId` + `newETag` is the reference pattern. Flag any survivor to `tasks/backlog.md`.

## Phase 5 — Wipe + redeploy (replaces the Snapshots migration) + merge-back

**Goal**: bring up the new TEXT-`nodeId` schema on a clean prod slate; no data migration written. **Gate: do NOT wipe until Phase 1's migration proofs are recorded** — they are irreproducible afterward.

**Success Criteria**:
- [ ] Merge the nodeId change into the deploy branch; `wrangler delete` the `apps/nebula` Workers project (nothing to preserve — confirmed).
- [ ] Redeploy fresh via `deploy.sh`; re-put all per-Worker secrets (`NEBULA_AUTH_BOOTSTRAP_EMAIL`, `TURNSTILE_SECRET_KEY`, the JWT signing key, email); re-attach the `nebula.lumenize.com` custom domain (+ `workers_dev:true` fallback); re-push the DevContainer image. The frozen `migrations v1` block re-registers fresh (clean slate — resets the one-way door).
- [ ] Verify fresh: `/_version` match; real-email login → self-provision (Larry re-claims his Universe) → develop → chat; a created node's `nodeId` is a UUID string (TEXT schema live).
- [ ] Merge-back admin: flip the round-4 #8 interim-limitation note in the **live** `api-reference.md` — the archived `nebula-frontend.md:411` is **frozen**, do not edit; archive this file to `tasks/archive/`.
