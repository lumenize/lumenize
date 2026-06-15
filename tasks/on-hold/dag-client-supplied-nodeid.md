# Client-supplied DAG node ids (replace SQLite rowid)

**Status**: On Hold — designed, not started (2026-06-14, round-4 #8 fallout). Offline detour: build + fully test in isolation, merge back when green. **NOT a 5.3.7-v3 blocker** — v3 ships with the documented interim limitation; this upgrades it whenever it lands.
**Packages**: `apps/nebula/` (`dag-tree.ts`, `dag-ops.ts`, the `client.orgTree.*` namespace, `client-index.ts` re-exports), docs (`api-reference.md`, `coding-your-ui.md`)
**Related**: `tasks/nebula-frontend.md` § Phase 5.3.7-v3 (round-4 #8 interim limitation this fixes); feedback memory `no-server-generated-ids`; ADR-005 (client-supplied eTags — the reference pattern)
**Relevant engine**: `apps/nebula/src/dag-tree.ts` (`createNode` `:173` uses `last_insert_rowid()`; Nodes/Edges/Permissions schema `:46-66`), `apps/nebula/src/dag-ops.ts` (`ROOT_NODE_ID = 1` `:8`, `OrgTreeEdgeKey`, `buildOrgTreeView`, `getState`)

## Goal

Make DAG `nodeId` **client-supplied** instead of server-generated (`last_insert_rowid()`), so `createNode` becomes **idempotent** (a retry returns the same node) and the ambiguous-disconnect id-recovery gap disappears. Aligns `nodeId` with how resources already work (client `resourceId` + `newETag`).

## Why

`nodeId` is currently a SQLite auto-increment rowid. Server-generated ids are a distributed-systems smell (feedback memory `no-server-generated-ids`): they force an awaited round-trip just to learn the id and make `createNode` non-idempotent. The concrete failure (round-4 #8): an ambiguous in-flight disconnect (the create landed, the response was lost) rejects without returning the id — the node exists but the client can't address it; a same-slug retry errors on slug-uniqueness, a different-slug retry could duplicate. Client-supplied ids make `createNode` idempotent and decouple id assignment from the round-trip. (Larry: "Don't let me ever agree to [server-generated ids] again.")

## Blast radius (why it's a detour, not an inline fix)

`nodeId` changes from `INTEGER` rowid to a client-supplied id everywhere:
- **`dag-tree.ts`**: `Nodes` PK (`nodeId INTEGER PRIMARY KEY` → text id + `WITHOUT ROWID`); `createNode` drops `last_insert_rowid()`, accepts the caller-supplied id, and becomes idempotent (`INSERT OR IGNORE`; on replay return the existing node — success — instead of erroring); `Edges` (`parentNodeId`/`childNodeId`) + its PK/index; `Permissions` (`nodeId`); all 10 mutator signatures; `getState()` synth.
- **`dag-ops.ts`**: `ROOT_NODE_ID` (`= 1` → a fixed sentinel constant); `OrgTreeEdgeKey` (`` `${number}:${number}` `` → `` `${string}:${string}` ``); `nodes` Map key (number → string); `buildOrgTreeView`.
- **Wire format**: the orgTree broadcast snapshot (`OrgTreeState`) — nodes Map key + edges Set key types.
- **`client.orgTree.createNode`**: caller supplies the id (`createNode(nodeId, parentNodeId, slug, label)`); returns `void` (or the id, for symmetry).
- **Docs**: `api-reference.md` (createNode signature + drop the "non-idempotent" caveat → "idempotent, caller supplies id"); `coding-your-ui.md` orgTree examples.
- **Tests**: all `dag-tree` tests + `apps/nebula/test/test-apps/baseline/dag-tree.test.ts`.

## Design decisions to pin (at kickoff)

- **id type**: UUID string (consistent with `sub` / `resourceId`) — lean. (Alt: client-gen integer — rejected, UUID is the house style.)
- **`ROOT_NODE_ID`**: a reserved constant (string sentinel) instead of `1`; seeded at Star creation (coordinate with `tasks/nebula-star-root-admin.md` Part 1).
- **idempotency**: `createNode` with an already-present id → return the existing node (success), not an error. Slug-uniqueness still applies to genuinely-different ids sharing a slug under a parent.
- **write-cost**: text PK + `WITHOUT ROWID` per `.claude/rules/durable-objects.md` § SQLite write-cost (compound PKs already `WITHOUT ROWID`; keep it).

## Tests

- `createNode(id, …)` twice with the **same** id → one node; the second returns it (idempotent). Capable-of-failing: a non-idempotent impl creates two / errors.
- Ambiguous-disconnect simulation: in-flight `createNode` drops → retry with the **same** id → same node, id recovered (no duplicate, no "slug exists" dead-end).
- Greenfield: no production DAG data yet → **no migration needed** (note it; if that changes, add a rowid→uuid backfill).
- Full `dag-tree` suite ported to string ids; `OrgTreeState` wire round-trip with string node/edge keys.

## Also audit (per the principle)

Sweep for any **other** server-generated id in the codebase. Resources already use client-supplied `resourceId` + `newETag` (correct — reference pattern). Flag anything else.

## Merge-back

When green in isolation: fold into the live tree; flip the round-4 #8 interim-limitation note in `nebula-frontend.md` to "fixed"; update `api-reference.md` createNode (idempotent, caller-supplied id) + drop the non-idempotency caveat; archive this file to `tasks/archive/`.
