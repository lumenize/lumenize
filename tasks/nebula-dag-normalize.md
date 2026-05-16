# Nebula DAG In-Memory Normalization

**Status**: Not started — next up, pre-demo
**Context**: Originally Phase 3 of [tasks/archive/structured-clone-object-based-wire-format.md](archive/structured-clone-object-based-wire-format.md). Extracted to its own task when that file was archived (Phases 1+2 of the wire format shipped 2026-05-16; Phase 3 still pending; Phase 4 moved to [tasks/on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md)).

## Goal

Normalize `DagTreeState` from inline-adjacency (`{ ..., parentIds[], childIds[] }` per node) to a normalized `{ nodes, edges, permissions }` shape with derived adjacency indexes on the DO class. Baseline test-app green at the same count as today.

## Why now (pre-demo)

1. **Aligns with how storage already works** — SQL is already `Nodes` + `Edges` tables. The in-memory denormalization step adds complexity without buying us anything.
2. **Enables Palantir-style edge metadata** later (typed edges, link properties). Tacking edge attributes onto inline `childIds: number[]` is impossible; doing it on a normalized edges table is mechanical.
3. **Prerequisite for the merge-patch DAG-tree sync work** in [tasks/on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md) — under merge-patch, inline adjacency arrays would force whole-array replacement on every edge change, defeating the diff benefit. With normalized `edges`, adding a node = two key flips.

## Files in scope (verified via grep, 2026-05-16)

Only three files read `parentIds` / `childIds` directly:

- [apps/nebula/src/dag-ops.ts](../apps/nebula/src/dag-ops.ts) — pure-logic adjacency walks + cycle detection
- [apps/nebula/src/dag-tree.ts](../apps/nebula/src/dag-tree.ts) — DO methods that mutate state and rebuild it from storage
- [apps/nebula/test/test-apps/baseline/dag-tree.test.ts](../apps/nebula/test/test-apps/baseline/dag-tree.test.ts) — integration coverage

Nothing in `star.ts`, `nebula-client.ts`, `resources.ts`, `subscriptions.ts`, or `galaxy.ts` references the adjacency arrays. Blast radius is just the three files above.

## What to do

1. **Change `DagTreeState`** type to:
   ```ts
   {
     nodes: Map<number, { slug, label, deleted }>;
     edges: Set<`${parentId}:${childId}`>;
     permissions: Map<number, Map<string, PermissionTier>>;
   }
   ```
   `NodeData` loses `parentIds` and `childIds`.

2. **Add `#childrenByParent` and `#parentsByChild`** as private DO fields on the `DagTree` class. Build them from `state.edges` in `#buildState()`.

3. **Add an index-maintenance helper** (`#addEdge(parent, child)` / `#removeEdge(parent, child)`) that mutates `state.edges` and both indexes atomically. All edge mutations go through these helpers — no direct `state.edges.add()` from callers.

4. **Refactor [dag-ops.ts](../apps/nebula/src/dag-ops.ts)** — `detectCycle`, ancestor walks, descendant walks now take the indexes (or a state-with-indexes view) rather than reading `node.parentIds` / `node.childIds`. Signatures updated.

5. **Update [dag-tree.ts](../apps/nebula/src/dag-tree.ts) mutation methods** — `addChild`, `removeChild`, `move` (or whatever they're called) now go through `#addEdge` / `#removeEdge`.

6. **Update [dag-tree.test.ts](../apps/nebula/test/test-apps/baseline/dag-tree.test.ts)** — assertions over `state.parentIds` / `state.childIds` become assertions over `state.edges` (or via helper methods on the test client). Test scope unchanged.

## Design decisions (carried forward from the original task)

- **Derived indexes live on the DO class, not in `state`.** State is canonical-and-shippable; indexes are local-only, rebuilt from edges on construction.
- **Permissions stay nested** (`Map<nodeId, Map<sub, tier>>`). Encoded as nested objects on the wire, merge-patch addresses inner grants natively. No flattening to composite keys.
- **In-memory shape mirrors wire shape.** When wire patches land (separate task), `preprocess(state)` produces the wire form directly — no projection layer.

## Success criteria

- `npx vitest run` in `apps/nebula/` baseline test-app green at the same count as the pre-refactor baseline.
- `npm run type-check` clean across `apps/nebula`.
- `getState()` returns the new shape.
- No direct reads of `parentIds` / `childIds` remain anywhere in `apps/nebula/`.

## Pre-flight

Before starting, confirm `getState()` is not relied upon by anything published in `@lumenize/nebula`'s exported API beyond `apps/nebula/`. If it is, that's a separate breaking-change conversation. (As of 2026-05-16, only the baseline integration test references it.)

## Out of scope

- Wire-format patches (the merge-patch fanout / read-sync work) — see [tasks/on-hold/wire-merge-patch-sync.md](on-hold/wire-merge-patch-sync.md).
- Edge metadata (typed edges, link properties) — design space opens up after this, but not part of this task.
- Storage schema changes — none needed; SQL is already normalized.
