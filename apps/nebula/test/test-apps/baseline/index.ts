/**
 * Baseline test-app for Nebula e2e tests
 *
 * Re-exports all DO classes for wrangler bindings, defines test subclasses
 * (StarTest, NebulaClientTest), and provides the Worker entrypoint.
 */

import { mesh, rawRpc, splitAddress } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';

// Re-export DO classes and entrypoint for wrangler bindings
export {
  NebulaClientGateway,
  Universe,
  NebulaAuthFacade,
  PlatformHost,
  entrypoint as default,
} from '@lumenize/nebula';

// Re-export auth classes (defined in nebula-auth, but wrangler needs them here)
export { NebulaAuthRegistry, NebulaEmailSender } from '@lumenize/nebula-auth';
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

  /** Test-only: call `admitted` at `binding`/`target` on a FRESH chain this Profile starts,
   *  keeping the outcome. Driven in-DO through `runInDurableObject`, outside any mesh call. */
  callFreshChain(binding: string, target: string): void {
    this.ctx.storage.kv.delete('fresh_chain_outcome');
    const self = this.ctn() as any;
    this.lmz.call(binding, target, self.admitted(), self.recordFreshChainOutcome(), { newChain: true });
  }

  /** The handler: the value `admitted`, or the refusal's message. */
  recordFreshChainOutcome(result?: unknown): void {
    this.ctx.storage.kv.put('fresh_chain_outcome', result instanceof Error ? `Error: ${result.message}` : String(result));
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
} from '@lumenize/nebula';
// The compile fn left the barrel with the Worker's compilers — a test Worker may
// still carry it (this app never deploys), imported from the leaf directly.
import { compileOntologyVersion } from '../../../src/ontology-compile';
import { ROW_PATH, wsPath } from '../../../src/build-report';
import type { PermissionTier, WireOperationDescriptor as OperationDescriptor, TransactionResult, Snapshot, OntologyVersionConfig, OntologyVersionRow, SubscriberRow, QueryDescriptor, QueryUpdatePayload, QuerySubscriberRow, SubscriberEntry, SubscriberRosterPayload, ResourceDenied } from '@lumenize/nebula';
import type { ChatMessage, ModelParams, BuildReport } from '../../../src/codegen-loop';
import type { CertificateApi, CertificatePack, CertificateResult } from '../../../src/certificate';

/**
 * A Galaxy's fake certificate-packs API, registered by instance name: the test and the Durable
 * Object share one isolate in this lane, so the test reads `calls` directly. `https` stands in for
 * an `https` origin, which the local stack never has.
 */
export interface FakeCertificates {
  https: boolean;
  /** Every call in order — `order`, `order-returned`, `get:{id}`, `list`, `delete:{id}`. */
  calls: string[];
  packs: CertificatePack[];
  /** What an order answers; by default a pending pack, at once. */
  order?: () => Promise<CertificateResult>;
  /** What a poll answers; by default the pack, still pending. */
  get?: (packId: string) => Promise<CertificateResult>;
  /** Runs as the wake arrives, before the Galaxy handles it — where a test lands a deletion in the
   *  gap between the Registry's answer and the wake. The test and the Galaxy share one isolate. */
  onWake?: () => Promise<void>;
  listDelayMs?: number;
  failDelete?: boolean;
  orderWaitMs?: number;
}
export const certificateFakes = new Map<string, FakeCertificates>();

// ============================================
// Test subclass: StarTest — adds callClient for mesh→client testing
// ============================================

/**
 * `row` with a validator whose `parseBatch` waits `ms` first — the seam that holds a transaction at
 * the validator's await, so a test can land a wipe inside it. The module is the generated one with
 * its class renamed and a subclass exported under the name the loader asks for.
 */
function holdingParse(row: OntologyVersionRow, ms: number): OntologyVersionRow {
  const declaration = 'export class ParserValidator extends DurableObject';
  if (row.validatorBundle.split(declaration).length !== 2) throw new Error('the generated validator changed shape');
  const renamed = row.validatorBundle.replace(declaration, 'class HeldParserValidator extends DurableObject');
  return {
    ...row,
    validatorBundle: `${renamed}
export class ParserValidator extends HeldParserValidator {
  async parseBatch(items) { await new Promise((r) => setTimeout(r, ${ms})); return super.parseBatch(items); }
}
`,
  };
}

export class StarTest extends Star {
  @mesh()
  whoAmI(): string {
    return `You are ${this.lmz.callContext.originAuth!.sub}`;
  }

  /** Test-only: a call target that checks nothing past `onBeforeCall`'s passage. */
  @mesh()
  admitted(): string {
    return 'admitted';
  }

