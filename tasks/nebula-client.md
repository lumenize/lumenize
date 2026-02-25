# Nebula Client

**Package**: `@lumenize/nebula-client` (or part of `@lumenize/nebula`)
**Depends on**: `@lumenize/nebula-auth`

> **Walled garden.** Nebula is a product, not a framework. NebulaClient is the only way to connect — there are no alternative routing setups, no "bring your own auth," no escape hatches. See `tasks/nebula.md` § Walled Garden for context.

## Login Flow (Discovery-First)

Every login goes through discovery. There is no scope-specific login page — the single login entry point always starts with "enter your email."

### Flow

1. **Enter email** — User arrives at the login page, enters their email address. Turnstile widget loads invisibly in the background.
2. **Discover** — Client POSTs to `{prefix}/discover { email }`. Registry returns all scopes the email belongs to: `[{ instanceName, isAdmin }, ...]`.
3. **Pick scope** — User selects a scope from the list. (If only one scope, could auto-select.)
4. **Try refresh** — Client POSTs to `{prefix}/{chosen-id}/refresh-token`. Since the refresh cookie is `HttpOnly`, the client can't check locally whether one exists — it makes the round trip and lets the browser send the cookie if the path matches.
5. **If refresh succeeds** — Access token returned immediately. Client stores it in memory (per-tab) and enters the app.
6. **If refresh fails** — Client POSTs to `{prefix}/{chosen-id}/email-magic-link { email, turnstile }` using the pre-solved Turnstile token. Server sends magic link email. UI shows "Check your email."
7. **Click magic link** — User clicks link in email → `GET {prefix}/{chosen-id}/magic-link?one_time_token=...` → server validates, issues path-scoped refresh cookie, redirects to app.

### Why Discovery-First

- **No login loops** — A failed refresh leads to magic link for the specific scope, not back to discovery.
- **Single entry point** — One login page for all scopes. No need for scope-specific login URLs.
- **Coach scenario** — Coach Carol enters her email once, sees all her client scopes, picks one. Each scope gets its own path-scoped cookie so tabs don't interfere.

### Edge Cases

- **No scopes returned** — User has no existing access. UI offers self-signup options (claim universe, claim star) or shows "you don't have access yet."
- **Bookmarked scope URL** — Client already knows the `universeGalaxyStarId` from the URL. Can skip discovery and try refresh directly, falling back to magic link if it fails. This is a client-side optimization, not a separate flow.

---

## Access Token Management

- Access tokens are stored **in memory per tab** (not localStorage, not cookies).
- Each tab refreshes independently against its scope's refresh endpoint.
- Access token TTL is ~15 minutes. Client refreshes proactively before expiry.
- The `universeGalaxyStarId` determines which refresh endpoint to call: `{prefix}/{id}/refresh-token`.

---

## WebSocket Keepalive

NebulaClient sends pings every 25 seconds by default (not configurable). On the server side, `setWebSocketAutoResponse` handles pongs during DO hibernation — zero billing cost, no wake-up.

**Primary reconnect mechanism:** LumenizeClient already auto-reconnects on `onclose` (with exponential backoff, plus immediate retry on visibility change, focus, and online events). When an intermediary properly closes the connection, `onclose` fires and the LumenizeClientGateway's 5-second grace period bridges the gap — no messages lost.

**Why pings are still needed:** Some intermediaries (home router NAT tables, mobile carriers, corporate proxies) silently drop idle connections without sending a close frame — the NAT mapping ages out and the NAT has no state left to send an RST to the client. In that case, `onclose` never fires — the client thinks it's connected but stops receiving updates with no indication anything is wrong. A vibe coder with no development experience would have no idea why their real-time app just froze. Pings detect this silent death: no pong back within the interval → client knows to reconnect.

**Grace period tradeoff:** The 25-second ping interval exceeds the Gateway's 5-second grace period, so a silent drop means the grace window expires before the client detects the dead connection. This is acceptable: user *sends* during the dead period trigger TCP retransmit timeouts → `onclose` within seconds (inside grace period, no data lost). The worst case is purely passive — up to ~25 seconds of stale display data, then `onSubscriptionRequired` fires and the client gets current state.

---

## Two-Scope Model

NebulaClient tracks two distinct scopes:

