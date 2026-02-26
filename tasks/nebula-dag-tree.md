# DAG Tree Access Control

**Phase**: 3
**Status**: Pending
**Package**: `@lumenize/nebula`
**Depends on**: Phase 2 (Baseline Access Control)
**Master task file**: `tasks/nebula.md`

## Goal

Port the DAG tree from `lumenize-monolith` (and possibly other repos) into `packages/nebula/`. Build the full access control model where every resource attaches to exactly one node in a directed acyclic graph, permissions roll down through the tree, and a node is accessible if **any** ancestor path grants the required permission. Replace Phase 2's dummy methods and simple guards with DAG-aware access control. Greatly refactor the Phase 2 test suite.

## Prior Art

- **`lumenize-monolith/src/entities.ts`**: Has `parentId` column and `idx_snapshots_hierarchy` index. Foundation for tree structure but no traversal code.
- **`lumenize-monolith/prompts/to-do/higher-level-DOs.md`**: Describes the org tree concept — entity instances attached to branches, people granted permissions per branch.
- **Cycle detection code**: Exists somewhere (possibly another repo). Locate and port.

## Access Control Model

### Permission Levels

Three levels, strictly ordered:

| Level | Can Do |
|-------|--------|
| **admin** | Grant/revoke permissions, plus everything write can do |
| **write** | Create/update/delete resources, plus everything read can do |
| **read** | Read resources and subscribe to updates |

### DAG Tree Properties

