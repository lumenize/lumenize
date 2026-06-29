/**
 * Baseline test-app for Nebula e2e tests
 *
 * Re-exports all DO classes for wrangler bindings, defines test subclasses
 * (StarTest, NebulaClientTest), and provides the Worker entrypoint.
 */

import { mesh } from '@lumenize/mesh';
import { DurableObject } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

// Re-export DO classes and entrypoint for wrangler bindings
export {
  NebulaClientGateway,
  Universe,
  Galaxy,
  entrypoint as default,
} from '@lumenize/nebula';

// Re-export auth classes (defined in nebula-auth, but wrangler needs them here)
export { NebulaAuth, NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';

// Import classes needed for test subclasses
import {
  Star,
  Universe,
  Galaxy,
  NebulaClient,
  requireAdmin,
  ROOT_NODE_ID,
  compileOntologyVersion,
} from '@lumenize/nebula';
import type { PermissionTier, WireOperationDescriptor as OperationDescriptor, TransactionResult, Snapshot, OntologyVersionConfig, OntologyVersionRow, SubscriberRow } from '@lumenize/nebula';

// ============================================
// Test subclass: StarTest — adds callClient for mesh→client testing
// ============================================

export class StarTest extends Star {
  @mesh()
  whoAmI(): string {
    return `You are ${this.lmz.callContext.originAuth!.sub}`;
  }

  /**
   * Test-only (T-migration): seed the legacy TOFU key to an arbitrary (stale)
   * value so a test can prove the structural gate ignores it. The new
   * onBeforeCall never reads this key — it's inert dead data left in place.
   */
  @mesh(requireAdmin)
  seedScopeKeyForTest(value: string): void {
    this.ctx.storage.kv.put('__nebula_universeGalaxyStarId', value);
  }

  /**
   * Test-only (T-local-skip): schedule a self-continuation via the mesh alarm
   * service. It is delivered through the *local* chain executor (not
   * executeEnvelope), so it must NOT invoke onBeforeCall.
   */
  @mesh()
  scheduleSelfPing(): void {
    this.svc.alarms.schedule(1, (this.ctn() as any).selfPingHandler());
  }

  /** Test-only: the alarm-delivered self-continuation. No @mesh — runs locally. */
  selfPingHandler(): void {
    debug('nebula.test.Star.selfPing').debug('fired', { instanceName: this.lmz.instanceName });
  }

  @mesh(requireAdmin)
  callClient(targetGatewayInstanceName: string, clientMethod: string, ...args: any[]): void {
    const ctn = this.ctn() as any;
    this.lmz.call(
      'NEBULA_CLIENT_GATEWAY',
      targetGatewayInstanceName,
      ctn[clientMethod](...args),
    );
  }

  /** Test-only stand-in for `DevStudio.chat` (resilient-turn-delivery.md): receive a
   *  fired turn (the client-generated `turnId` + the client's *explicit* instanceName +
   *  the message) and echo the result straight back to that client via `onChatResult`
   *  (the direct-delivery pattern). Proves `NebulaClient.chat` fires `turnId`+`clientId`
   *  correctly and the client correlates the result by `turnId`. */
  @mesh(requireAdmin)
  runFakeTurn(turnId: string, clientId: string, message: string): void {
    const ctn = this.ctn() as any;
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      ctn.onChatResult(turnId, `echo: ${message}`, `thought: ${message}`));
  }

  /** Test-only stand-in for `DevStudio.warmPreview`'s signal (preview-ready-autorefresh.md):
   *  echo `handlePreviewReady` (scope = this Star's instanceName) back to the client, proving
   *  `warmPreview` fires `clientId` correctly and the client's `handlePreviewReady` invokes
   *  the `onPreviewReady` hook. */
  @mesh(requireAdmin)
  runFakePreviewWarm(clientId: string): void {
    const ctn = this.ctn() as any;
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId, ctn.handlePreviewReady(this.lmz.instanceName));
  }

  /**
   * Test-only: dump the ontology-related KV keys so tests can verify the
   * single-row invariant (Phase 4 lifecycle checks). Returns the ordered
   * `_index` plus the list of `ontology:<version>` rows actually present.
   */
  @mesh(requireAdmin)
  inspectOntologyKv(): { index: string[]; rowVersions: string[] } {
    const index = this.ctx.storage.kv.get<string[]>('ontology:_index') ?? [];
    const rowVersions: string[] = [];
    for (const [key] of this.ctx.storage.kv.list({ prefix: 'ontology:' })) {
      if (key === 'ontology:_index') continue;
      rowVersions.push(key.slice('ontology:'.length));
    }
    rowVersions.sort();
    return { index, rowVersions };
  }

  /**
   * Test-only (smoke/browser harness): compile + install an ontology version
   * directly on this Star — the post-Phase-4 dev apply path (Decision 9: the
   * Galaxy lazy-pull was removed, so the validator must be PUSHED via
   * `setOntology`, never fetched on a cache miss). The browser smoke test's
   * `HarnessNebulaClient` runs in Node and imports from `@lumenize/nebula/client`,
   * so it can't call the Worker-only `compileOntologyVersion` itself (the main
   * entry pulls in `cloudflare:workers`, unimportable in Node). This server-side
   * method compiles the row and hands it to `setOntology`, mirroring
   * `NebulaClientTest.callStarApplyOntology` (which compiles client-side from a
   * pool-workers test). Same admin gate as the real `setOntology`.
   */
  @mesh(requireAdmin)
  applyOntologyForTest(versionConfig: OntologyVersionConfig): void {
    this.setOntology(compileOntologyVersion(versionConfig));
  }

  /**
   * Test-only: dump the Subscribers table so tests can verify idempotency
   * and row content. PK-ordered. Admin-gated to avoid client tests leaking
   * the registry shape unintentionally.
   */
  @mesh(requireAdmin)
  inspectSubscribers(): SubscriberRow[] {
    const rows = this.ctx.storage.sql.exec(
      `SELECT resourceId, clientId, sub, subscriberBinding, subscribedAt
       FROM Subscribers ORDER BY resourceId, clientId`,
    ).toArray();
    return rows as unknown as SubscriberRow[];
  }

  /** Test-only: dump the TreeSubscribers table (the dedicated org-tree channel). */
  @mesh(requireAdmin)
  inspectTreeSubscribers(): Array<{ clientId: string; subscriberBinding: string; subscribedAt: string }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding, subscribedAt FROM TreeSubscribers ORDER BY clientId`,
    ).toArray();
    return rows as unknown as Array<{ clientId: string; subscriberBinding: string; subscribedAt: string }>;
  }

  /** Test-only (Phase 5): dump the ReloadSubscribers table (the dev-preview reload
   *  channel) — used to assert connect-gated auto-subscribe + preservation across
   *  resetDevData (Decision 12 / Flow 1d). */
  @mesh(requireAdmin)
  inspectReloadSubscribers(): Array<{ clientId: string; subscriberBinding: string }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding FROM ReloadSubscribers ORDER BY clientId`,
    ).toArray();
    return rows as unknown as Array<{ clientId: string; subscriberBinding: string }>;
  }

  /**
   * Test-only: drop and recreate the Subscribers table. Used by 5.3.4a
   * reconnect tests to verify that the client's resubscribe walk actually
   * re-inserts rows. Without this hook, the absence of Phase 5.3.5
   * (disconnect cleanup) means subscriber rows persist across WS close, so
   * a missing resubscribe wouldn't be visible. Admin-gated.
   */
  @mesh(requireAdmin)
  clearSubscribersForTest(): void {
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS Subscribers;`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Subscribers (
        resourceId TEXT NOT NULL,
        clientId TEXT NOT NULL,
        sub TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL,
        subscribedAt TEXT NOT NULL,
        PRIMARY KEY (resourceId, clientId)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Test-only: bench WS-leg baseline. Bounces a one-byte payload back to the
   * client via the same mesh-callback mechanism as transaction(); the bench
   * subtracts this round-trip from transaction latency to isolate in-Worker
   * cost from network round-trip.
   */
  @mesh()
  ping(): void {
    const clientId = this.lmz.callContext.callChain[0]?.instanceName;
    if (!clientId) {
      throw new Error('ping requires a client origin with instanceName in callChain[0]');
    }
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId,
      (this.ctn() as any).handlePingResult(1));
  }

  /**
   * Test-only: spike handler for the Phase-0 ws.send flush experiment in
   * `tasks/gateway-hop-benchmark.md`. Forces a known-duration await on the
   * Star side; the Gateway's invocation is paused at
   * `await stub.__executeOperation(envelope)` for at least `delayMs`. The
   * spike test pairs this with a `BENCH_MARKER` frame emitted from the
   * Gateway's `onBeforeCallToMesh` hook (before that await) to measure
   * whether the marker reaches the client mid-invocation (~delayMs ahead
   * of the response) or coincident with it.
   *
   * Returns the delay value directly (rather than via mesh callback) so the
   * response arrives via the normal CALL_RESPONSE path. Wall-clock billing
   * is acceptable in this test-only handler.
   */
  @mesh()
  async delay(delayMs: number): Promise<number> {
    await new Promise((r) => setTimeout(r, delayMs));
    return delayMs;
  }

  /**
   * Test-only: returns the Cloudflare colo this Star DO is running in,
   * via the cdn-cgi/trace endpoint. Used by the cross-region bench
   * (`tasks/gateway-hop-benchmark.md` Phase 6) to verify same-DC vs
   * cross-region placement empirically.
   *
   * Each first call costs one outbound HTTP fetch (~5–50 ms wall-clock);
   * subsequent calls return a cached value.
   */
  @mesh()
  async getColo(): Promise<string> {
    if (this.#cachedColo === undefined) {
      const res = await fetch('https://workers.cloudflare.com/cdn-cgi/trace');
      const text = await res.text();
      const match = text.match(/^colo=(.+)$/m);
      this.#cachedColo = match?.[1].trim() ?? 'unknown';
    }
    return this.#cachedColo;
  }

  #cachedColo?: string;

  // --- Dev-data lifecycle inspection (Phase 4: moved off the deleted DevStarTest).
  //     resetDevData lives on base Star now, hard-guarded to .dev instances — these
  //     hooks run against a StarTest at a {u}.{g}.dev instance. ---

  /**
   * Test-only (P3 reset effect): post-reset SQL census. `snapshotCount` /
   * `nodeCount` confirm the wipe (Nodes re-seeds ROOT only → 1); `orphanCount`
   * proves no `Snapshots.nodeId → Nodes` FK orphans survive the wipe + re-init.
   */
  @mesh(requireAdmin)
  inspectReset(): { snapshotCount: number; nodeCount: number; orphanCount: number } {
    const one = (sql: string): number =>
      (this.ctx.storage.sql.exec(sql).toArray()[0] as { c: number }).c;
    return {
      snapshotCount: one(`SELECT COUNT(*) AS c FROM Snapshots`),
      nodeCount: one(`SELECT COUNT(*) AS c FROM Nodes`),
      orphanCount: one(
        `SELECT COUNT(*) AS c FROM Snapshots s LEFT JOIN Nodes n ON s.nodeId = n.nodeId WHERE n.nodeId IS NULL`,
      ),
    };
  }

  /**
   * Test-only (P3 criterion 7, honest test): perform the reset and, in the SAME
   * invocation, report whether `founderSub` still holds ROOT `admin`. This call's
   * `onBeforeCall` ran with the latch SET (Star warmed pre-reset) → it did NOT
   * reseed; `resetDevData` is a DIRECT in-class call, so nothing reseeds the founder
   * grant. Reading it here observes the brief grantless window. Returns `false`.
   */
  @mesh(requireAdmin)
  async resetAndProbeRootAdmin(founderSub: string): Promise<boolean> {
    await this.resetDevData();
    return this.dagTree().getEffectivePermission(ROOT_NODE_ID, founderSub) === 'admin';
  }

  /** Test-only (P3 criterion 7): does `founderSub` hold ROOT `admin`? Called as the
   *  "next admin call" — its own `onBeforeCall` reseeds (latch wiped), so a founder
   *  caller observes `true`, documenting reseed-on-next-touch. */
  @mesh(requireAdmin)
  inspectRootAdmin(founderSub: string): boolean {
    return this.dagTree().getEffectivePermission(ROOT_NODE_ID, founderSub) === 'admin';
  }
}

// (DevStarTest deleted in Phase 4 — the DevStar→Star collapse. The dev Star is now a
// StarTest at a {u}.{g}.dev instance; its lifecycle inspection hooks moved onto StarTest.)

// ============================================
// Inert DEV_CONTAINER serving stub (Phase 3.5a — entrypoint M2/M3 gate test).
//
// The REAL DevContainer `extends Container` and can't construct under
// vitest-pool-workers ([[container-no-construct-pool-workers]]), so the baseline
// binds this inert stand-in to `DEV_CONTAINER`. It only proves the ENTRYPOINT gate
// routes to the bound DO: it returns a recognizable marker for any request (GET
// shell/asset OR an HMR WS upgrade), so a test can assert the gate passed the
// request through (M3 = GET/HEAD serving target; M2 = HMR WS allowed) vs. blocked it
// (405/404/501). The real fetch() 3-way branch + scope injection is tested as pure
// helpers in container-node/dev-container.test.ts + the e2e run with `wrangler dev`.
// ============================================

export class DevContainerServeStub extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const isWs = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    return new Response(`DEV_CONTAINER_STUB ${isWs ? 'WS' : request.method}`, { status: 200 });
  }
}

// ============================================
// Test subclass: NebulaClientTest — adds @mesh methods + test initiators
// ============================================

// Guard for client-side methods
function requireAdminCaller(instance: NebulaClientTest) {
  const claims = instance.lmz.callContext.originAuth?.claims as unknown as NebulaJwtPayload;
  if (!claims?.access?.admin) {
    throw new Error('Admin caller required');
  }
}

export class NebulaClientTest extends NebulaClient {
  // --- Result storage for test assertions ---
  lastResult: any = undefined;
  lastError: string | undefined = undefined;
  callCompleted = false;
  lastEchoMessage: string | undefined = undefined;
  lastAdminEchoMessage: string | undefined = undefined;

  // --- handleResourceUpdate capture (separate from lastResult so multi-arg
  //     payload remains inspectable in subscribe tests) ---
  lastResourceUpdate: { resourceType: string; resourceId: string; snapshot: Snapshot | null } | undefined = undefined;
  resourceUpdateCount = 0;

  // --- handleOrgTreeUpdate capture (the dedicated org-tree channel) ---
  lastOrgTree: unknown = undefined;
  orgTreeUpdateCount = 0;

  // --- handleReload capture (the dev-preview reload channel). CUMULATIVE — NOT
  //     zeroed by resetResults (it's a channel counter; baseline it before the
  //     action under test, per testing.md). ---
  reloadCount = 0;

  // Handler for call results (no @mesh needed — local chain executor)
  handleResult(value: any): void {
    if (value instanceof Error) {
      this.lastError = value.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = value;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  resetResults(): void {
    this.lastResult = undefined;
    this.lastError = undefined;
    this.callCompleted = false;
    this.lastResourceUpdate = undefined;
    this.resourceUpdateCount = 0;
    this.lastOrgTree = undefined;
    this.orgTreeUpdateCount = 0;
  }

  // --- Mesh-callable methods (DOs call these through the Gateway) ---

  @mesh()
  echo(message: string): string {
    this.lastEchoMessage = message;
    return `Client echoed: ${message}`;
  }

  @mesh(requireAdminCaller)
  adminEcho(message: string): string {
    this.lastAdminEchoMessage = message;
    return `Admin client echoed: ${message}`;
  }

  /** Phase 5: count reload-channel deliveries from `Star.broadcastReload`. Calls
   *  `super.handleReload()` so the real `handleReload → #onReload` path still runs
   *  (in tests `#onReload` is usually unset → a no-op); the counter proves the
   *  signal reached the client (Decision 12 / Flow 1d). */
  @mesh()
  override handleReload(): void {
    this.reloadCount++;
    super.handleReload();
  }

  // --- Test initiators (tests call these to trigger outbound mesh calls) ---
  // Uses this.lmz.call() with this.ctn<TargetType>().method(args) continuation pattern

  // --- Resilient chat-turn delivery (resilient-turn-delivery.md) ---

  /** Register a pending turn for a known `turnId` WITHOUT firing a call — lets a test
   *  hold a pending turn across a forced reconnect, then deliver `onChatResult` to it.
   *  Reuses the production `trackTurn` (protected) so it exercises the real pending map. */
  registerPendingTurnForTest(turnId: string): Promise<{ reply: string; thought: string }> {
    return this.trackTurn(turnId);
  }

  /** Exercise the real `chat()` shape against a stand-in (`StarTest.runFakeTurn`) rather
   *  than DEV_STUDIO (absent from this app): register a pending turn, fire the turn with
   *  this client's *explicit* instanceName, resolve when `onChatResult` echoes back. */
  chatViaStarForTest(starInstanceName: string, message: string): Promise<{ reply: string; thought: string }> {
    const turnId = crypto.randomUUID();
    const clientId = this.lmz.instanceName;
    const pending = this.trackTurn(turnId);
    this.lmz.call('STAR', starInstanceName, this.ctn<StarTest>().runFakeTurn(turnId, clientId, message));
    return pending;
  }

  /** Exercise `warmPreview`'s fire shape against the StarTest stand-in (DEV_STUDIO is absent
   *  here): fire with this client's *explicit* instanceName; the stand-in echoes
   *  `handlePreviewReady` → the `onPreviewReady` hook fires. */
  warmPreviewViaStarForTest(starInstanceName: string): void {
    const clientId = this.lmz.instanceName;
    this.lmz.call('STAR', starInstanceName, this.ctn<StarTest>().runFakePreviewWarm(clientId));
  }

  /** Fire an `onChatResult` delivery at a client via Star (the DO→client direct-delivery
   *  path) — used to deliver to a client AFTER a forced reconnect, proving the result
   *  lands on the *current* socket, not the dead originating one. */
  triggerOnChatResultForTest(
    starInstanceName: string, targetClientId: string, turnId: string, reply: string, thought: string,
  ): void {
    this.lmz.call('STAR', starInstanceName,
      this.ctn<StarTest>().callClient(targetClientId, 'onChatResult', turnId, reply, thought));
  }

  callStarWhoAmI(starInstanceName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().whoAmI();
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callStarGetConfig(starInstanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().getStarConfig();
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callStarSetConfig(starInstanceName: string, key: string, value: unknown): void {
    this.resetResults();
    const remote = this.ctn<Star>().setStarConfig(key, value);
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  /** Phase 3.5c: drive `Star.resetDevData` against the STAR binding (a non-`.dev`
   *  tenant Star) so the runtime `.dev` guard can be exercised — it must throw +
   *  wipe nothing. (`resetDevData` lives on base `Star` now; `DevStar` inherits it.) */
  callStarResetDevData(starInstanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resetDevData();
    this.lmz.call('STAR', starInstanceName, remote, this.ctn().handleResult(remote));
  }

  callStarSeedScopeKey(starName: string, value: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().seedScopeKeyForTest(value);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarScheduleSelfPing(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().scheduleSelfPing();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callUniverseGetConfig(instanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Universe>().getUniverseConfig();
    this.lmz.call('UNIVERSE', instanceName, remote, this.ctn().handleResult(remote));
  }

  callUniverseSetConfig(instanceName: string, key: string, value: unknown): void {
    this.resetResults();
    const remote = this.ctn<Universe>().setUniverseConfig(key, value);
    this.lmz.call('UNIVERSE', instanceName, remote, this.ctn().handleResult(remote));
  }

  callGalaxyGetConfig(instanceName: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().getGalaxyConfig();
    this.lmz.call('GALAXY', instanceName, remote, this.ctn().handleResult(remote));
  }

  callGalaxySetConfig(instanceName: string, key: string, value: unknown): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().setGalaxyConfig(key, value);
    this.lmz.call('GALAXY', instanceName, remote, this.ctn().handleResult(remote));
  }

  // --- DagTree test initiators ---

  callStarDagTreeGetState(starName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getState();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCreateNode(starName: string, parentId: number, slug: string, label: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().createNode(parentId, slug, label);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarAddEdge(starName: string, parentId: number, childId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().addEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRemoveEdge(starName: string, parentId: number, childId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().removeEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarReparentNode(starName: string, childId: number, oldParentId: number, newParentId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().reparentNode(childId, oldParentId, newParentId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarDeleteNode(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().deleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarUndeleteNode(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().undeleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRenameNode(starName: string, nodeId: number, newSlug: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().renameNode(nodeId, newSlug);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRelabelNode(starName: string, nodeId: number, newLabel: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().relabelNode(nodeId, newLabel);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarSetPermission(starName: string, nodeId: number, targetSub: string, level: PermissionTier): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().setPermission(nodeId, targetSub, level);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRevokePermission(starName: string, nodeId: number, targetSub: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().revokePermission(nodeId, targetSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCheckPermission(starName: string, nodeId: number, tier: PermissionTier, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().checkPermission(nodeId, tier, targetSub)
      : this.ctn<Star>().dagTree().checkPermission(nodeId, tier);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetEffectivePermission(starName: string, nodeId: number, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().getEffectivePermission(nodeId, targetSub)
      : this.ctn<Star>().dagTree().getEffectivePermission(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeAncestors(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeAncestors(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeDescendants(starName: string, nodeId: number): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeDescendants(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Resources test initiators (fire-and-forget — Star delivers result via callback) ---

  callStarTransaction(
    starName: string,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    newETag?: string,
  ): void {
    this.resetResults();
    const txnETag = newETag ?? crypto.randomUUID();
    this.lastTxnETag = txnETag;
    this.lmz.call('STAR', starName,
      this.ctn<Star>().transaction(ontologyVersion, txnETag, ops));
  }

  /** Last newETag used by `callStarTransaction` — useful for tests that
   *  need to retry with the same eTag (idempotency probe). */
  lastTxnETag: string | undefined = undefined;

  callStarRead(starName: string, ontologyVersion: string, resourceId: string): void {
    this.resetResults();
    const requestId = crypto.randomUUID();
    this.lmz.call('STAR', starName,
      this.ctn<Star>().read(ontologyVersion, resourceId, requestId));
  }

  callStarSubscribe(starName: string, ontologyVersion: string, resourceType: string, resourceId: string): void {
    this.resetResults();
    this.lmz.call('STAR', starName,
      this.ctn<Star>().subscribe(ontologyVersion, resourceType, resourceId));
  }

  callStarInspectSubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectSubscribers();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarSubscribeTree(starName: string): void {
    this.resetResults();
    this.lmz.call('STAR', starName, this.ctn<Star>().subscribeTree());
  }

  callStarInspectTreeSubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectTreeSubscribers();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /** Phase 5: subscribe to the Star's dev-preview reload channel. Result-handler form
   *  (deterministic) so a test can await registration before triggering a reload. */
  callStarSubscribeReload(starName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().subscribeReload();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarInspectReloadSubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectReloadSubscribers();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarClearSubscribersForTest(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().clearSubscribersForTest();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Resource result handlers (override base class) ---

  @mesh()
  override handleTransactionResult(result: TransactionResult | Error): void {
    // Delegate to base so the in-flight transaction queue settles for any
    // test using `client.resources.transaction()`. The legacy
    // `callStarTransaction` test initiator doesn't enqueue a transaction
    // (it's just an lmz.call), so the base's `#inFlightTxn` is null and the
    // delegation is a no-op for that path. After delegation, capture for
    // assertion: legacy tests read `lastResult` / `lastError` /
    // `callCompleted`.
    super.handleTransactionResult(result);

    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = result;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  @mesh()
  override handleReadResponse(_requestId: string, result: Snapshot | null | Error): void {
    // Delegate to base for Promise correlation on the new
    // client.resources.read() path. The base settles the pending entry in
    // its requestId map. Then capture for assertion on the legacy
    // `callStarRead` test initiator (which doesn't go through the Promise
    // path — it sets `lastResult` / `lastError` and `callCompleted`).
    super.handleReadResponse(_requestId, result);

    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastResult = undefined;
    } else {
      this.lastResult = result;
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  @mesh()
  override handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | null | Error): void {
    // Delegate to base for Promise correlation + state write-through (5.3.3a).
    // The base no-ops state write when no StateManager is bound, so tests that
    // don't call bindToState still work.
    super.handleResourceUpdate(resourceType, resourceId, result);

    this.resourceUpdateCount++;
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastResourceUpdate = undefined;
    } else {
      this.lastResourceUpdate = { resourceType, resourceId, snapshot: result };
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  @mesh()
  override handleOrgTreeUpdate(envelope: { value: unknown }): void {
    // Delegate to base so the factory's listener fires (a no-op headless), then
    // capture the tree state for assertion on the dedicated org-tree channel.
    super.handleOrgTreeUpdate(envelope as { value: never });
    this.orgTreeUpdateCount++;
    this.lastOrgTree = envelope.value;
  }

  // --- Galaxy test initiators ---

  callGalaxyAppendOntologyVersion(galaxyName: string, versionConfig: OntologyVersionConfig): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().appendOntologyVersion(versionConfig);
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  /** Apply an ontology directly to a Star (Phase 4: the Galaxy lazy-pull was retired,
   *  so tests install the compiled validator via `Star.setOntology` — DevStudio's dev
   *  apply path). Compiles client-side via the pure `compileOntologyVersion`. */
  callStarApplyOntology(starName: string, versionConfig: OntologyVersionConfig): void {
    this.resetResults();
    const row: OntologyVersionRow = compileOntologyVersion(versionConfig);
    const remote = this.ctn<Star>().setOntology(row);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callGalaxyGetLatestOntologyVersion(galaxyName: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().getLatestOntologyVersion();
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  callGalaxyListOntologyVersions(galaxyName: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().listOntologyVersions();
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  callStarInspectOntologyKv(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectOntologyKv();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Dev-data lifecycle initiators (Phase 4: the .dev Star is the STAR binding at a
  //     {u}.{g}.dev instance — resetDevData + these inspect hooks live on base
  //     Star/StarTest, hard-guarded to .dev at runtime). ---

  callStarInspectReset(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectReset();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarResetAndProbeRootAdmin(starName: string, founderSub: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().resetAndProbeRootAdmin(founderSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarInspectRootAdmin(starName: string, founderSub: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectRootAdmin(founderSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }
}