1. **Auth scope** — the `universeGalaxyStarId` the user authenticated against. Determines the refresh cookie path and the JWT issuer. A universe admin authenticates against `george-solopreneur` and gets a JWT with `access.id: "george-solopreneur.*"`.

2. **Active scope** — the specific DO instance the client is connected to via WebSocket. That same universe admin might be interacting with `george-solopreneur.app.tenant-a` (a star-level DO).

The JWT's wildcard matching lets one auth scope cover many active scopes. The client needs both: the auth scope for `POST {prefix}/{authScope}/refresh-token` (path-scoped cookie), and the active scope for the WebSocket connection URL.

### How NebulaClient knows its scopes

**Auth scope** is determined during the login flow: the user picks a scope from the discovery list, authenticates against it, and the client stores that `universeGalaxyStarId` for refresh calls.

**Active scope** comes from the URL. Nebula's routing encodes the active scope in the URL path (e.g., `https://app.example.com/george-solopreneur/app/tenant-a/dashboard`). NebulaClient parses it automatically — the vibe coder never sets it manually.

### When auth scope ≠ active scope

This happens for admins. A universe admin's auth scope is `george-solopreneur` but they might navigate between stars: `george-solopreneur.app.tenant-a`, `george-solopreneur.app.tenant-b`, etc. The same JWT (with wildcard `george-solopreneur.*`) is valid for all of them. The client switches active scope without re-authenticating — it just opens a new WebSocket to a different DO.

For regular users (non-admins, no wildcard), auth scope and active scope are always the same — they authenticated against the exact star they're using.

### Scope switching

When the active scope changes (e.g., admin navigates to a different star):
1. Disconnect from current DO (or keep the connection if multi-tab)
2. Open WebSocket to new DO using the same JWT
3. No new refresh needed — the existing JWT's wildcard covers the new scope
4. `onSubscriptionRequired` fires on the new connection to set up subscriptions

---

## Validation Plan

### Test: Coach Carol Multi-Tab with Dual Scopes

Using `browser.context(origin)` to simulate separate tabs, each running a NebulaClient instance:

1. **Tab 1** — `browser.context('https://app.example.com')`, NebulaClient connected to `acme.crm.acme-corp`
2. **Tab 2** — `browser.context('https://app.example.com')` (same origin, shared cookie jar), NebulaClient connected to `bigco.hr.bigco-hq`
3. Verify both tabs share the same cookie jar (path-scoped refresh cookies coexist)
4. Verify each NebulaClient refreshes against its own auth scope's endpoint and only the path-matched cookie is sent
5. Verify access tokens are independent per tab (in-memory, not shared)
6. Verify each tab's WebSocket connects to the correct DO instance (active scope)
7. Verify downstream updates arrive only on the correct tab's connection

### Test: Admin Scope Switching

Single tab, universe admin navigating between stars:

1. Login at universe level (`george-solopreneur`) — get wildcard JWT `george-solopreneur.*`
2. Connect WebSocket to `george-solopreneur.app.tenant-a` — verify `onSubscriptionRequired` fires
3. Navigate to `george-solopreneur.app.tenant-b` — NebulaClient disconnects from tenant-a, opens WebSocket to tenant-b using the same JWT
4. Verify no refresh call was made (JWT still valid)
5. Verify `onSubscriptionRequired` fires on the new connection

---

## Open Questions

- **Auto-select single scope** — Should the UI auto-select if discovery returns exactly one scope, or always show the picker? Leaning toward auto-select with a brief flash showing the scope name so the user isn't confused about where they ended up.
- **Turnstile pre-solving** — Confirm that Turnstile tokens remain valid long enough to cover the discover → pick → refresh-fail → magic-link sequence. Turnstile tokens are valid for 300 seconds (5 minutes), which should be sufficient.
- **Redirect after magic link** — The magic link lands on `GET {prefix}/{id}/magic-link?one_time_token=...` which sets the refresh cookie and redirects. nebula-auth hardcodes `/app` for now. Real URL structure will emerge during full Nebula e2e testing.

---

## Related

- `tasks/nebula-auth.md` — Server-side auth architecture (endpoints, DOs, registry)
- `tasks/nebula.md` — Overall Nebula platform architecture
