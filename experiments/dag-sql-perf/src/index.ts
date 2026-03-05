/**
 * DAG SQL Performance Experiment
 *
 * Measures real-world latency of DAG operations using SQLite inside a Durable Object.
 * Tests the N+1 iterative approach (simple SQL queries in JS loops) against the
 * decision gate: resolvePermission p95 < 5ms.
 *
 * Tree shape: ~500 nodes, 8 levels (depth 0–7), 5 DAG edges (diamonds).
 * Measurement: Node.js WebSocket client times each operation individually.
 * DO clock is frozen during synchronous execution, so timing must be client-side.
 */

import { DurableObject } from 'cloudflare:workers'

// Permission tier ranking — higher number = higher privilege
const TIER_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 }

/**
 * Branching factors per level to build a tree of ~500 nodes across 8 levels (depth 0–7).
 *
 * Level 0→1: 4 children
 * Level 1→2: 3 children each (12 new)
 * Level 2→3: 2 children each (24 new)
 * Level 3→4: 2 children each (48 new)
 * Level 4→5: 2 children each (96 new)
 * Level 5→6: 2 children each (192 new)
 * Level 6→7: 1 child each (capped at ~500 total)
 */
const BRANCHING_FACTORS = [4, 3, 2, 2, 2, 2, 1]

export class DagSqlPerfDO extends DurableObject<Env> {
  // Captures the FK pragma default BEFORE we enable it — diagnostic only
  #fkDefault: number = -1

