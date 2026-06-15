# Mesh: `callContext.originRequest` + placement-aware calls

**Status**: design settled 2026-06-12 (interface, capture point, and naming pinned with Larry), not started. Immediate consumer: [nebula-star-root-admin.md](nebula-star-root-admin.md) Part 1b (place the Star near the tenant) — that task depends on this one.

## Objective

Client-originated mesh calls carry a curated snapshot of the originating HTTP request — geo (`request.cf` subset), IP, user agent, accept-language — on `callContext`, so features that need origin facts (DO placement hints, audit logs, i18n) read them generically instead of plumbing one-offs per feature. Plus the write-side companion: a caller can direct placement of a not-yet-created DO via `CallOptions.locationHint`.

## Pinned design (don't re-litigate without new evidence)

### The interface — hybrid, deliberately

```ts
/** Verbatim subset of Cloudflare's request.cf (IncomingRequestCfProperties).
 *  Split rule: everything under `cf` came from the runtime-added `cf` Request
 *  property; every flat OriginRequest field came from a header. */
type OriginCf = Pick<IncomingRequestCfProperties,
  | 'continent' | 'country' | 'isEUCountry'   // placement hint + EU-jurisdiction suggestion
  | 'latitude' | 'longitude'                  // hint-split inputs (strings, per CF)
  | 'region' | 'regionCode' | 'city'          // audit/analytics display ("login from Austin, TX")
  | 'colo'                                    // CF datacenter the connection hit — placement/latency debugging
  | 'timezone'                                // display/scheduling
>;

/** HTTP-level facts from the request that originated this call chain.
 *  Captured by the Gateway at WebSocket upgrade — connection-scoped (refreshed
 *  on each reconnect; may be minutes/hours old mid-session). Undefined when the
 *  origin isn't a LumenizeClient (DO/Worker origins, `newChain: true`). */
export interface OriginRequest {
  cf?: OriginCf;            // absent where the runtime doesn't populate it (previews)
  ip?: string;              // CF-Connecting-IP (edge-set, unspoofable)
  userAgent?: string;       // User-Agent (client-controlled — descriptive only)
  acceptLanguage?: string;  // Accept-Language (client-controlled — descriptive only)
}
```

- **`cf` stays a sub-object** because it is a *verbatim* `Pick` of the global `IncomingRequestCfProperties` — every field name, type, and quirk maps 1:1 to Cloudflare's `request.cf` docs (types-are-schema, zero invented vocabulary). Run `npm run types` before coding (the type is global, per critical.md).
- **`ip`/`userAgent`/`acceptLanguage` are flat typed fields** — the alternative (`headers['cf-connecting-ip']`) is stringly, undiscoverable in autocomplete, and undocumentable in the type. They don't go inside `cf` because that would break the verbatim-Pick property.
- **No `headers` map in v1** (decided 2026-06-12 — supersedes the earlier `captureHeaders`-knob idea): no known consumer, avoids cookie/authorization/`sec-*` denylist machinery, and the 2KB `serializeAttachment` budget is shared with `claims`. Additive non-breaking later if a real consumer appears.
- **Excluded `cf` fields, recorded**: `postalCode` (precision creep, no consumer), `asn`/`asOrganization` (plausible future abuse-detection — additive), `httpProtocol`/`tlsVersion`/`botManagement` (no consumer / entitlement-gated). Any later addition is a cheap additive `Pick` extension.
- **`isEUCountry` keeps CF's `"1"`-or-absent quirk**; `latitude`/`longitude` stay strings. Normalization lives in helpers (`cfToLocationHint`), never in the wire shape.

### Where it lives on CallContext

Top-level `originRequest?: OriginRequest`, parallel to `originAuth` ([types.ts:37](../packages/mesh/src/types.ts)). **Not** in `callChain[0]`: `NodeIdentity` is the small uniform shape every hop appends — an element-0 variant forces a union type on every consumer, and puts Gateway-verified data inside a structure the client partially authors (the Gateway overwrites `callChain[0]` but preserves client-supplied `[1+]`). **Not** in `state`: mutable by any hop; this must be tamper-evident like `originAuth`.

### Capture point — Gateway upgrade handler (deployed-probe verified)

`request.cf` **survives** `stub.fetch()` into a DO, including through `routeDORequest`'s `new Request(request, { headers })` rebuild — deployed-probe verified 2026-06-12; results, method, and trust caveats in [experiments/do-request-cf-probe/FINDINGS.md](../experiments/do-request-cf-probe/FINDINGS.md). The "request.cf is undefined in DOs" community lore is wrong today. Consequences:

- The Gateway upgrade handler ([lumenize-client-gateway.ts:200-280](../packages/mesh/src/lumenize-client-gateway.ts)) reads `request.cf` + the three headers directly off the forwarded upgrade request. **No packages/routing changes for capture** — the Worker-side header-injection design is dead.
- Snapshot goes into the `GatewayConnectionInfo` attachment ([gateway-messages.ts:177](../packages/mesh/src/gateway-messages.ts)) — hibernation-safe, refreshed on every reconnect, ~250–350 bytes against the 2KB `serializeAttachment` cap shared with `claims` (comment the budget; no enforcement in v1).
- Stamped into `baseContext` next to `originAuth` at [lumenize-client-gateway.ts:552](../packages/mesh/src/lumenize-client-gateway.ts) (the "Trust DMZ").
- Trust statement: `cf` is runtime-set at the edge — external clients cannot forge it (an intermediate Worker could via `new Request(req, { cf })`; ours never do). `CF-Connecting-IP` is edge-set. UA/Accept-Language are client-controlled — descriptive only, **never** authorization inputs.
- miniflare **fakes** `request.cf` — local tests prove plumbing only; the deployed probe answered the platform question.