- Every resource attaches to **exactly one** node in the tree
- The tree is a **DAG** (directed acyclic graph) — a node may have multiple parents, so the same node can be reached via multiple paths
- Permissions are granted **per-node, per-subject**
- Permissions **roll down**: granting `write` on a node grants `write` on all descendants
- **Any-path grant**: If a subject can reach a node via any path where an ancestor grants the required permission, access is granted. (The subject doesn't need permission on all paths — just one.)
- Higher permissions subsume lower: `admin` implies `write` implies `read`

### How It Bridges Auth and Resources

```
nebula-auth (identity)          DAG tree (authorization)         Resources (data)
┌──────────────────┐           ┌──────────────────┐             ┌──────────────┐
│ Who is this?     │           │ What can they do? │             │ Can they do   │
│ JWT: sub, email, │──────────▶│ Node permissions  │────────────▶│ this specific │
│ role, access.id  │           │ Ancestor rolldown │             │ operation?    │
└──────────────────┘           └──────────────────┘             └──────────────┘
```

- **Phase 2** established: JWT identity → `onBeforeCall` → `callContext.state`
- **Phase 3** adds: `callContext.state` → DAG permission lookup → method-level guard decision
- **Phase 5** will add: guard decision → resource operation (upsert/delete/read/subscribe)

## SQL Schema

```sql
-- DAG nodes (each node is a point in the org tree)
CREATE TABLE Nodes (
  nodeId TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parentId TEXT,               -- Primary parent (null for root)
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (parentId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- DAG edges (multiple parents for DAG — parentId in Nodes is the "primary" parent)
CREATE TABLE Edges (
  parentNodeId TEXT NOT NULL,
  childNodeId TEXT NOT NULL,
  PRIMARY KEY (parentNodeId, childNodeId),
  FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
  FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

-- Permissions granted per-node, per-subject
CREATE TABLE Permissions (
  nodeId TEXT NOT NULL,
  sub TEXT NOT NULL,            -- Subject identifier (from JWT sub claim)
  permission TEXT NOT NULL CHECK(permission IN ('admin', 'write', 'read')),
  grantedBy TEXT NOT NULL,      -- Sub of the admin who granted this
  grantedAt INTEGER NOT NULL,
  PRIMARY KEY (nodeId, sub),
  FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
) WITHOUT ROWID;

CREATE INDEX idx_Permissions_sub ON Permissions(sub);
```

**Design questions to resolve**:
- Do we need a materialized closure table for ancestor queries, or is recursive CTE sufficient at the scale of a single DO's tree?
- Should Edges include the primary parent edge redundantly, or is it only for additional DAG parents?
- How do we handle node deletion (cascade permissions? orphan check? soft delete?)

## Permission Resolution Algorithm

Given a subject and a target node, determine the effective permission:

1. Find all ancestor paths from the target node to any root
2. For each node along any path, check if the subject has a direct permission grant
3. The effective permission is the **highest** permission found on any ancestor (including the node itself)
4. If no permission is found on any path, access is denied

```
Example tree:
    root
   /    \
  A      B
   \    /
     C       ← resource attached here
     |
     D

Subject has: write on A, read on B

Accessing C:
  Path 1: root → A → C → subject has "write" on A → effective: write
  Path 2: root → B → C → subject has "read" on B → effective: read
  Result: write (highest from any path)

Accessing D:
  Path 1: root → A → C → D → subject has "write" on A → rolls down → effective: write
  Result: write
```

## Guard Integration

Phase 2's standalone guard functions get augmented with DAG awareness:

```typescript
// Enhanced guard — checks DAG permissions instead of just JWT claims
export function requirePermission(level: 'admin' | 'write' | 'read') {
  return (instance: NebulaDO) => {
    const state = instance.lmz.callContext.state;
    const targetNodeId = state.targetNodeId;  // Set by the method or request routing
    const sub = state.sub;

    const effectivePermission = instance.resolvePermission(sub, targetNodeId);
    if (!hasPermission(effectivePermission, level)) {
      throw new Error(`Requires ${level} access`);
    }
  };
}
```

## Cycle Detection

DAG property must be enforced on every edge insertion. Cycle detection code exists in a prior project — locate and port. If not found, implement:
- On `addEdge(parent, child)`: verify that `parent` is not a descendant of `child` (would create a cycle)
- Recursive CTE or iterative traversal from `child` upward checking for `parent`
- This is a write-time check only — reads don't need it

## Test Plan

Refactor Phase 2's test suite substantially. Most Phase 2 tests that used dummy methods get replaced with tests that exercise the DAG tree directly.

### Scenarios

**Tree construction**:
- Create nodes, add edges, verify structure
- Attempt to create a cycle → rejected
- Multiple parents (DAG, not just tree)

**Permission rolldown**:
- Grant `admin` on root → effective `admin` on all descendants
- Grant `write` on middle node → `write` on descendants, no access on siblings
- Multiple paths with different permissions → highest wins

**Permission boundaries**:
- No permission on any ancestor → denied
- Permission on one path but not another → granted (any-path rule)
- Revoking permission from an ancestor → descendants lose access

**Integration with auth identity**:
- Universe admin (wildcard JWT) → full access to all nodes
- Star-level user → access only within their star's tree
- Cross-scope admin access through the guard chain

**Abuse cases**:
- Attempt to grant permissions without admin on the target node → rejected
- Attempt to escalate own permissions → rejected
- Deleted node access → rejected
- Permission on a node that was removed from a path → verify rolldown updates correctly

## What Gets Replaced Later

- **Dummy methods from Phase 2**: Fully removed, replaced by real resource methods in Phase 5
- **Some tests**: Replaced by integrated Resources + DAG tests in Phase 5
- **Permission resolution may be optimized**: Phase 5 might cache resolved permissions per-request or use materialized paths

**What survives**: The DAG tree schema, cycle detection, permission resolution algorithm, standalone guard functions, and the core test scenarios for tree construction and permission rolldown.

## Success Criteria

- [ ] DAG tree schema in NebulaDO's SQLite (Nodes, Edges, Permissions tables)
- [ ] CRUD operations for nodes and edges with cycle detection
- [ ] Permission grant/revoke operations (admin-only)
- [ ] Permission resolution: ancestor rolldown with any-path-grants semantics
- [ ] Guards use DAG permissions (not just JWT claims) for method-level access control
- [ ] Abuse case tests: cycle attempts, permission escalation, scope mismatch, boundary violations
- [ ] Phase 2 test suite refactored to use real DAG access control
- [ ] Cycle detection ported from prior work (or implemented fresh)