  /** Test-only: call `admitted` at `binding`/`target` on a FRESH chain this node starts, keeping
   *  the outcome. Driven in-DO through `runInDurableObject`, outside any mesh call. */
  callFreshChain(binding: string, target: string): void {
    this.ctx.storage.kv.delete('fresh_chain_outcome');
    const self = this.ctn() as any;
    this.lmz.call(binding, target, self.admitted(), self.recordFreshChainOutcome(), { newChain: true });
  }

  /** The handler: the value `admitted`, or the refusal's message. */
  recordFreshChainOutcome(result?: unknown): void {
    this.ctx.storage.kv.put('fresh_chain_outcome', result instanceof Error ? `Error: ${result.message}` : String(result));
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

  /** Test-only: a Star named `*.explode` fails its teardown before it wipes anything — the
   *  failure the scope lifecycle hooks must log by name while the other targets still wipe. */
  protected override async beforeTeardown(): Promise<void> {
    if (this.lmz.instanceName?.endsWith('.explode')) throw new Error('injected teardown failure (test)');
    await super.beforeTeardown();
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
      ctn.recordClientCallOutcome(),
      { onErrorOnly: true },
    );
  }

  /** Test-only: `callClient`, keeping a refusal so a test can match it by its message. */
  @mesh(requireDominionHere)
  callClientReporting(clientAddress: string, clientMethod: string, ...args: any[]): void {
    const ctn = this.ctn() as any;
    this.ctx.storage.kv.delete('client_call_outcome');
    const { bindingName, instanceName } = splitAddress(clientAddress);
    this.lmz.call(bindingName, instanceName, ctn[clientMethod](...args), ctn.recordClientCallOutcome());
  }

  /** The handler, at this node's fire-back door. The Gateway fires back a refusal's Error or the
   *  Client's answer, and this records refusals only. */
  recordClientCallOutcome(result?: unknown): void {
    if (result instanceof Error) this.ctx.storage.kv.put('client_call_outcome', result.message);
  }

  @mesh(requireDominionHere)
  clientCallOutcome(): string | undefined {
    return this.ctx.storage.kv.get<string>('client_call_outcome');
  }

  /** Test-only: call a `NebulaAuthFacade` method on a FRESH chain, so no client's claims ride it —
   *  the shape no page can produce — keeping the outcome for {@link facadeCallOutcome}. */
  @mesh(requireDominionHere)
  callFacadeFreshChain(method: string, ...args: any[]): void {
    this.ctx.storage.kv.delete('facade_call_outcome');
    const facade = this.ctn<NebulaAuthFacade>() as any;
    this.lmz.call('NEBULA_AUTH_FACADE', undefined, facade[method](...args),
      (this.ctn() as any).recordFacadeCallOutcome(), { newChain: true });
  }

  /** The handler: an admission refusal answers inside the ack, so it runs here with the Error. */
  recordFacadeCallOutcome(result?: unknown): void {
    this.ctx.storage.kv.put('facade_call_outcome', result instanceof Error ? `error: ${result.message}` : 'ok');
  }

  @mesh(requireDominionHere)
  facadeCallOutcome(): string | undefined {
    return this.ctx.storage.kv.get<string>('facade_call_outcome');
  }

  /**
   * Test-only: dump the ontology-related KV keys so tests can verify the
   * single-row invariant (the lifecycle checks). Returns the ordered
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
   * Test-only (smoke/browser harness): compile an ontology version and hand it to this Star the
   * way its Galaxy's answer arrives — `resourcesResults.onOntologyPulled`, the path a production
   * install takes — so a test pins a Star's ontology without a Galaxy loop. An installed version
   * is skipped and a `wipeOnInstall` row wipes, exactly as a pulled row does. It takes SOURCE and
   * compiles here, in the test Worker, because the only alternative is a remote entry taking a
   * compiled row — a caller handing a Star a validator bundle from outside the registry, which
   * the undecorated `resourcesResults` gate refuses. It is NOT an import limit: `ontology-compile.ts`
   * loads in plain Node, so the Node-side callers could compile. It does keep the compiler, which
   * is not browser-safe, out of the chromium lane's bundle (`test/chromium/ontology-admin.ts`).
   */
  @mesh(requireDominionHere)
  applyOntologyForTest(versionConfig: OntologyVersionConfig, holdParseMs?: number): void {
    const row = compileOntologyVersion(versionConfig);
    this.resourcesResults.onOntologyPulled(holdParseMs ? holdingParse(row, holdParseMs) : row);
  }

