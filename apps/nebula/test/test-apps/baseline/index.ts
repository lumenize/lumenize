/**
 * Baseline test-app for Nebula e2e tests
 *
 * Re-exports all DO classes for wrangler bindings, defines test subclasses
 * (StarTest, NebulaClientTest), and provides the Worker entrypoint.
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

// Re-export DO classes and entrypoint for wrangler bindings
export {
  NebulaClientGateway,
  Universe,
  entrypoint as default,
} from '@lumenize/nebula';

// Re-export auth classes (defined in nebula-auth, but wrangler needs them here)
export { NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';
export { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import { Profile } from '@lumenize/nebula-auth/profile';

/** A profileId that forces `Profile`'s scoped-admin registry read to throw — the fail-closed probe. */
export const FAIL_CLOSED_PROFILE_ID = '__fail_closed_probe__';

/**
 * Test subclass of `Profile` (bound at `PROFILE`) — overrides the `lookupProfileScopes` seam to THROW
 * for {@link FAIL_CLOSED_PROFILE_ID}, so a scoped-admin write against that instance exercises the
 * fail-closed path (`#requireOwnerOrAdmin` must catch the throw and DENY). Otherwise transparent.
 */
export class ProfileTest extends Profile {
  protected override async lookupProfileScopes(profileId: string): Promise<string[]> {
    if (profileId === FAIL_CLOSED_PROFILE_ID) throw new Error('injected registry failure (test)');
    return super.lookupProfileScopes(profileId);
  }
}

