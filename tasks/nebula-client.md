# Nebula Client

**Phase**: 7
**Status**: Pending
**App**: `apps/nebula/` (NebulaClient lives in the nebula app)
**Depends on**: Phase 5 (Resources + Subscriptions)
**Master task file**: `tasks/nebula.md`
**Sequence diagrams**: `website/docs/nebula/auth-flows.mdx`

> **Walled garden.** Nebula is a product, not a framework. NebulaClient is the only way to connect — there are no alternative routing setups, no "bring your own auth," no escape hatches. See `tasks/nebula.md` § Walled Garden for context.

## Already Done (Phase 2)

The following are implemented in Phase 2 (`tasks/archive/nebula-baseline-access-control.md`) and tested in `test/test-apps/baseline/`:

- **Two-scope model**: Auth scope (determines refresh cookie path) vs active scope (baked into JWT `aud`). Switching active scope requires a refresh call with a different `activeScope`.
- **Access token management**: In-memory per-tab storage, refresh against the auth scope's endpoint.
- **Admin scope switching**: Universe admin gets wildcard JWT, switches active scope via refresh with new `activeScope`.
- **Server-side auth flow**: All endpoints (discover, magic-link, refresh-token, invite, approve, delegation) — see `tasks/archive/nebula-auth.md`.

---

## Remaining Work (Phase 7)

### Discovery-First Login Flow (Client-Side Orchestration)

The server endpoints exist; this is the client-side flow that wires them together. See `website/docs/nebula/auth-flows.mdx` for sequence diagrams.

1. **Enter email** — Single login entry point. Turnstile loads invisibly in background.
2. **Discover** — POST `{prefix}/discover { email }` → Registry returns scopes: `[{ instanceName, isAdmin }, ...]`
3. **Pick scope** — User selects from list (auto-select if only one?)
4. **Try refresh** — POST `{prefix}/{chosen-id}/refresh-token` — browser sends path-scoped cookie if it exists
5. **If refresh succeeds** → access token in memory, enter app
6. **If refresh fails** → POST `{prefix}/{chosen-id}/email-magic-link { email, turnstile }` → "Check your email"
7. **Click magic link** → server validates, issues refresh cookie, redirects to app

**Edge cases**: No scopes returned (offer self-signup). Bookmarked scope URL (skip discovery, try refresh directly).

### WebSocket Keepalive

NebulaClient sends pings every 25 seconds. Server-side `setWebSocketAutoResponse` handles pongs during hibernation — zero billing cost.

**Why needed**: LumenizeClient already auto-reconnects on `onclose`, but some intermediaries (NAT tables, mobile carriers) silently drop idle connections without a close frame. Pings detect this: no pong → client reconnects.

**Grace period tradeoff**: 25-second ping > Gateway's 5-second grace period, so a silent drop means grace expires before detection. Acceptable: active sends trigger TCP timeouts → `onclose` within seconds (inside grace). Worst case is ~25 seconds of stale display, then `onSubscriptionRequired` fires.

### Subscription Management (Depends on Phase 5)

- `onSubscriptionRequired` callback — fires on connect/reconnect, client fetches current state
- Value caching — client holds local `DagTreeState` copy, re-runs computations on push updates
- Push updates from Star → Gateway → Client via `lmz.call()` fan-out
- See `tasks/nebula-scratchpad.md` § Star Subscription Design for detailed design

### Proactive Token Refresh

Access token TTL is ~15 minutes. Client refreshes proactively before expiry (timer or intercept on next request).

---

## Validation Plan

### Test: Coach Carol Multi-Tab with Dual Scopes

Using `browser.context(origin)` to simulate separate tabs:

1. **Tab 1** — NebulaClient connected to `acme.crm.acme-corp`
2. **Tab 2** — same origin (shared cookie jar), NebulaClient connected to `bigco.hr.bigco-hq`
3. Verify path-scoped refresh cookies coexist, each tab refreshes against its own scope
4. Verify access tokens are independent per tab (in-memory)
5. Verify each WebSocket connects to the correct DO instance
6. Verify downstream updates arrive only on the correct connection

### Test: Admin Scope Switching

Single tab, universe admin switching between stars via full re-login:

1. Login → wildcard JWT with `aud: "george-solopreneur.app.tenant-a"`
2. Connect → verify `onSubscriptionRequired` fires
3. Switch: refresh with `activeScope: "george-solopreneur.app.tenant-b"` → new JWT
4. Old client destroyed, new client connects → `onSubscriptionRequired` fires again
5. Verify different `aud` claims across the two sessions

---

## Open Questions

- **Auto-select single scope** — Auto-select if discovery returns one scope? Leaning yes, with a brief flash showing the scope name.
- **Turnstile pre-solving** — Tokens valid 300 seconds (5 min), should cover discover → pick → refresh-fail → magic-link.
- **Redirect after magic link** — Currently hardcodes `/app`. Real URL structure emerges during Phase 8 (Nebula UI).

---

## Related

- `tasks/archive/nebula-auth.md` — Server-side auth (endpoints, DOs, registry)
- `tasks/archive/nebula-baseline-access-control.md` — Phase 2 (two-scope model, admin switching)
- `tasks/nebula-scratchpad.md` § Star Subscription Design — Subscription fan-out design
- `tasks/nebula.md` — Overall Nebula platform architecture