  /** Hand `resourcesResults.onOntologyPulled` an answer that is not a row — the Galaxy's `null`
   *  (nothing applied yet) or a delivered Error — the two shapes a real pull can come back as. */
  @mesh(requireDominionHere)
  deliverOntologyAnswerForTest(answer: 'null' | 'error'): void {
    this.resourcesResults.onOntologyPulled(answer === 'null' ? null : new Error('the pull failed'));
  }

  /** Re-run `onStart` — a re-initialized DO, whose plane rebuilds every cache from storage. */
  @mesh(requireDominionHere)
  reInitForTest(): void {
    this.onStart();
  }

  /**
   * Test-only: dump the resource rows of the `Subscriptions` table so tests can verify
   * idempotency and row content. PK-ordered. Admin-gated to avoid client tests leaking
   * the registry shape unintentionally.
   */
  @mesh(requireDominionHere)
  inspectSubscribers(): SubscriberRow[] {
    return this.ctx.storage.sql.exec<SubscriberRow>(
      `SELECT topic AS resourceId, clientAddress, sub, profileId, dominionOverHostAtSubscribe, subscribedAt
       FROM Subscriptions WHERE kind = 'resource' ORDER BY topic, clientAddress`,
    ).toArray();
  }

  /** Test-only: dump the query rows — idempotency / single-row checks + content.
   *  PK-ordered. Admin-gated. */
  @mesh(requireDominionHere)
  inspectQuerySubscribers(): QuerySubscriberRow[] {
    return this.ctx.storage.sql.exec<QuerySubscriberRow>(
      `SELECT topic AS queryHash, query, clientAddress, sub, profileId, dominionOverHostAtSubscribe, subscribedAt
       FROM Subscriptions WHERE kind = 'query' ORDER BY topic, clientAddress`,
    ).toArray();
  }