  /**
   * Handle fetch — only WebSocket upgrades
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    return new Response('DAG SQL Perf Experiment — connect via WebSocket', { status: 200 })
  }

  /**
   * Handle WebSocket messages from the Node.js test client
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    try {
      const msg = JSON.parse(message)

      if (msg.action === 'seed') {
        const result = this.#seed()
        ws.send(JSON.stringify({ type: 'seeded', ...result }))
      } else if (msg.action === 'run') {
        const result = this.#runOperation(msg.op, msg.params)
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result }))
      } else {
        ws.send(JSON.stringify({ type: 'error', error: `Unknown action: ${msg.action}` }))
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: (error as Error).message }))
    }
  }

  // ─── Schema + Seeding ──────────────────────────────────────────────

  /**
   * Create tables and seed ~500 nodes with DAG edges and permission grants.
   * Idempotent — skips if data already exists.
   *
   * Returns tree stats and pre-computed test targets for the measurement client.
   */
  #seed(): {
    stats: { nodeCount: number; edgeCount: number; dagEdgeCount: number }
    foreignKeys: { defaultValue: number; currentValue: number; enforcementWorks: boolean }
    testTargets: Record<string, { op: string; params: Record<string, unknown>; note: string }>
    levelNodes: number[][]
  } {
    // Check if already seeded
    this.#createTables()
    const existing = this.ctx.storage.sql.exec('SELECT COUNT(*) as c FROM Nodes').one()
    if (existing && (existing.c as number) > 0) {
      return this.#buildSeedResponse()
    }

    // ── Build tree ──
    let nextNodeId = 0
    const levelNodes: number[][] = []

    // Root
    this.ctx.storage.sql.exec('INSERT INTO Nodes (nodeId, slug) VALUES (0, ?)', 'root')
    levelNodes.push([0])

    for (let level = 0; level < BRANCHING_FACTORS.length; level++) {
      const bf = BRANCHING_FACTORS[level]
      const nextLevel: number[] = []

      for (const parentId of levelNodes[level]) {
        for (let c = 0; c < bf; c++) {
          nextNodeId++
          if (nextNodeId >= 500) break

          this.ctx.storage.sql.exec(
            'INSERT INTO Nodes (nodeId, slug) VALUES (?, ?)',
            nextNodeId, `n${nextNodeId}`,
          )
          this.ctx.storage.sql.exec(
            'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
            parentId, nextNodeId,
          )
          nextLevel.push(nextNodeId)
        }
        if (nextNodeId >= 500) break
      }

      levelNodes.push(nextLevel)
      if (nextNodeId >= 500) break
    }

    // ── DAG edges (diamonds) — 5 extra edges creating multiple-parent nodes ──
    const dagPairs: [number, number][] = []
    if (levelNodes[3] && levelNodes[4]) {
      // Give some level-4 nodes a second parent from a different level-3 node
      const tryAdd = (parentIdx: number, childIdx: number) => {
        const parent = levelNodes[3][parentIdx]
        const child = levelNodes[4][childIdx]
        if (parent != null && child != null) dagPairs.push([parent, child])
      }
      tryAdd(0, 5)
      tryAdd(2, 10)
      tryAdd(5, 15)
    }
    if (levelNodes[2] && levelNodes[3]) {
      const tryAdd = (parentIdx: number, childIdx: number) => {
        const parent = levelNodes[2][parentIdx]
        const child = levelNodes[3][childIdx]
        if (parent != null && child != null) dagPairs.push([parent, child])
      }
      tryAdd(1, 8)
      tryAdd(3, 12)
    }
    for (const [parent, child] of dagPairs) {
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO Edges (parentNodeId, childNodeId) VALUES (?, ?)',
        parent, child,
      )
    }

    // ── Permission grants ──
    // admin-root: admin on root (node 0) — covers everything
    this.ctx.storage.sql.exec(
      'INSERT INTO Permissions (nodeId, sub, permission) VALUES (0, ?, ?)',
      'admin-root', 'admin',
    )

    // write-dept: write on a level-2 node — covers its subtree
    if (levelNodes[2] && levelNodes[2][0] != null) {
      this.ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?)',
        levelNodes[2][0], 'write-dept', 'write',
      )
    }

    // read-team: read directly on a level-4 node
    if (levelNodes[4] && levelNodes[4][0] != null) {
      this.ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?)',
        levelNodes[4][0], 'read-team', 'read',
      )
    }

    // deep-admin: admin on a level-6 node
    if (levelNodes[6] && levelNodes[6][0] != null) {
      this.ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?)',
        levelNodes[6][0], 'deep-admin', 'admin',
      )
    }

    // diamond-write: write on levelNodes[3][0] — only reachable via DAG edge
    // for levelNodes[4][5] (whose primary parent is levelNodes[3][2])
    if (levelNodes[3] && levelNodes[3][0] != null) {
      this.ctx.storage.sql.exec(
        'INSERT INTO Permissions (nodeId, sub, permission) VALUES (?, ?, ?)',
        levelNodes[3][0], 'diamond-write', 'write',
      )
    }

    // Store level structure for re-hydration after eviction
    this.ctx.storage.kv.put('levelNodes', levelNodes)

    return this.#buildSeedResponse()
  }

  #createTables() {
    // Check FK default BEFORE enabling — captures what DO SQLite does out of the box
    const fkRow = this.ctx.storage.sql.exec('PRAGMA foreign_keys').one()
    this.#fkDefault = (fkRow as Record<string, unknown>)?.foreign_keys as number ?? -1

    // Enable FK enforcement (must be set outside a transaction in standard SQLite;
    // in DO SQLite each exec() is its own implicit transaction boundary)
    this.ctx.storage.sql.exec('PRAGMA foreign_keys = ON')

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Nodes (
        nodeId INTEGER PRIMARY KEY,
        slug TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT 0
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Edges (
        parentNodeId INTEGER NOT NULL,
        childNodeId INTEGER NOT NULL,
        PRIMARY KEY (parentNodeId, childNodeId),
        FOREIGN KEY (parentNodeId) REFERENCES Nodes(nodeId),
        FOREIGN KEY (childNodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID
    `)
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_Edges_child ON Edges(childNodeId)')
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Permissions (
        nodeId INTEGER NOT NULL,
        sub TEXT NOT NULL,
        permission TEXT NOT NULL CHECK(permission IN ('admin', 'write', 'read')),
        PRIMARY KEY (nodeId, sub),
        FOREIGN KEY (nodeId) REFERENCES Nodes(nodeId)
      ) WITHOUT ROWID
    `)
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_Permissions_sub ON Permissions(sub)')
  }

  /**
   * Build the seed response from current database state.
   * Works whether we just seeded or are re-hydrating from persistent storage.
   */
  #buildSeedResponse() {
    const nodeCount = (this.ctx.storage.sql.exec('SELECT COUNT(*) as c FROM Nodes').one()!.c as number)
    const edgeCount = (this.ctx.storage.sql.exec('SELECT COUNT(*) as c FROM Edges').one()!.c as number)

    // Retrieve level structure (stored in KV during seeding)
    const levelNodes: number[][] = this.ctx.storage.kv.get('levelNodes') ?? []

    // Count DAG edges (nodes with >1 parent)
    const dagEdgeCount = (this.ctx.storage.sql.exec(
      'SELECT COUNT(*) as c FROM (SELECT childNodeId FROM Edges GROUP BY childNodeId HAVING COUNT(*) > 1)',
    ).one()!.c as number)

    // ── FK pragma verification ──
    // Check current value (should be ON after #createTables set it)
    const fkCurrentRow = this.ctx.storage.sql.exec('PRAGMA foreign_keys').one()
    const fkCurrentValue = (fkCurrentRow as Record<string, unknown>)?.foreign_keys as number ?? -1

    // Test actual enforcement: try to insert an edge referencing non-existent nodes
    // inside transactionSync so it always rolls back cleanly
    let fkEnforcementWorks = false
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          'INSERT INTO Edges (parentNodeId, childNodeId) VALUES (99999, 99998)',
        )
        // If we reach here, FK wasn't enforced — roll back the bad row
        throw new Error('__rollback__')
      })
    } catch (e) {
      // FK enforcement threw before our __rollback__ → constraint worked
      fkEnforcementWorks = (e as Error).message !== '__rollback__'
    }

    // Build test targets: specific operations the client will run
    const testTargets: Record<string, { op: string; params: Record<string, unknown>; note: string }> = {}

    // Find a deep leaf that's a descendant of the write-dept grant (level-2 node 0)
    const writeDeptNode = levelNodes[2]?.[0]
    const deepLeaf = levelNodes[7]?.[0] ?? levelNodes[6]?.[0]

    // resolvePermission scenarios
    testTargets['resolve_deep_write'] = {
      op: 'resolvePermission',
      params: { sub: 'write-dept', nodeId: deepLeaf },
      note: `Depth 7 leaf, grant at depth 2 → climb ~5 levels`,
    }
    testTargets['resolve_no_access'] = {
      op: 'resolvePermission',
      params: { sub: 'no-access', nodeId: deepLeaf },
      note: 'Depth 7 leaf, no grant anywhere → climb all 7 levels, return null',
    }
    testTargets['resolve_direct'] = {
      op: 'resolvePermission',
      params: { sub: 'read-team', nodeId: levelNodes[4]?.[0] },
      note: 'Direct grant on this node → 0 hops',
    }
    testTargets['resolve_root_admin'] = {
      op: 'resolvePermission',
      params: { sub: 'admin-root', nodeId: deepLeaf },
      note: 'Grant on root → climb all 7 levels to find admin',
    }

    // Diamond DAG test — grant reachable only via alternate parent.
    // levelNodes[4][5] has primary parent levelNodes[3][2] (no grant)
    // and DAG parent levelNodes[3][0] (has diamond-write grant).
    const diamondNode = levelNodes[4]?.[5]
    if (diamondNode != null) {
      testTargets['resolve_diamond'] = {
        op: 'resolvePermission',
        params: { sub: 'diamond-write', nodeId: diamondNode },
        note: 'Diamond node at depth 4, grant at depth 3 via DAG edge (not primary parent)',
      }
    }

    // findAncestors
    testTargets['ancestors_deep'] = {
      op: 'findAncestors',
      params: { nodeId: deepLeaf },
      note: 'Full ancestor set from depth 7 leaf',
    }
    testTargets['ancestors_mid'] = {
      op: 'findAncestors',
      params: { nodeId: levelNodes[4]?.[0] },
      note: 'Ancestors from depth 4 node',
    }

    // findDescendants
    testTargets['descendants_root'] = {
      op: 'findDescendants',
      params: { nodeId: 0 },
      note: `All ~${nodeCount - 1} descendants of root`,
    }
    testTargets['descendants_mid'] = {
      op: 'findDescendants',
      params: { nodeId: writeDeptNode },
      note: 'Descendants of a depth-2 node',
    }

    // detectCycle
    testTargets['cycle_would_cycle'] = {
      op: 'detectCycle',
      params: { parentId: deepLeaf, childId: 0 },
      note: 'leaf→root would create cycle → walks all ancestors',
    }
    testTargets['cycle_safe'] = {
      op: 'detectCycle',
      params: { parentId: 0, childId: deepLeaf },
      note: 'root→leaf is safe → walks root ancestors (just root, no parents)',
    }

    // noop
    testTargets['noop'] = {
      op: 'noop',
      params: {},
      note: 'WebSocket round-trip, no SQL',
    }

    return {
      stats: { nodeCount, edgeCount, dagEdgeCount },
      foreignKeys: {
        defaultValue: this.#fkDefault,
        currentValue: fkCurrentValue,
        enforcementWorks: fkEnforcementWorks,
      },
      testTargets,
      levelNodes,
    }
  }

  // ─── Operations ────────────────────────────────────────────────────

  #runOperation(op: string, params: Record<string, unknown>): unknown {
    switch (op) {
      case 'noop':
        return null
      case 'resolvePermission':
        return this.#resolvePermission(params.sub as string, params.nodeId as number)
      case 'findAncestors':
        return this.#findAncestors(params.nodeId as number)
      case 'findDescendants':
        return this.#findDescendants(params.nodeId as number)
      case 'detectCycle':
        return this.#detectCycle(params.parentId as number, params.childId as number)
      case 'buildCache':
        return this.#buildCache()
      default:
        throw new Error(`Unknown operation: ${op}`)
    }
  }

  /**
   * N+1 iterative permission resolution.
   *
   * BFS up from target node through all ancestor paths.
   * Checks Permissions at each node. Early-exits on 'admin' (can't get higher).
   * Returns the highest permission found on any path, or null if none.
   */
  #resolvePermission(sub: string, nodeId: number): string | null {
    const visited = new Set<number>()
    const queue: number[] = [nodeId]
    let highest: string | null = null

    while (queue.length > 0) {
      const current = queue.shift()!
      if (visited.has(current)) continue
      visited.add(current)

      // Check for direct permission grant at this node
      const grant = this.ctx.storage.sql.exec(
        'SELECT permission FROM Permissions WHERE nodeId = ? AND sub = ?',
        current, sub,
      ).toArray()

      if (grant.length > 0) {
        const perm = grant[0].permission as string
        if (perm === 'admin') return 'admin' // Early exit — can't get higher
        if (highest === null || TIER_RANK[perm] > TIER_RANK[highest]) {
          highest = perm
        }
      }

      // Get parents — N+1 query per node visited
      const parents = this.ctx.storage.sql.exec(
        'SELECT parentNodeId FROM Edges WHERE childNodeId = ?',
        current,
      ).toArray()

      for (const row of parents) {
        queue.push(row.parentNodeId as number)
      }
    }

    return highest
  }

  /**
   * Find all ancestors of a node via BFS up through Edges.
   */
  #findAncestors(nodeId: number): number[] {
    const ancestors = new Set<number>()
    const queue: number[] = [nodeId]

    while (queue.length > 0) {
      const current = queue.shift()!

      const parents = this.ctx.storage.sql.exec(
        'SELECT parentNodeId FROM Edges WHERE childNodeId = ?',
        current,
      ).toArray()

      for (const row of parents) {
        const parentId = row.parentNodeId as number
        if (!ancestors.has(parentId)) {
          ancestors.add(parentId)
          queue.push(parentId)
        }
      }
    }

    return Array.from(ancestors)
  }

  /**
   * Find all descendants of a node via BFS down through Edges.
   */
  #findDescendants(nodeId: number): number[] {
    const descendants = new Set<number>()
    const queue: number[] = [nodeId]

    while (queue.length > 0) {
      const current = queue.shift()!

      const children = this.ctx.storage.sql.exec(
        'SELECT childNodeId FROM Edges WHERE parentNodeId = ?',
        current,
      ).toArray()

      for (const row of children) {
        const childId = row.childNodeId as number
        if (!descendants.has(childId)) {
          descendants.add(childId)
          queue.push(childId)
        }
      }
    }

    return Array.from(descendants)
  }

  /**
   * Build the in-memory cache structure that production would hold:
   * - Nested tree (nodeId, slug, children[]) for sending to subscribers
   * - Per-node permission map for resolvePermission lookups
   *
   * Returns the structure as JSON so the Node.js client can measure
   * V8 heap usage of the deserialized object.
   */
  #buildCache(): {
    tree: unknown
    permissions: Record<number, Record<string, string>>
    nodeCount: number
    permissionCount: number
  } {
    // Load all nodes
    const nodes = this.ctx.storage.sql.exec(
      'SELECT nodeId, slug, deleted FROM Nodes',
    ).toArray() as { nodeId: number; slug: string; deleted: number }[]

    // Load all edges into adjacency list
    const childrenOf = new Map<number, number[]>()
    const edges = this.ctx.storage.sql.exec(
      'SELECT parentNodeId, childNodeId FROM Edges',
    ).toArray() as { parentNodeId: number; childNodeId: number }[]
    for (const { parentNodeId, childNodeId } of edges) {
      let children = childrenOf.get(parentNodeId)
      if (!children) {
        children = []
        childrenOf.set(parentNodeId, children)
      }
      children.push(childNodeId)
    }

    // Load all permissions into per-node maps
    const permissions: Record<number, Record<string, string>> = {}
    let permissionCount = 0
    const perms = this.ctx.storage.sql.exec(
      'SELECT nodeId, sub, permission FROM Permissions',
    ).toArray() as { nodeId: number; sub: string; permission: string }[]
    for (const { nodeId, sub, permission } of perms) {
      if (!permissions[nodeId]) permissions[nodeId] = {}
      permissions[nodeId][sub] = permission
      permissionCount++
    }

    // Build nested tree via DFS from root (node 0)
    const nodeMap = new Map(nodes.map(n => [n.nodeId, n]))

    const buildSubtree = (nodeId: number, visited: Set<number>): unknown => {
      const node = nodeMap.get(nodeId)
      if (!node) return null
      // DAG: a node can appear under multiple parents, but within one
      // tree derivation we mark visited to avoid infinite loops
      visited.add(nodeId)
      const childIds = childrenOf.get(nodeId) ?? []
      const children = childIds
        .filter(id => !visited.has(id))
        .map(id => buildSubtree(id, visited))
        .filter(Boolean)
      return { nodeId: node.nodeId, slug: node.slug, children }
    }

    const tree = buildSubtree(0, new Set())

    return { tree, permissions, nodeCount: nodes.length, permissionCount }
  }

  /**
   * Would adding edge parentId→childId create a cycle?
   *
   * A cycle exists if childId is an ancestor of parentId.
   * BFS up from parentId, early-exit if childId found.
   */
  #detectCycle(parentId: number, childId: number): boolean {
    const visited = new Set<number>()
    const queue: number[] = [parentId]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === childId) return true // Cycle!
      if (visited.has(current)) continue
      visited.add(current)

      const parents = this.ctx.storage.sql.exec(
        'SELECT parentNodeId FROM Edges WHERE childNodeId = ?',
        current,
      ).toArray()

      for (const row of parents) {
        queue.push(row.parentNodeId as number)
      }
    }

    return false
  }
}

// ─── Worker Entry Point ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.DAG_PERF.idFromName('experiment')
      const stub = env.DAG_PERF.get(id)
      return stub.fetch(request)
    }
    return new Response('DAG SQL Perf Experiment — connect via WebSocket', { status: 200 })
  },
} satisfies ExportedHandler<Env>