// Import classes needed for test subclasses
import {
  Star,
  Universe,
  Galaxy,
  NebulaClient,
  requireDominionHere,
  ROOT_NODE_ID,
  compileOntologyVersion,
} from '@lumenize/nebula';
import type { PermissionTier, WireOperationDescriptor as OperationDescriptor, TransactionResult, Snapshot, OntologyVersionConfig, OntologyVersionRow, SubscriberRow, QueryDescriptor, QueryUpdatePayload, QuerySubscriberRow, SubscriberEntry, SubscriberRosterPayload } from '@lumenize/nebula';
import type { ChatMessage, ModelParams, BuildOutcome } from '../../../src/codegen-loop';

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
  @mesh(requireDominionHere)
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

  @mesh(requireDominionHere)
  callClient(targetGatewayInstanceName: string, clientMethod: string, ...args: any[]): void {
    const ctn = this.ctn() as any;
    this.lmz.call(
      'NEBULA_CLIENT_GATEWAY',
      targetGatewayInstanceName,
      ctn[clientMethod](...args),
    );
  }

  /** Test-only stand-in for `Galaxy.warmPreview`'s signal (preview-ready-autorefresh.md):
   *  echo `handlePreviewReady` (scope = this Star's instanceName) back to the client, proving
   *  `warmPreview` fires `clientId` correctly and the client's `handlePreviewReady` invokes
   *  the `onPreviewReady` hook. */
  @mesh(requireDominionHere)
  runFakePreviewWarm(clientId: string): void {
    const ctn = this.ctn() as any;
    this.lmz.call('NEBULA_CLIENT_GATEWAY', clientId, ctn.handlePreviewReady(this.lmz.instanceName));
  }

  /**
   * Test-only: dump the ontology-related KV keys so tests can verify the
   * single-row invariant (Phase 4 lifecycle checks). Returns the ordered
   * `_index` plus the list of `ontology:<version>` rows actually present.
   */
  @mesh(requireDominionHere)
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
  @mesh(requireDominionHere)
  applyOntologyForTest(versionConfig: OntologyVersionConfig): void {
    this.setOntology(compileOntologyVersion(versionConfig));
  }

  /**
   * Test-only: dump the Subscribers table so tests can verify idempotency
   * and row content. PK-ordered. Admin-gated to avoid client tests leaking
   * the registry shape unintentionally.
   */
  @mesh(requireDominionHere)
  inspectSubscribers(): SubscriberRow[] {
    const rows = this.ctx.storage.sql.exec<SubscriberRow>(
      `SELECT resourceId, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM Subscribers ORDER BY resourceId, clientId`,
    ).toArray();
    return rows;
  }

  /** Test-only (Child 2): dump the QuerySubscribers table — idempotency / M3
   *  single-row checks + content. PK-ordered. Admin-gated. */
  @mesh(requireDominionHere)
  inspectQuerySubscribers(): QuerySubscriberRow[] {
    const rows = this.ctx.storage.sql.exec<QuerySubscriberRow>(
      `SELECT queryHash, query, clientId, sub, dominionOverHostAtSubscribe, subscriberBinding, subscribedAt
       FROM QuerySubscribers ORDER BY queryHash, clientId`,
    ).toArray();
    return rows;
  }

  /** Test-only: dump the TreeSubscribers table (the dedicated org-tree channel). */
  @mesh(requireDominionHere)
  inspectTreeSubscribers(): Array<{ clientId: string; subscriberBinding: string; subscribedAt: string }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding, subscribedAt FROM TreeSubscribers ORDER BY clientId`,
    ).toArray();
    return rows as unknown as Array<{ clientId: string; subscriberBinding: string; subscribedAt: string }>;
  }

  /** Test-only (Phase 5): dump the ReloadSubscribers table (the dev-preview reload
   *  channel) — used to assert connect-gated auto-subscribe + preservation across
   *  resetDevData (Decision 12 / Flow 1d). */
  @mesh(requireDominionHere)
  inspectReloadSubscribers(): Array<{ clientId: string; subscriberBinding: string }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT clientId, subscriberBinding FROM ReloadSubscribers ORDER BY clientId`,
    ).toArray();
    return rows as unknown as Array<{ clientId: string; subscriberBinding: string }>;
  }

  /** Test-only: fan the Star's PARKED reload channel (its production trigger — the
   *  publish-refresh signal — is not built; the ontology-install trigger was retired at
   *  the collapse). Lets the preservation test still prove DELIVERY. */
  @mesh(requireDominionHere)
  broadcastReloadForTest(): void {
    this.broadcastReload();
  }

  /**
   * Test-only: drop and recreate the Subscribers table. Used by 5.3.4a
   * reconnect tests to verify that the client's resubscribe walk actually
   * re-inserts rows. Without this hook, the absence of Phase 5.3.5
   * (disconnect cleanup) means subscriber rows persist across WS close, so
   * a missing resubscribe wouldn't be visible. Admin-gated.
   */
  @mesh(requireDominionHere)
  clearSubscribersForTest(): void {
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS Subscribers;`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS Subscribers (
        resourceId TEXT NOT NULL,
        clientId TEXT NOT NULL,
        sub TEXT NOT NULL,
        dominionOverHostAtSubscribe INTEGER NOT NULL DEFAULT 0,
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
   * Test-only (cold-start anatomy, 2026-07-22): the PURE mesh round-trip — returns
   * its argument straight back, touching neither the ontology nor `#dataPlane`. The
   * 4-arg fire-back delivers the value to the client's `handleResult`. A COLD echo on
   * a fresh Star therefore isolates fresh-Star cold-wake (placement + onStart schema/
   * ROOT + onBeforeCall scope-check + root-admin seed) from any data-plane operation —
   * the clean counterpart to `transaction`'s cold path.
   */
  @mesh()
  echo(value: unknown): unknown {
    return value;
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
  @mesh(requireDominionHere)
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
   * invocation, report whether `starAdminSub` still holds ROOT `admin`. This call's
   * `onBeforeCall` ran with the latch SET (Star warmed pre-reset) → it did NOT
   * reseed; `resetDevData` is a DIRECT in-class call, so nothing reseeds the root admin
   * grant. Reading it here observes the brief grantless window. Returns `false`.
   */
  @mesh(requireDominionHere)
  async resetAndProbeRootAdmin(starAdminSub: string): Promise<boolean> {
    await this.resetDevData();
    return this.dagTree().getEffectivePermission(ROOT_NODE_ID, starAdminSub) === 'admin';
  }

  /** Test-only (P3 criterion 7): does `starAdminSub` hold ROOT `admin`? Called as the
   *  "next admin call" — its own `onBeforeCall` reseeds (latch wiped), so a root-admin
   *  caller observes `true`, documenting reseed-on-next-touch. */
  @mesh(requireDominionHere)
  inspectRootAdmin(starAdminSub: string): boolean {
    return this.dagTree().getEffectivePermission(ROOT_NODE_ID, starAdminSub) === 'admin';
  }
}

// (DevStarTest deleted in Phase 4 — the DevStar→Star collapse. The dev Star is now a
// StarTest at a {u}.{g}.dev instance; its lifecycle inspection hooks moved onto StarTest.)

// ============================================
// Test subclass: GalaxyTest — the GALAXY binding's class. IS-A Galaxy (ontology
// registry + chat data-plane + codegen seams), plus the protected data-plane seams
// exposed for tests that can't run the wrangler-dev-only `chat` codegen loop.
// ============================================

export class GalaxyTest extends Galaxy {
  // Scripted chat support: a fake model script (per-round responses, consumed by the
  // shared `runModel` router so the codegen loop AND the answer path both ride it) + an
  // always-ok build, so the trigger pipeline is drivable in-lane. A `{ __delayMs }`
  // entry sleeps then falls through — the lever for spanning a generation across
  // commits (the single-flight tests). The REAL container drive is the build-box /live
  // scenario; nothing here reaches ctx.container (absent under pool-workers anyway).
  #chatScript: unknown[] = [];
  #pinnedCodegen = true;
  protected override async runModel(_model: string, _body: Record<string, unknown>): Promise<unknown> {
    for (;;) {
      const next = this.#chatScript.shift();
      if (next === undefined) throw new Error('GalaxyTest chat script exhausted');
      const delay = (next as { __delayMs?: number }).__delayMs;
      if (typeof delay === 'number') {
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return next;
    }
  }
  protected override build(): Promise<BuildOutcome> {
    return Promise.resolve({ ok: true });
  }

  /** Pin the discriminator (no model call, deterministic fork) — the verdict's own
   *  model behavior is out of scope in-lane; what the pin exercises is what the fork
   *  DOES (warm gating + prompt selection). */
  protected override async discriminate(): Promise<{ respond: true; codegen: boolean }> {
    return { respond: true, codegen: this.#pinnedCodegen };
  }

  /** Run ONE real TRIGGERED turn against the scripted model (the whole pipeline:
   *  discriminator (pinned) → loop → commit → build-completion reload trigger).
   *  Drives `runTriggeredTurn` — the same runner the commit hook invokes. */
  @mesh(requireDominionHere)
  async chatScriptedForTest(userMessageId: string, message: string, script: unknown[]): Promise<void> {
    this.#chatScript = script;
    await this.runTriggeredTurn(userMessageId, message);
  }

  /** Seed the fake-model script for turns the REAL commit hook will trigger (a
   *  `postUserMessage` commit fires `#onChatCommitted` in the same isolate, so the
   *  seeded script is what its generation consumes). Ephemeral by design. */
  @mesh(requireDominionHere)
  seedChatScriptForTest(script: unknown[], opts: { codegen?: boolean } = {}): void {
    this.#chatScript = [...script];
    this.#pinnedCodegen = opts.codegen ?? true;
  }

  /** Test-only: drop + recreate the QuerySubscribers table — the reconnect test's
   *  server-side amnesia, so the client's re-subscribe walk is what restores fanout
   *  (without it the walk's absence would be invisible: rows would just still exist). */
  @mesh(requireDominionHere)
  clearQuerySubscribersForTest(): void {
    this.ctx.storage.sql.exec('DELETE FROM QuerySubscribers');
  }

  /** The permission-filtered query targets for the per-operand accessor test (M4).
   *  Returns the clientIds among the query's subscribers that may read `nodeId`
   *  (targetsForQuery via the protected `queryTargets` seam). Admin-gated. */
  @mesh(requireDominionHere)
  inspectQueryTargets(query: QueryDescriptor, nodeId: string): string[] {
    return this.queryTargets(query, nodeId).map((t) => t.instanceName);
  }

  /** Push ONE transient progress chunk (the loop's `onProgress` seam is
   *  wrangler-dev-only, so tests drive `streamProgress` directly with synthetic
   *  progress). Kept separate from the commit so a test can observe a chunk arriving
   *  BEFORE the durable Message (M3 transient-surface assertion). */
  @mesh(requireDominionHere)
  streamChunkForTest(
    sessionId: string, messageId: string, chunk: string, nodeId: string, replyTo = 'test-user-message',
  ): void {
    this.streamProgress(sessionId, messageId, chunk, nodeId, replyTo);
  }

  /** Commit the durable agent Message (the completion step) — Nebula-attributed via the
   *  actor stamp, `replyTo`-linked (required on an agent message). */
  @mesh(requireDominionHere)
  async commitAgentForTest(chatId: string, messageId: string, content: string, nodeId: string, replyTo: string, codegen?: Record<string, unknown>): Promise<void> {
    await this.commitAgentMessage(chatId, messageId, content, nodeId, replyTo, { thought: 'synthetic thought', codegen });
  }
}

// ============================================
// Test subclass: NebulaClientTest — adds @mesh methods + test initiators
// ============================================

// Guard for client-side methods
function requireAdminCaller(instance: NebulaClientTest) {
  const claims = instance.lmz.callContext.originAuth?.claims as unknown as NebulaJwtPayload;
  if (!claims?.access?.scopeAdmin) {
    throw new Error('Admin caller required');
  }
}

export class NebulaClientTest extends NebulaClient {
  // --- Result storage for test assertions ---
  lastResult: any = undefined;
  lastError: string | undefined = undefined;
  /** The delivered Error object itself (structured-clone reconstructs it as a plain
   *  Error with `name` + custom props preserved — `instanceof` does not survive).
   *  Lets a test assert the *typed* error that crossed the capability's delivery,
   *  e.g. distinct `NodeNotFoundError` vs `PermissionDeniedError` (review m6). */
  lastErrorObject: Error | undefined = undefined;
  callCompleted = false;
  lastEchoMessage: string | undefined = undefined;
  lastAdminEchoMessage: string | undefined = undefined;

  // --- handleResourceUpdate capture (separate from lastResult so multi-arg
  //     payload remains inspectable in subscribe tests) ---
  lastResourceUpdate: { resourceType: string; resourceId: string; snapshot: Snapshot | null } | undefined = undefined;
  resourceUpdateCount = 0;

  // --- handleProfileUpdate capture (the DEDICATED global-Profile channel — tasks/nebula-subscriber-lists.md).
  //     Separate from resourceUpdate so a dev-user `Profile` resource and a platform profile never share a
  //     counter. CUMULATIVE count. ---
  lastProfileUpdate: { profileId: string; snapshot: Snapshot | null } | undefined = undefined;
  profileUpdateCount = 0;

  // --- handleOrgTreeUpdate capture (the dedicated org-tree channel) ---
  lastOrgTree: unknown = undefined;
  orgTreeUpdateCount = 0;

  // --- handleReload capture (the dev-preview reload channel). CUMULATIVE — NOT
  //     zeroed by resetResults (it's a channel counter; baseline it before the
  //     action under test, per testing.md). ---
  reloadCount = 0;
  /** `handlePreviewReady` capture — the BUILD reply's landing point (the Galaxy answers
   *  whoever asked for the build). Cumulative, like reloadCount. */
  previewReadyCount = 0;

  // --- handleQueryUpdate capture (Child 2 query channel). Reset explicitly by the
  //     query initiators (not resetResults). ---
  lastQueryUpdate: { queryHash: string; result: QueryUpdatePayload } | undefined = undefined;
  lastQueryError: Error | undefined = undefined;
  queryUpdateCount = 0;

  // --- handleQuerySubscribersUpdate capture (the STANDALONE subscriber-list roster channel —
  //     tasks/nebula-subscriber-lists.md). CUMULATIVE count. Server-integration tests assert on THIS
  //     override (raw push args); a factory test asserts the store landing. `roster` is undefined on the
  //     fail-closed Error push. ---
  lastQuerySubscribersUpdate: { queryHash: string; roster?: SubscriberEntry[]; error?: Error } | undefined = undefined;
  querySubscribersUpdateCount = 0;

  // --- handleStreamChunk capture (Child 3 transient progress stream). CUMULATIVE —
  //     count of chunks received; read `streamingProgress(id)` for the accumulated text. ---
  lastStreamChunk: { messageId: string; progress: string } | undefined = undefined;
  streamChunkCount = 0;
  /** The attribution the last chunk carried — the id of the USER message whose turn is streaming. */
  lastStreamReplyTo: string | undefined;

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
    this.lastErrorObject = undefined;
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

  /** Count the build reply. `super` keeps the real `handlePreviewReady → #onPreviewReady`
   *  path (unset in most tests → a no-op); the counter proves the signal reached THIS
   *  client, which is the whole point of a reply addressed at the requester. */
  @mesh()
  override handlePreviewReady(scope: string): void {
    this.previewReadyCount++;
    super.handlePreviewReady(scope);
  }

  // --- Test initiators (tests call these to trigger outbound mesh calls) ---
  // Uses this.lmz.call() with this.ctn<TargetType>().method(args) continuation pattern

  /** Exercise `warmPreview`'s fire shape against the StarTest stand-in: fire with this
   *  client's *explicit* instanceName; the stand-in echoes
   *  `handlePreviewReady` → the `onPreviewReady` hook fires. */
  warmPreviewViaStarForTest(starInstanceName: string): void {
    const clientId = this.lmz.instanceName;
    this.lmz.call('STAR', starInstanceName, this.ctn<StarTest>().runFakePreviewWarm(clientId));
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

  callStarCreateNode(starName: string, parentId: string, slug: string, label: string): void {
    // The client mints the id (client-supplied nodeId, a v4 UUID) and passes it in
    // the continuation — the faithful client-supplied-id flow; the server echoes it
    // back into `lastResult`. Use `callStarCreateNodeWithId` when a test must control
    // the id (idempotency/replay/collision).
    this.callStarCreateNodeWithId(starName, crypto.randomUUID(), parentId, slug, label);
  }

  callStarCreateNodeWithId(starName: string, nodeId: string, parentId: string, slug: string, label: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().createNode(nodeId, parentId, slug, label);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /**
   * Test-only: fire `callAsync` at Star's `delay(delayMs)` with a short `timeoutMs`, so the RESULT
   * (arriving at ~delayMs) loses the race to `callAsync`'s timeout. Proves the `orgTree.*` mutation
   * path (which delegates to `callAsync`) rejects on a lost/slow RESULT instead of hanging (D4) — on
   * the timer-free client path, with NO engine-level timer to confound the rejection (m1). Returns the
   * `callAsync` Promise directly so a test can await/assert its rejection.
   */
  callAsyncStarDelay(starName: string, delayMs: number, timeoutMs: number): Promise<number> {
    return this.lmz.callAsync('STAR', starName, (this.ctn<Star>() as any).delay(delayMs), { timeoutMs });
  }

  callStarAddEdge(starName: string, parentId: string, childId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().addEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRemoveEdge(starName: string, parentId: string, childId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().removeEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarReparentNode(starName: string, childId: string, oldParentId: string, newParentId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().reparentNode(childId, oldParentId, newParentId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarDeleteNode(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().deleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarUndeleteNode(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().undeleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRenameNode(starName: string, nodeId: string, newSlug: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().renameNode(nodeId, newSlug);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRelabelNode(starName: string, nodeId: string, newLabel: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().relabelNode(nodeId, newLabel);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarSetPermission(starName: string, nodeId: string, targetSub: string, level: PermissionTier): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().setPermission(nodeId, targetSub, level);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRevokePermission(starName: string, nodeId: string, targetSub: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().revokePermission(nodeId, targetSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCheckPermission(starName: string, nodeId: string, tier: PermissionTier, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().checkPermission(nodeId, tier, targetSub)
      : this.ctn<Star>().dagTree().checkPermission(nodeId, tier);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /** Child 2 Phase 1: drive the non-throwing batch eval (explicit sub + stored
   *  hasDominionOverHost). Returns `{ allowed: Set, denied: Set }` — structured-clone
   *  preserves the Sets across the mesh. */
  callStarEvaluatePermissions(
    starName: string, nodeIds: string[], tier: PermissionTier, sub: string, hasDominionOverHost: boolean,
  ): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().evaluatePermissions(nodeIds, tier, sub, hasDominionOverHost);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetEffectivePermission(starName: string, nodeId: string, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().dagTree().getEffectivePermission(nodeId, targetSub)
      : this.ctn<Star>().dagTree().getEffectivePermission(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeAncestors(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeAncestors(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeDescendants(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().dagTree().getNodeDescendants(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Resources test initiators (fire-and-forget — Star delivers result via callback) ---

  async callStarTransaction(
    starName: string,
    ontologyVersion: string,
    ops: Record<string, OperationDescriptor>,
    newETag?: string,
  ): Promise<void> {
    this.resetResults();
    const txnETag = newETag ?? crypto.randomUUID();
    this.lastTxnETag = txnETag;
    // Transactions now return via `callAsync` (D5 pattern (a)): a `TransactionResult` on success, an
    // `OntologyStaleError` as a VALUE on stale, or a rejection on infra error. Capture into the legacy
    // `lastResult` / `lastError` / `callCompleted` fields the `callStarTransaction` tests assert on.
    try {
      const result = await this.lmz.callAsync('STAR', starName,
        this.ctn<Star>().transaction(ontologyVersion, txnETag, ops));
      if (result instanceof Error) {
        this.lastErrorObject = result;
        this.lastError = result.message;
        this.lastResult = undefined;
      } else {
        this.lastResult = result;
        this.lastError = undefined;
      }
    } catch (err) {
      this.lastErrorObject = err instanceof Error ? err : new Error(String(err));
      this.lastError = this.lastErrorObject.message;
      this.lastResult = undefined;
    }
    this.callCompleted = true;
  }

  /** Last newETag used by `callStarTransaction` — useful for tests that
   *  need to retry with the same eTag (idempotency probe). */
  lastTxnETag: string | undefined = undefined;

  /** Test-only: in-flight `callAsync` count (D7/M2 transient surface — proves the retired submit-gate
   *  lets concurrent independent-resource transactions run; a re-added serial gate would keep this 1). */
  getPendingAsyncCallCount(): number {
    return this.pendingAsyncCallCount();
  }

  async callStarRead(starName: string, ontologyVersion: string, resourceId: string): Promise<void> {
    this.resetResults();
    // Reads now return via `callAsync` (D5 pattern (a)); capture into the legacy `lastResult` /
    // `lastError` / `callCompleted` fields that the `callStarRead` tests assert on (via `waitForResult`).
    try {
      this.lastResult = await this.lmz.callAsync('STAR', starName,
        this.ctn<Star>().read(ontologyVersion, resourceId));
      this.lastError = undefined;
    } catch (err) {
      this.lastErrorObject = err instanceof Error ? err : new Error(String(err));
      this.lastError = this.lastErrorObject.message;
      this.lastResult = undefined;
    }
    this.callCompleted = true;
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

  // --- Query subscription initiators (Child 2; fire-and-forget — host delivers
  //     via handleQueryUpdate) ---

  callStarSubscribeQuery(starName: string, query: QueryDescriptor): void {
    this.lastQueryUpdate = undefined;
    this.lastQueryError = undefined;
    this.queryUpdateCount = 0;
    this.lmz.call('STAR', starName, this.ctn<Star>().subscribeQuery(query));
  }

  callStarUnsubscribeQuery(starName: string, queryHash: string): void {
    this.lmz.call('STAR', starName, this.ctn<Star>().unsubscribeQuery(queryHash));
  }

  /** `Galaxy.ensureChat` (idempotent default-Session seed).
   *  Result-handler form so a test can assert it completes WITHOUT error — the second
   *  call must NOT throw (proves the create-if-absent guard; a raw create-on-existing
   *  throws "already exists", resources.ts). */
  callGalaxyEnsureSession(scope: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().ensureChat();
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Fetch the Galaxy's permission-filtered query targets (M4 — subscriber clientIds
   *  allowed to read `nodeId`) into `lastResult`. */
  callGalaxyInspectQueryTargets(scope: string, query: QueryDescriptor, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().inspectQueryTargets(query, nodeId);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Fire one transient progress chunk (fire-and-forget, like the server→client stream). */
  callGalaxyStreamChunk(
    scope: string, sessionId: string, messageId: string, chunk: string, nodeId: string, replyTo?: string,
  ): void {
    this.lmz.call('GALAXY', scope,
      this.ctn<GalaxyTest>().streamChunkForTest(sessionId, messageId, chunk, nodeId, replyTo));
  }

  /** Commit the durable agent Message (result-handler form to await). */
  callGalaxyCommitAgent(scope: string, chatId: string, messageId: string, content: string, nodeId: string, replyTo: string, codegen?: Record<string, unknown>): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().commitAgentForTest(chatId, messageId, content, nodeId, replyTo, codegen);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  callStarInspectQuerySubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectQuerySubscribers();
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

  /** Fan the Star's parked reload channel (delivery half of the preservation test). */
  callStarBroadcastReloadForTest(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().broadcastReloadForTest();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /** One scripted TRIGGERED turn (fake model + always-ok build — the reload-trigger drive). */
  callGalaxyChatScripted(scope: string, message: string, script: unknown[], userMessageId = crypto.randomUUID()): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().chatScriptedForTest(userMessageId, message, script);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Clear the GALAXY's QuerySubscribers (the reconnect test's server-side amnesia). */
  callGalaxyClearQuerySubscribers(scope: string): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().clearQuerySubscribersForTest();
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Seed the fake-model script ahead of a REAL `postUserMessage` (the commit-hook
   *  trigger consumes it). Result-handler form so a test can await the seed landing. */
  callGalaxySeedChatScript(scope: string, script: unknown[], opts: { codegen?: boolean } = {}): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().seedChatScriptForTest(script, opts);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  callStarClearSubscribersForTest(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().clearSubscribersForTest();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Resource result handlers (override base class) ---

  @mesh()
  override handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | null | Error): void {
    // Delegate to base for Promise correlation + state write-through (5.3.3a).
    // The base no-ops state write when no StateManager is bound, so tests that
    // don't call bindToState still work.
    super.handleResourceUpdate(resourceType, resourceId, result);

    this.resourceUpdateCount++;
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastErrorObject = result;
      this.lastResourceUpdate = undefined;
    } else {
      this.lastResourceUpdate = { resourceType, resourceId, snapshot: result };
      this.lastError = undefined;
    }
    this.callCompleted = true;
  }

  /** Capture pushes on the DEDICATED global-Profile channel (tasks/nebula-subscriber-lists.md). Delegates
   *  to base for pending-settle + the factory `#profileListener`, then records the latest snapshot + counts
   *  pushes. Kept SEPARATE from resourceUpdate so a dev-user `Profile` resource can't inflate this counter. */
  @mesh()
  override handleProfileUpdate(profileId: string, result: Snapshot | null | Error): void {
    super.handleProfileUpdate(profileId, result);
    this.profileUpdateCount++;
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastErrorObject = result;
      this.lastProfileUpdate = undefined;
    } else {
      this.lastProfileUpdate = { profileId, snapshot: result };
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

  /** Capture query-membership pushes (Child 2). The base is a Phase-3 no-op; this
   *  override records the latest payload (or error) + counts pushes for assertions. */
  @mesh()
  override handleQueryUpdate(queryHash: string, result: QueryUpdatePayload | Error): void {
    super.handleQueryUpdate(queryHash, result);
    this.queryUpdateCount++;
    if (result instanceof Error) {
      this.lastQueryError = result;
    } else {
      this.lastQueryUpdate = { queryHash, result };
    }
  }

  /** Capture STANDALONE subscriber-list roster pushes (tasks/nebula-subscriber-lists.md). Delegates to
   *  base so the roster still lands via the factory listener, then records the latest roster/error +
   *  counts pushes — the server-integration assertion surface (the initiator path bypasses the store). */
  @mesh()
  override handleQuerySubscribersUpdate(queryHash: string, result: SubscriberRosterPayload | Error): void {
    super.handleQuerySubscribersUpdate(queryHash, result);
    this.querySubscribersUpdateCount++;
    this.lastQuerySubscribersUpdate = result instanceof Error
      ? { queryHash, error: result }
      : { queryHash, roster: result };
  }

  /** Capture transient progress chunks (Child 3). Delegates to base so the ephemeral
   *  `#streamingMessages` accumulation + reconcile still run (assert via the public
   *  `streamingProgress(id)` getter); the counter proves a chunk reached this client. */
  @mesh()
  override handleStreamChunk(messageId: string, progress: string, replyTo?: string): void {
    super.handleStreamChunk(messageId, progress, replyTo);
    this.lastStreamReplyTo = replyTo;
    this.streamChunkCount++;
    this.lastStreamChunk = { messageId, progress };
  }

  // --- Galaxy test initiators ---

  callGalaxyAppendOntologyVersion(galaxyName: string, versionConfig: OntologyVersionConfig): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().appendOntologyVersion(versionConfig);
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  /** Apply an ontology directly to a Star (Phase 4: the Galaxy lazy-pull was retired,
   *  so tests install the compiled validator via `Star.setOntology` — the Galaxy's dev
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

  callStarResetAndProbeRootAdmin(starName: string, starAdminSub: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().resetAndProbeRootAdmin(starAdminSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarInspectRootAdmin(starName: string, starAdminSub: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectRootAdmin(starAdminSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }
}