  /** Test-only: dump the tree rows (the dedicated org-tree channel). */
  @mesh(requireDominionHere)
  inspectTreeSubscribers(): Array<{ clientAddress: string; subscribedAt: string }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT clientAddress, subscribedAt FROM Subscriptions WHERE kind = 'tree' ORDER BY clientAddress`,
    ).toArray();
    return rows as unknown as Array<{ clientAddress: string; subscribedAt: string }>;
  }

  /**
   * Test-only: delete every resource row, so a reconnect test can show that the client's
   * re-subscribe walk is what re-inserts them — a row that simply survived the socket would
   * otherwise hide a missing walk. Admin-gated.
   */
  @mesh(requireDominionHere)
  clearSubscribersForTest(): void {
    this.ctx.storage.sql.exec(`DELETE FROM Subscriptions WHERE kind = 'resource'`);
  }

  /**
   * Test-only: bench WS-leg baseline. Bounces a one-byte payload back to the
   * client via the same mesh-callback mechanism as transaction(); the bench
   * subtracts this round-trip from transaction latency to isolate in-Worker
   * cost from network round-trip.
   */
  @mesh()
  ping(): void {
    const origin = this.lmz.callContext.callChain[0];
    if (!origin?.instanceName) {
      throw new Error('ping requires a client origin with instanceName in callChain[0]');
    }
    this.lmz.call(origin.bindingName, origin.instanceName,
      (this.ctn() as any).handlePingResult(1), (this.ctn() as any).recordClientCallOutcome(), { onErrorOnly: true });
  }

  /**
   * Test-only (cold-start anatomy, 2026-07-22): the PURE mesh round-trip — returns
   * its argument straight back, touching neither the ontology nor the resources plane. The
   * 4-arg fire-back delivers the value to the client's `handleResult`. A COLD echo on
   * a fresh Star therefore isolates fresh-Star cold-wake (placement + onStart schema/
   * ROOT + onBeforeCall scope-check) from any data-plane operation —
   * the clean counterpart to `transaction`'s cold path.
   */
  @mesh()
  echo(value: unknown): unknown {
    return value;
  }

  /**
   * Test-only: spike handler for the ws.send flush experiment in
   * `tasks/gateway-hop-benchmark.md`. Forces a known-duration await on the
   * Star side; the Gateway's invocation is paused at
   * `await stub.__executeOperation(envelope)` for at least `delayMs`. The
   * spike test pairs this with a `BENCH_MARKER` frame emitted from the
   * Gateway's `onBeforeCallToMesh` hook (before that await) to measure
   * whether the marker reaches the client mid-invocation (~delayMs ahead
   * of the response) or coincident with it.
   *
   * Returns the delay value directly (rather than via mesh callback) so the
   * response arrives via the normal fire-back path. Wall-clock billing
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
   * (the gateway-hop benchmark) to verify same-DC vs
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

  // --- Dev-data lifecycle inspection (moved off the deleted DevStarTest).
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
}

// (DevStarTest deleted with the DevStar→Star collapse. The dev Star is now a
// StarTest at a {u}.{g}.dev instance; its lifecycle inspection hooks moved onto StarTest.)

// ============================================
// Test subclass: GalaxyTest — the GALAXY binding's class. IS-A Galaxy (ontology
// registry + chat data-plane + codegen seams), plus the protected data-plane seams
// exposed for tests that can't run the wrangler-dev-only `chat` codegen loop.
// ============================================

export class GalaxyTest extends Galaxy {
  /** Test-only: a call target that checks nothing past `onBeforeCall`'s passage. */
  @mesh()
  admitted(): string {
    return 'admitted';
  }

  /** Test-only: call `admitted` at `binding`/`target` on a FRESH chain this node starts, keeping
   *  the outcome. Driven in-DO through `runInDurableObject`, outside any mesh call. */
  callFreshChain(binding: string, target: string): void {
    this.ctx.storage.kv.delete('fresh_chain_outcome');
    const self = this.ctn() as any;
    this.lmz.call(binding, target, self.admitted(), self.recordFreshChainOutcome(), { newChain: true });
  }

  /** The handler: the value `admitted`, or the refusal's message. */
  recordFreshChainOutcome(result?: unknown): void {
    this.ctx.storage.kv.put('fresh_chain_outcome', result instanceof Error ? `Error: ${result.message}` : String(result));
  }

  /** Test-only: the wake, after the fake's `onWake` has run. */
  @rawRpc()
  override async orderCertificate(operationId: string): Promise<void> {
    await certificateFakes.get(this.lmz.instanceName ?? '')?.onWake?.();
    return super.orderCertificate(operationId);
  }

  protected override ordersCertificates(): boolean {
    return certificateFakes.get(this.lmz.instanceName ?? '')?.https ?? super.ordersCertificates();
  }

  protected override certificateApi(): CertificateApi | undefined {
    const fake = certificateFakes.get(this.lmz.instanceName ?? '');
    if (!fake) return super.certificateApi();
    if (fake.orderWaitMs !== undefined) this.certificateOrderWaitMs = fake.orderWaitMs;
    return {
      order: async () => {
        fake.calls.push('order');
        const result = await (fake.order?.() ?? Promise.resolve<CertificateResult>({ ok: true, packId: 'p-ordered', status: 'pending_validation' }));
        fake.calls.push('order-returned');
        return result;
      },
      get: async (id) => {
        fake.calls.push(`get:${id}`);
        return fake.get?.(id) ?? { ok: true, packId: id, status: 'pending_validation' };
      },
      list: async () => {
        fake.calls.push('list');
        if (fake.listDelayMs) await new Promise((r) => setTimeout(r, fake.listDelayMs));
        return [...fake.packs];
      },
      delete: async (id) => {
        fake.calls.push(`delete:${id}`);
        if (fake.failDelete) throw new Error('injected delete failure (test)');
      },
    };
  }

  /** Test-only: a directed call from this Galaxy to a client, keeping a refusal by its message. */
  @mesh(requireDominionHere)
  callClientReporting(clientAddress: string, clientMethod: string, ...args: any[]): void {
    const ctn = this.ctn() as any;
    this.ctx.storage.kv.delete('client_call_outcome');
    const { bindingName, instanceName } = splitAddress(clientAddress);
    this.lmz.call(bindingName, instanceName, ctn[clientMethod](...args), ctn.recordClientCallOutcome());
  }

  /** The handler, at this node's fire-back door. The Gateway fires back a refusal's Error or the
   *  Client's answer, and this records refusals only. */
  recordClientCallOutcome(result?: unknown): void {
    if (result instanceof Error) this.ctx.storage.kv.put('client_call_outcome', result.message);
  }

  @mesh(requireDominionHere)
  clientCallOutcome(): string | undefined {
    return this.ctx.storage.kv.get<string>('client_call_outcome');
  }

  // Scripted chat support: a fake model script (per-round responses, consumed by the
  // shared `runModel` router — the loop's every round rides it) + an always-ok build, so the
  // trigger pipeline is drivable in-lane. A `{ __delayMs }`
  // entry sleeps then falls through — the lever for spanning a generation across
  // commits (the single-flight tests). The REAL container drive is the build-box /live
  // scenario; nothing here reaches ctx.container (absent under vitest-plugin anyway).
  #chatScript: unknown[] = [];
  /** Every `messages` array handed to the model, across turns — the prompt as assembled,
   *  so a test can read a turn's system layer (`messages[0]`) and its request. Cleared by
   *  the reader. */
  #seenMessages: unknown[][] = [];
  /** The tool NAMES handed to the model per call — the full set, on every turn. */
  #seenToolNames: string[][] = [];
  protected override async runModel(_model: string, body: Record<string, unknown>): Promise<unknown> {
    if (Array.isArray(body.messages)) {
      this.#seenMessages.push(body.messages.map((m) => ({ ...(m as object) })));
      const tools = Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: string } }> : [];
      this.#seenToolNames.push(tools.map((t) => t.function?.name ?? '?'));
    }
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
  protected override async build(
    opts: { ontology?: { version: string; wipe: boolean } } = {},
  ): Promise<BuildReport> {
    // A clean report, shaped exactly as the real job's (preview is the layer above's
    // decision — the seam's placeholder, overwritten by #buildAndAnnounce). When the host
    // passes an ontology job, compile IN PLACE and write the row where the real job
    // does (an fs write at ROW_PATH — the dev-studio probe's shape), so the Apply's
    // host-side read-back, version check and append run unchanged in this lane too.
    let ontology: BuildReport['ontology'] = { ran: false, why: 'no ontology change (host passed no version)' };
    if (opts.ontology) {
      try {
        const types = await this.workspaceFs().readFile(wsPath('src/ontology.d.ts'), 'utf8');
        const row = compileOntologyVersion({
          version: opts.ontology.version, types,
          ...(opts.ontology.wipe ? { wipeOnInstall: true } : {}),
        });
        await this.workspaceFs().mkdir(wsPath('.nebula'), { recursive: true });
        await this.workspaceFs().writeFile(wsPath(ROW_PATH), JSON.stringify(row));
        ontology = { ran: true, ok: true, rowPath: ROW_PATH };
      } catch (e) {
        ontology = { ran: true, ok: false, tail: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      container: { ran: true, ok: true },
      ontology,
      typeCheck: { ran: true, checked: ['src/App.vue'], findings: [] },
      bundle: { ran: true, ok: true },
      preview: { refreshed: false, why: 'not decided at the build layer' },
    };
  }

  /** No script seeded → NO turn. Tests that post user Messages without a script assert on
   *  their own messages alone; until 2026-09-06 an unscripted turn threw script-exhausted
   *  and died silently, which those tests leaned on without saying so. A failed model call
   *  now commits an error reply (the controlled `error` stop), so the no-turn is explicit. */
  protected override async runTriggeredTurn(userMessageId: string, message: string): Promise<void> {
    if (this.#chatScript.length === 0) {
      debug('nebula.GalaxyTest.trigger').debug('no script seeded — the turn is a no-op', { userMessageId });
      return;
    }
    await super.runTriggeredTurn(userMessageId, message);
  }

  /** Run ONE real TRIGGERED turn against the scripted model (the whole pipeline:
   *  loop → commit → build-completion reload trigger).
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
  seedChatScriptForTest(script: unknown[]): void {
    this.#chatScript = [...script];
  }

  /** The prompts the model saw since the last read (one `messages` array per model call),
   *  then cleared. */
  @mesh(requireDominionHere)
  takeSeenMessagesForTest(): unknown[][] {
    const out = this.#seenMessages;
    this.#seenMessages = [];
    return out;
  }

  /** The tool names each model call carried since the last read, then cleared. */
  @mesh(requireDominionHere)
  takeSeenToolNamesForTest(): string[][] {
    const out = this.#seenToolNames;
    this.#seenToolNames = [];
    return out;
  }

  /** The row the chat-ontology source answers instead of the platform seed, when a test set one. */
  #sourceRow: OntologyVersionRow | undefined;
  protected override ontologySource(): OntologyVersionRow {
    return this.#sourceRow ?? super.ontologySource();
  }

  /** Make the chat-ontology source answer `versionConfig`'s row — the way a newer platform seed
   *  would arrive — or the platform seed again when none is given. Nothing installs until an op
   *  finds its pinned version differs. */
  @mesh(requireDominionHere)
  setChatSourceForTest(versionConfig?: OntologyVersionConfig): void {
    this.#sourceRow = versionConfig ? compileOntologyVersion(versionConfig) : undefined;
  }

  /** Re-run `onStart` — a re-initialized DO, whose plane rebuilds every cache from storage. */
  @mesh(requireDominionHere)
  async reInitForTest(): Promise<void> {
    await this.onStart();
  }

  /** The installed chat ontology's version, read from the plane. */
  @mesh(requireDominionHere)
  installedChatVersionForTest(): string {
    return this.chatOntology().version;
  }

  /** Test-only: delete every query row — the reconnect test's server-side amnesia, so the
   *  client's re-subscribe walk is what restores fanout (without it the walk's absence would
   *  be invisible: rows would just still exist). */
  @mesh(requireDominionHere)
  clearQuerySubscribersForTest(): void {
    this.ctx.storage.sql.exec(`DELETE FROM Subscriptions WHERE kind = 'query'`);
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
  /** The raw `result` of the latest resource push — a snapshot, the denied frame, `null` or an
   *  Error — so a test can assert a frame exactly, including keys the client drops. */
  lastResourceResult: Snapshot | ResourceDenied | null | Error | undefined = undefined;
  resourceUpdateCount = 0;

  // --- handleProfileUpdate capture (the DEDICATED global-Profile channel — tasks/nebula-subscriber-lists.md).
  //     Separate from resourceUpdate so a dev-user `Profile` resource and a platform profile never share a
  //     counter. CUMULATIVE count. ---
  lastProfileUpdate: { profileId: string; snapshot: Snapshot | null } | undefined = undefined;
  profileUpdateCount = 0;

  // --- handleOrgTreeUpdate capture (the dedicated org-tree channel) ---
  lastOrgTree: unknown = undefined;
  orgTreeUpdateCount = 0;

  /** `handlePreviewReady` capture — the BUILD reply's landing point (the Galaxy answers
   *  whoever asked for the build). CUMULATIVE — NOT zeroed by resetResults (it's a channel
   *  counter; baseline it before the action under test, per testing.md). */
  previewReadyCount = 0;

  // --- handleQueryUpdate capture (the query channel). Reset explicitly by the
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

  // --- handleStreamChunk capture (the transient progress stream). CUMULATIVE —
  //     count of chunks received; read `streamingProgress(id)` for the accumulated text. ---
  lastStreamChunk: { messageId: string; progress: string } | undefined = undefined;
  streamChunkCount = 0;
  /** The attribution the last chunk carried — the id of the USER message whose turn is streaming. */
  lastStreamReplyTo: string | undefined;
  /** Every push as it arrived: which handler, whose `originAuth.sub` rode it (none when the chain
   *  started fresh), and the call chain's binding names. CUMULATIVE — the identity probe's surface. */
  pushOrigins: Array<{ handler: string; originSub?: string; chain: string[] }> = [];

  /** Every refusal the one-way initiators below heard, in order. */
  callFailures: string[] = [];

  /** The result handler for a one-way initiator, sent `onErrorOnly`: keeps any refusal. */
  recordCallFailure(result?: unknown): void {
    if (result instanceof Error) this.callFailures.push(result.message);
  }

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
    this.lastResourceResult = undefined;
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

  /** Count the build reply. `super` keeps the real `handlePreviewReady → #onPreviewReady`
   *  path (unset in most tests → a no-op); the counter proves the signal reached THIS
   *  client, which is the whole point of a reply addressed at the requester. */
  @mesh()
  override handlePreviewReady(scope: string): void {
    this.#recordPush('handlePreviewReady');
    this.previewReadyCount++;
    super.handlePreviewReady(scope);
  }

