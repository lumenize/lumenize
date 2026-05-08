# Nebula Client

**Phase**: 7
**Status**: Active — most demo-critical work has shipped via back-end testing; remaining items are subscriptions + UI event wiring (see `nebula-5.3-subscriptions.md`)
**App**: `apps/nebula/` (NebulaClient lives in the nebula app)
**Depends on**: Phase 5 (Resources + single-resource subscriptions)
**Master task file**: `tasks/nebula.md`
**Sequence diagrams**: `website/docs/nebula/auth-flows.mdx`

> **Walled garden.** Nebula is a product, not a framework. NebulaClient is the only way to connect — there are no alternative routing setups, no "bring your own auth," no escape hatches. See `tasks/nebula.md` § Walled Garden for context.

## Already shipped (via back-end testing)

These items got built incrementally as the back-end work needed them:

- **Two-scope model**: `authScope` (refresh cookie path) + `activeScope` (JWT `aud`). Switching active scope requires a refresh call with a different `activeScope`. See `apps/nebula/src/nebula-client.ts`. **Note (2026-05-07)**: with branches as first-class (see `tasks/nebula-branches.md`), `activeScope` becomes 4-tuple (`{u}.{g}.{s}.{branch}`) while `authScope` stays 3-tuple (`{u}.{g}.{s}`). Asymmetric by design — auth scope is identity/permission, active scope is runtime branch routing. The existing scope-switching mechanism handles branch-switching unchanged.
- **Refresh path routing**: `NebulaClient.refresh` POSTs to `${baseUrl}/auth/${authScope}/refresh-token` with `{ activeScope }` body. Cookie-driven; rotation handled server-side.
- **NebulaClientGateway active-scope verification**: `onBeforeCallToClient` checks that mesh→client `aud` matches the connected client's `aud`. See `apps/nebula/src/nebula-client-gateway.ts`.
- **Handler 1 / Handler 2 dispatch from Star**: `transaction()` and `read()` on Star call back to NebulaClient via `lmz.call('NEBULA_CLIENT_GATEWAY', clientId, this.ctn<NebulaClient>().handleTransactionResult(result))`. The fan-out plumbing is in place — only the handlers themselves are stubs.
- **Server-side auth flow**: All endpoints (discover, magic-link, refresh-token, invite, approve, delegation) — see `tasks/archive/nebula-auth.md`.
- **LumenizeClient base**: auto-reconnect on `onclose` with 5-second grace + exponential backoff. NebulaClient inherits this for free.

## What's actually left

### Subscribe + UI event wiring (demo critical path — moved to `nebula-5.3-subscriptions.md`)

**This is the remaining demo-blocking work.** The client-side surface is:

- `handleTransactionResult` and `handleReadResult` — currently stubs in `nebula-client.ts` that just `console.warn`. Need to: update an internal eTag cache, push the new value into `@lumenize/ui` via `setState`, and surface conflict responses for caller handling.
- `subscribe(resourceType, resourceId)` — NebulaClient method that asks Star to register a subscriber and routes incoming pushes to the same `setState` path.
- Auto-resubscribe on reconnect — when LumenizeClient's auto-reconnect succeeds, walk the local subscription registry and re-subscribe each.

**Boundary decision (pinned)**: The integration point is `@lumenize/state`'s `getState`/`setState` (separate package from `@lumenize/ui` — see `tasks/lumenize-ui.md` § Package split), NOT a generic event emitter on NebulaClient. NebulaClient binds to a StateManager instance at construction and writes through. Subscribe pushes flow through a middleware in `@lumenize/state` that updates state by path. The UI (whether ObjectDOM via `@lumenize/ui` or vanilla HTML+JS) reads from / writes to that store; NebulaClient stays invisible to the UI layer. Keeps transport/auth concerns from leaking into UI integrations and funnels everyone through one reactivity model.

Full design and phases live in `tasks/nebula-5.3-subscriptions.md`.

## Deferred to post-demo

Each of these is a polish/production item, not a demo blocker. Studio works around them.

- **Discovery-first login flow** (client-side orchestration): tests bypass with `?_test=true` magic-link; Studio's login UI can hand-craft the flow against the same endpoints. The full discover → pick scope → refresh-or-magic-link sequence becomes important when there are multiple scopes or anonymous users hitting `/auth`. See sequence diagrams at `website/docs/nebula/auth-flows.mdx`.
- **WebSocket keepalive (25-second pings + `setWebSocketAutoResponse`)**: matters when intermediaries (NAT tables, mobile carriers) silently drop idle connections. LumenizeClient's reactive reconnect handles the case where a close frame arrives; pings handle the case where it doesn't. Worst case without keepalive is ~25 seconds of stale display before active sends trigger TCP timeouts and `onSubscriptionRequired` fires. Acceptable for demo.
- **Proactive token refresh**: access token TTL is ~15 minutes. Today the client refreshes reactively on 4401. Proactive timer or intercept-on-next-request avoids a flicker right at the boundary. Polish, not demo-blocking.
- **Scope switching tests** (admin wildcard JWT switching `aud` mid-session). Admin scope switching is supported server-side; the client-side UX for it is post-demo.

## Validation Plan (deferred sub-pieces)

The two existing test designs ("Coach Carol Multi-Tab with Dual Scopes" and "Admin Scope Switching") remain valuable but cover deferred items. Re-prioritize when those items unfreeze.

## Open Questions (deferred along with the items they touch)

- Auto-select single scope on discovery? Confirm during Studio login UI work.
- Turnstile pre-solving — covered by 5-minute token validity, fine as-is.
- Redirect after magic link — currently hardcodes `/app`; real URL structure emerges during Studio.

## Related

- `tasks/nebula-5.3-subscriptions.md` — subscribe + UI wiring (THE remaining demo work for the client)
- `tasks/lumenize-ui.md` — `@lumenize/state` (definitely) and `@lumenize/ui` (conditionally) — the integration point
- `tasks/archive/nebula-auth.md` — server-side auth (endpoints, DOs, registry)
- `tasks/archive/nebula-baseline-access-control.md` — Phase 2 (two-scope model, admin switching)
- `tasks/nebula-scratchpad.md` § Star Subscription Design — subscriber tracking notes carried into 5.3
- `tasks/nebula.md` — overall Nebula platform architecture