### Write-side companion: `CallOptions.locationHint` + `cfToLocationHint`

- `locationHint?: DurableObjectLocationHint` on `CallOptions` ([types.ts:49](../packages/mesh/src/types.ts)) → `callRawImpl` ([lmz-api.ts:301-303](../packages/mesh/src/lmz-api.ts)) → `getDOStub(ns, nameOrId, options?)` ([get-do-stub.ts](../packages/routing/src/get-do-stub.ts)) → `.getByName(name, options)` / `.get(id, options)`. Additive optional params throughout — existing callers compile untouched.
- Cloudflare semantics to document at the option: best-effort; honored only on the call that **first creates** the DO; ignored (harmless) on every later call; the hint **overrides caller proximity** — that's its purpose.
- `cfToLocationHint(cf: OriginCf | undefined): DurableObjectLocationHint | undefined` in `packages/routing` next to `getDOStub`: continent → hint, with longitude splits for NA (`wnam`/`enam`) and EU (`weur`/`eeur`); AS → `apac` (Middle-East country set → `me`); SA/AF/OC → `sam`/`afr`/`oc`; missing/unparseable → `undefined` (status-quo placement). Deliberately crude — hints are best-effort, so precision beyond continent+split buys nothing.

## Phase 1 — types + Gateway capture

**Goal**: every client-originated call arrives at its callee with `callContext.originRequest` populated.

- [ ] `OriginCf` + `OriginRequest` in `packages/mesh/src/types.ts`; `originRequest?: OriginRequest` on `CallContext` with the staleness JSDoc above. Export from both index and client-index.
- [ ] Gateway upgrade handler: build the snapshot from `request.cf` + headers; add `originRequest?` to `GatewayConnectionInfo`; include in the attachment.
- [ ] Stamp into `baseContext` at the Trust-DMZ site (:552), sourced from the deserialized attachment.
- [ ] **Audit every site that reconstructs a `CallContext` literal** — they explicitly enumerate fields, so the new one silently drops anywhere it's missed: `buildOutgoingCallContext` inherit path ([lmz-api.ts:249-253](../packages/mesh/src/lmz-api.ts) — spreads `originAuth` by name), the fresh-chain path (:233-237, stays `undefined` — correct), `getCurrentCallContextCopy` (:49-53), and the Gateway's client-bound envelope rebuild (:674-678, plain strings / no preprocessing, same as `originAuth`). Consider spread-based reconstruction so the *next* added field can't be dropped.

**Success criteria** (capable-of-failing):
- [ ] DO receiving a client-originated call sees `callContext.originRequest` with the miniflare-mock `cf` values and the UA/Accept-Language the test client sent on upgrade.
- [ ] Multi-hop: the snapshot survives DO→DO forwarding unchanged (guards the :249-253 audit).
- [ ] DO-originated chain and `newChain: true` → `originRequest` is `undefined`.
- [ ] Reconnect with a changed header → snapshot refreshed.
- [ ] Suite green + `npm run type-check` clean.

## Phase 2 — `CallOptions.locationHint` threading + helper

**Goal**: a mesh caller can place a DO it is about to create.

- [ ] `CallOptions.locationHint`; thread through `callRawImpl` → `getDOStub(ns, nameOrId, options?)` → namespace `getByName`/`get`.
- [ ] `cfToLocationHint` in `packages/routing` + pure-function unit tests (each continent, the NA/EU longitude splits, ME country set, missing/garbage cf → `undefined`).
- [ ] **Test (capable-of-failing)**: wrap/spy a namespace and assert `getByName` receives `{ locationHint }` when the option is passed, and no options object otherwise. Actual placement is NOT observable locally (miniflare ignores hints) — same caveat class as jurisdiction ([tasks/archive/playwright-test-template.md](archive/playwright-test-template.md)).

## Phase 3 — docs

- [ ] Mesh docs: extend the page that documents `CallContext`/`originAuth` (managing-context) with `originRequest` (incl. staleness + trust notes) and the calls/options page with `locationHint` semantics (first-creation-only, best-effort, overrides caller proximity).
- [ ] JSDoc on all new surface mirrors the pinned semantics; `@check-example` where examples are testable.

## Notes / future (not v1)

- **Gateway-derived hint on every resolution**: the Gateway could pass `cfToLocationHint(attachment.originRequest?.cf)` on its own `getDOStub` call (:586) so any client-created DO lands near its first user. Tempting, but first-toucher-wins placement deserves deliberate per-namespace thought — defer until a consumer beyond Star provisioning exists.
- **Worker-origin chains**: a `LumenizeWorker` handling an eyeball request holds the `Request` and could self-populate `originRequest` on `newChain`. No consumer yet.
- **`headers?: Record<string, string>` opt-in capture knob** (with cookie/authorization/`sec-*` denylist): only if a real consumer appears.
- **Jurisdiction is deliberately not here** — it changes DO IDs and addressing everywhere; see tasks/backlog.md § Other Nebula backlog ("EU data residency for Stars").