  // --- Test initiators (tests call these to trigger outbound mesh calls) ---
  // Uses this.lmz.call() with this.ctn<TargetType>().method(args) continuation pattern

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

  /** Drive `Star.resetDevData` against the STAR binding (a non-`.dev`
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

  // --- OrgTree test initiators ---

  callStarOrgTreeGetState(starName: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.getState();
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
    const remote = this.ctn<Star>().resources.orgTree.createNode(nodeId, parentId, slug, label);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /**
   * Test-only: fire `callAsync` at Star's `delay(delayMs)` with a short `timeoutMs`, so the RESULT
   * (arriving at ~delayMs) loses the race to `callAsync`'s timeout. Proves the `orgTree.*` mutation
   * path (which delegates to `callAsync`) rejects on a lost/slow RESULT instead of hanging — on
   * the timer-free client path, with NO engine-level timer to confound the rejection (m1). Returns the
   * `callAsync` Promise directly so a test can await/assert its rejection.
   */
  callAsyncStarDelay(starName: string, delayMs: number, timeoutMs: number): Promise<number> {
    return this.lmz.callAsync('STAR', starName, (this.ctn<Star>() as any).delay(delayMs), { timeoutMs });
  }

  callStarAddEdge(starName: string, parentId: string, childId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.addEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRemoveEdge(starName: string, parentId: string, childId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.removeEdge(parentId, childId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarReparentNode(starName: string, childId: string, oldParentId: string, newParentId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.reparentNode(childId, oldParentId, newParentId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarDeleteNode(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.deleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarUndeleteNode(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.undeleteNode(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRenameNode(starName: string, nodeId: string, newSlug: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.renameNode(nodeId, newSlug);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRelabelNode(starName: string, nodeId: string, newLabel: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.relabelNode(nodeId, newLabel);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarSetPermission(starName: string, nodeId: string, targetSub: string, level: PermissionTier): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.setPermission(nodeId, targetSub, level);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarRevokePermission(starName: string, nodeId: string, targetSub: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.revokePermission(nodeId, targetSub);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarCheckPermission(starName: string, nodeId: string, tier: PermissionTier, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().resources.orgTree.checkPermission(nodeId, tier, targetSub)
      : this.ctn<Star>().resources.orgTree.checkPermission(nodeId, tier);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /** Drive the non-throwing batch eval (explicit sub + stored
   *  hasDominionOverHost). Returns `{ allowed: Set, denied: Set }` — structured-clone
   *  preserves the Sets across the mesh. */
  callStarEvaluatePermissions(
    starName: string, nodeIds: string[], tier: PermissionTier, sub: string, hasDominionOverHost: boolean,
  ): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.evaluatePermissions(nodeIds, tier, sub, hasDominionOverHost);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetEffectivePermission(starName: string, nodeId: string, targetSub?: string): void {
    this.resetResults();
    const remote = targetSub
      ? this.ctn<Star>().resources.orgTree.getEffectivePermission(nodeId, targetSub)
      : this.ctn<Star>().resources.orgTree.getEffectivePermission(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeAncestors(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.getNodeAncestors(nodeId);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callStarGetNodeDescendants(starName: string, nodeId: string): void {
    this.resetResults();
    const remote = this.ctn<Star>().resources.orgTree.getNodeDescendants(nodeId);
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
    // Transactions now return via `callAsync`: a `TransactionResult` on success, an
    // `OntologyStaleError` as a VALUE on stale, or a rejection on infra error. Capture into the legacy
    // `lastResult` / `lastError` / `callCompleted` fields the `callStarTransaction` tests assert on.
    try {
      const result = await this.lmz.callAsync('STAR', starName,
        this.ctn<Star>().resources.transaction(ontologyVersion, txnETag, ops));
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

  /** Test-only: in-flight `callAsync` count (the transient surface — proves the retired submit-gate
   *  lets concurrent independent-resource transactions run; a re-added serial gate would keep this 1). */
  getPendingAsyncCallCount(): number {
    return this.pendingAsyncCallCount();
  }

  async callStarRead(starName: string, ontologyVersion: string, resourceId: string): Promise<void> {
    this.resetResults();
    // Reads now return via `callAsync`; capture into the legacy `lastResult` /
    // `lastError` / `callCompleted` fields that the `callStarRead` tests assert on (via `waitForResult`).
    try {
      this.lastResult = await this.lmz.callAsync('STAR', starName,
        this.ctn<Star>().resources.read(ontologyVersion, resourceId));
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
      this.ctn<Star>().resources.subscribe(ontologyVersion, resourceType, resourceId),
      this.ctn<this>().recordCallFailure(), { onErrorOnly: true });
  }

  callStarInspectSubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectSubscribers();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Query subscription initiators (fire-and-forget — host delivers
  //     via handleQueryUpdate) ---

  callStarSubscribeQuery(starName: string, query: QueryDescriptor): void {
    this.lastQueryUpdate = undefined;
    this.lastQueryError = undefined;
    this.queryUpdateCount = 0;
    this.lmz.call('STAR', starName, this.ctn<Star>().resources.subscribeQuery(query),
      this.ctn<this>().recordCallFailure(), { onErrorOnly: true });
  }

  callStarUnsubscribeQuery(starName: string, queryHash: string): void {
    this.lmz.call('STAR', starName, this.ctn<Star>().resources.unsubscribeQuery(queryHash),
      this.ctn<this>().recordCallFailure(), { onErrorOnly: true });
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
    this.lmz.call('STAR', starName, this.ctn<Star>().resources.subscribeTree(),
      this.ctn<this>().recordCallFailure(), { onErrorOnly: true });
  }

  callStarInspectTreeSubscribers(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectTreeSubscribers();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  /** One scripted TRIGGERED turn (fake model + always-ok build — the reload-trigger drive). */
  callGalaxyChatScripted(scope: string, message: string, script: unknown[], userMessageId = crypto.randomUUID()): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().chatScriptedForTest(userMessageId, message, script);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Read (and clear) the prompts the GALAXY's scripted model saw — `lastResult` holds them. */
  callGalaxyTakeSeenMessages(scope: string): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().takeSeenMessagesForTest();
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Read (and clear) the tool names each model call carried — `lastResult` holds them. */
  callGalaxyTakeSeenToolNames(scope: string): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().takeSeenToolNamesForTest();
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Clear the GALAXY's query rows (the reconnect test's server-side amnesia). */
  callGalaxyClearQuerySubscribers(scope: string): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().clearQuerySubscribersForTest();
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  /** Seed the fake-model script ahead of a REAL `postUserMessage` (the commit-hook
   *  trigger consumes it). Result-handler form so a test can await the seed landing. */
  callGalaxySeedChatScript(scope: string, script: unknown[]): void {
    this.resetResults();
    const remote = this.ctn<GalaxyTest>().seedChatScriptForTest(script);
    this.lmz.call('GALAXY', scope, remote, this.ctn().handleResult(remote));
  }

  callStarClearSubscribersForTest(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().clearSubscribersForTest();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Resource result handlers (override base class) ---

  @mesh()
  override handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | ResourceDenied | null | Error): void {
    // Delegate to base for Promise correlation + state write-through (5.3.3a).
    // The base no-ops state write when no StateManager is bound, so tests that
    // don't call bindToState still work.
    super.handleResourceUpdate(resourceType, resourceId, result);
    this.#recordPush('handleResourceUpdate');

    this.resourceUpdateCount++;
    this.lastResourceResult = result;
    if (result instanceof Error) {
      this.lastError = result.message;
      this.lastErrorObject = result;
      this.lastResourceUpdate = undefined;
    } else if (result !== null && 'deniedNodes' in result) {
      // A denied frame is not a snapshot: `lastResourceResult` carries it.
      this.lastResourceUpdate = undefined;
      this.lastError = undefined;
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
    this.#recordPush('handleOrgTreeUpdate');
    this.orgTreeUpdateCount++;
    this.lastOrgTree = envelope.value;
  }

  /** Capture query-membership pushes. Delegates to the base, which updates the client's own query
   *  entry; this override records the latest payload (or error) + counts pushes for assertions. */
  @mesh()
  override handleQueryUpdate(queryHash: string, result: QueryUpdatePayload | Error): void {
    super.handleQueryUpdate(queryHash, result);
    this.#recordPush('handleQueryUpdate');
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
    this.#recordPush('handleQuerySubscribersUpdate');
    this.querySubscribersUpdateCount++;
    this.lastQuerySubscribersUpdate = result instanceof Error
      ? { queryHash, error: result }
      : { queryHash, roster: result };
  }

  /** Capture transient progress chunks. Delegates to base so the ephemeral
   *  `#streamingMessages` accumulation + reconcile still run (assert via the public
   *  `streamingProgress(id)` getter); the counter proves a chunk reached this client. */
  @mesh()
  override handleStreamChunk(messageId: string, progress: string, replyTo?: string): void {
    super.handleStreamChunk(messageId, progress, replyTo);
    this.#recordPush('handleStreamChunk');
    this.lastStreamReplyTo = replyTo;
    this.streamChunkCount++;
    this.lastStreamChunk = { messageId, progress };
  }

  #recordPush(handler: string): void {
    const cc = this.lmz.callContext;
    this.pushOrigins.push({ handler, originSub: cc.originAuth?.sub, chain: cc.callChain.map((n) => n.bindingName) });
  }

  // --- Galaxy test initiators ---

  /** Seed a Star with an ontology for a test — via the test subclass's
   *  `applyOntologyForTest` entry, which compiles server-side (a test Worker may carry
   *  the compiler; the deployed Worker never does) and hands the row to `resourcesResults.onOntologyPulled`,
   *  where a Galaxy's answer lands. This initiator exists so a test can pin a Star's ontology
   *  without a Galaxy loop, and goes through the test-app door rather than any production entry. */
  callStarInstallOntology(starName: string, versionConfig: OntologyVersionConfig): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().applyOntologyForTest(versionConfig);
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  callGalaxyGetCurrentOntology(galaxyName: string): void {
    this.resetResults();
    const remote = this.ctn<Galaxy>().getCurrentOntology();
    this.lmz.call('GALAXY', galaxyName, remote, this.ctn().handleResult(remote));
  }

  callStarInspectOntologyKv(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectOntologyKv();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

  // --- Dev-data lifecycle initiators (the .dev Star is the STAR binding at a
  //     {u}.{g}.dev instance — resetDevData + these inspect hooks live on base
  //     Star/StarTest, hard-guarded to .dev at runtime). ---

  callStarInspectReset(starName: string): void {
    this.resetResults();
    const remote = this.ctn<StarTest>().inspectReset();
    this.lmz.call('STAR', starName, remote, this.ctn().handleResult(remote));
  }

}
