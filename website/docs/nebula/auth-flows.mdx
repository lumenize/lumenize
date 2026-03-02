---
title: Auth Flows
description: Login, token management, and scope switching sequences for Nebula
---

# Auth Flows

Nebula uses [nebula-auth](/docs/auth) for passwordless authentication with a two-scope model: **auth scope** (determines the refresh cookie path) and **active scope** (baked into the JWT `aud` claim). This page shows the end-to-end sequences from the UI perspective.

:::info Implementation note
Diagrams reference `NebulaClient` — the client-side class that manages connections. These annotations help during development and testing; they may be simplified before release.
:::

## First-Time Login

A new user arrives at the login page with no existing refresh cookie. The full flow is: discovery, scope selection, magic link email, and finally a connected `NebulaClient`.

```mermaid
sequenceDiagram
    participant UI as Login Page
    participant NC as NebulaClient
    participant W as Worker (entrypoint)
    participant R as Registry DO
    participant NA as NebulaAuth DO
    participant GW as Gateway DO

    rect rgba(200, 220, 240, 0.3)
        Note over UI,R: 1. Discovery — find available scopes for this email
        UI->>W: POST /auth/discover { email }
        W->>R: Forward to Registry
        R-->>W: [{ instanceName, isAdmin }, ...]
        W-->>UI: Scope list
        Note over UI: User selects a scope<br/>(e.g. "acme.app.tenant-a")
    end

    rect rgba(240, 220, 200, 0.3)
        Note over UI,NA: 2. Try refresh — optimistic check for existing cookie
        UI->>W: POST /auth/acme.app.tenant-a/refresh-token<br/>{ activeScope: "acme.app.tenant-a" }
        W->>NA: Forward to NebulaAuth
        NA-->>W: 401 (no refresh cookie)
        W-->>UI: 401
    end

    rect rgba(220, 220, 255, 0.3)
        Note over UI,NA: 3. Magic link — fall back to email login
        UI->>W: POST /auth/acme.app.tenant-a/email-magic-link<br/>{ email, cf-turnstile-response }
        W->>NA: Forward to NebulaAuth
        Note over NA: Send magic link email
        NA-->>W: { message: "Check email" }
        W-->>UI: Show "Check your email"
    end

    rect rgba(240, 220, 200, 0.3)
        Note over UI,NA: 4. Click magic link — browser navigates to link in email
        UI->>W: GET /auth/acme.app.tenant-a/magic-link?one_time_token=...
        W->>NA: Validate token, set emailVerified
        NA-->>W: Set-Cookie (path-scoped refresh token) + 302
        W-->>UI: Redirect to app
    end

    rect rgba(200, 240, 200, 0.3)
        Note over UI,GW: 5. Get access token and connect
        UI->>W: POST /auth/acme.app.tenant-a/refresh-token<br/>{ activeScope: "acme.app.tenant-a" }
        W->>NA: Cookie matches path → valid refresh token
        NA-->>W: { access_token } (aud: "acme.app.tenant-a")
        W-->>UI: Access token (stored in memory)
        Note over NC: NebulaClient created with access token
        NC->>W: WebSocket upgrade (token in subprotocol)
        W->>W: onBeforeConnect: verify JWT signature + aud
        W->>GW: Forward to Gateway
        Note over GW: onBeforeAccept: extract aud → universeGalaxyStarId
        GW-->>NC: WebSocket connected
        Note over NC: Ready — lmz.call() works
    end
```

## Returning User

A user with a valid refresh cookie (not expired, not revoked) returns to the app. The cookie is `HttpOnly`, so the client can't check for it — it makes the refresh call and lets the browser send the cookie if the path matches.

```mermaid
sequenceDiagram
    participant UI as Login Page
    participant NC as NebulaClient
    participant W as Worker (entrypoint)
    participant R as Registry DO
    participant NA as NebulaAuth DO
    participant GW as Gateway DO

    rect rgba(200, 220, 240, 0.3)
        Note over UI,R: 1. Discovery
        UI->>W: POST /auth/discover { email }
        W->>R: Forward to Registry
        R-->>W: [{ instanceName, isAdmin }, ...]
        W-->>UI: Scope list
        Note over UI: User selects scope
    end

    rect rgba(200, 240, 200, 0.3)
        Note over UI,GW: 2. Refresh succeeds — cookie exists and path matches
        UI->>W: POST /auth/acme.app.tenant-a/refresh-token<br/>{ activeScope: "acme.app.tenant-a" }
        W->>NA: Cookie sent by browser (path match)
        NA-->>W: { access_token } (aud: "acme.app.tenant-a")
        W-->>UI: Access token (stored in memory)
        Note over NC: NebulaClient created with access token
        NC->>W: WebSocket upgrade (token in subprotocol)
        W->>W: onBeforeConnect: verify JWT signature + aud
        W->>GW: Forward to Gateway
        GW-->>NC: WebSocket connected
        Note over NC: Ready — lmz.call() works
    end
```

:::tip Bookmarked URLs
If the user arrives via a bookmarked URL that encodes the scope (e.g. `https://app.example.com/acme/app/tenant-a/dashboard`), the client already knows the active scope. It can skip discovery and try refresh directly, falling back to the full login flow only if refresh fails.
:::

## Scope Switching

An admin (or any user with access to multiple scopes) wants to switch from one star to another. Scope switching is a **full re-login, not an in-place reconnect** — the old `NebulaClient` is destroyed and a new one is created.

The key insight: `NebulaClient` is ephemeral; the refresh cookie is the durable credential. Each access token has a single `aud` (active scope), so switching scope requires a new token.

```mermaid
sequenceDiagram
    participant UI as Login Page
    participant NC1 as NebulaClient (old)
    participant NC2 as NebulaClient (new)
    participant W as Worker (entrypoint)
    participant R as Registry DO
    participant NA as NebulaAuth DO
    participant GW as Gateway DO

    Note over NC1: Currently connected to<br/>acme.app.tenant-a<br/>(aud: "acme.app.tenant-a")

    rect rgba(200, 220, 240, 0.3)
        Note over UI,R: 1. User navigates to login page and runs discovery
        UI->>W: POST /auth/discover { email }
        W->>R: Forward to Registry
        R-->>W: [{ instanceName, isAdmin }, ...]
        W-->>UI: Scope list
        Note over UI: User selects "acme.app.tenant-b"<br/>(can back out here — old client stays alive)
    end

    rect rgba(240, 220, 200, 0.3)
        Note over UI,NA: 2. Login flow for new scope
        UI->>W: POST /auth/acme.app.tenant-b/refresh-token<br/>{ activeScope: "acme.app.tenant-b" }
        W->>NA: Cookie sent by browser (path match)
        NA-->>W: { access_token } (aud: "acme.app.tenant-b")
        W-->>UI: New access token
    end

    rect rgba(255, 220, 220, 0.3)
        Note over UI,NC1: 3. Destroy old client
        UI->>NC1: destroy()
        Note over NC1: WebSocket closed, state discarded
    end

    rect rgba(200, 240, 200, 0.3)
        Note over UI,GW: 4. Create new client and connect
        Note over NC2: NebulaClient created with new access token
        NC2->>W: WebSocket upgrade (new token in subprotocol)
        W->>W: onBeforeConnect: verify JWT (aud: "acme.app.tenant-b")
        W->>GW: Forward to new Gateway instance
        GW-->>NC2: WebSocket connected
        Note over NC2: onSubscriptionRequired fires<br/>→ set up subscriptions for tenant-b
    end
```

:::note When refresh fails
If the refresh call returns 401 (cookie expired or doesn't exist for the new scope's path), the flow falls back to magic link — same as the [first-time login](#first-time-login) flow starting at step 3. The old client stays alive until the magic link completes.
:::

## Security Layers During Connection

Every `NebulaClient` connection passes through four security layers before any `lmz.call()` reaches a Nebula DO. This diagram shows what happens at each layer for a single connection attempt.

```mermaid
sequenceDiagram
    participant C as NebulaClient
    participant EP as Entrypoint<br/>(onBeforeConnect)
    participant GW as NebulaClientGateway<br/>(onBeforeAccept)
    participant DO as NebulaDO<br/>(onBeforeCall)
    participant M as @mesh(guard)<br/>(e.g. requireAdmin)

    rect rgba(200, 220, 240, 0.3)
        Note over C,EP: Layer 1 — Entrypoint JWT verification
        C->>EP: WebSocket upgrade<br/>(JWT in subprotocol)
        Note over EP: extractWebSocketToken(request)<br/>verifyJwt(token, publicKey)<br/>matchAccess(authScopePattern, aud)
        alt Invalid JWT or scope mismatch
            EP-->>C: 401/403 (no DO instantiated)
        end
    end

    rect rgba(220, 220, 255, 0.3)
        Note over EP,GW: Layer 2 — Gateway star-scoping
        EP->>GW: Forward WebSocket
        Note over GW: onBeforeAccept:<br/>read aud → universeGalaxyStarId<br/>store in GatewayConnectionInfo.claims
        GW-->>C: WebSocket accepted
    end

    Note over C: Connection established. Now lmz.call() happens:

    rect rgba(240, 220, 200, 0.3)
        Note over C,DO: Layer 3 — NebulaDO starId binding
        C->>GW: lmz.call(orgDO, 'addToAllowlist', sub)
        Note over GW: onBeforeCallToMesh:<br/>stamp universeGalaxyStarId onto callContext
        GW->>DO: RPC with NebulaCallContext
        Note over DO: onBeforeCall:<br/>first call → store starId<br/>subsequent → verify starId match
        alt StarId mismatch
            DO-->>GW: Error: Star scope mismatch
            GW-->>C: Error propagated
        end
    end

    rect rgba(200, 240, 200, 0.3)
        Note over DO,M: Layer 4 — Method-level guard
        Note over M: requireAdmin(instance):<br/>check originAuth.claims.access.admin
        alt Guard rejects
            M-->>DO: Error: Admin access required
            DO-->>GW: Error propagated
            GW-->>C: Error propagated
        else Guard passes
            Note over DO: Execute method
            DO-->>GW: Result
            GW-->>C: Result
        end
    end
```

## Multi-Tab (Coach Carol Scenario)

Coach Carol manages multiple client organizations. She opens each in a separate browser tab. Path-scoped refresh cookies let tabs coexist without interfering.

```mermaid
sequenceDiagram
    participant T1 as Tab 1<br/>(acme.crm.acme-corp)
    participant T2 as Tab 2<br/>(bigco.hr.bigco-hq)
    participant W as Worker
    participant NA1 as NebulaAuth<br/>(acme.crm.acme-corp)
    participant NA2 as NebulaAuth<br/>(bigco.hr.bigco-hq)

    rect rgba(200, 220, 240, 0.3)
        Note over T1,NA1: Tab 1 — login to acme.crm.acme-corp
        T1->>W: POST /auth/acme.crm.acme-corp/refresh-token<br/>{ activeScope: "acme.crm.acme-corp" }
        Note over W: Browser sends cookie scoped to<br/>/auth/acme.crm.acme-corp
        W->>NA1: Forward
        NA1-->>W: { access_token } (aud: "acme.crm.acme-corp")
        W-->>T1: Access token → NebulaClient connects
    end

    rect rgba(220, 220, 255, 0.3)
        Note over T2,NA2: Tab 2 — login to bigco.hr.bigco-hq
        T2->>W: POST /auth/bigco.hr.bigco-hq/refresh-token<br/>{ activeScope: "bigco.hr.bigco-hq" }
        Note over W: Browser sends cookie scoped to<br/>/auth/bigco.hr.bigco-hq
        W->>NA2: Forward
        NA2-->>W: { access_token } (aud: "bigco.hr.bigco-hq")
        W-->>T2: Access token → NebulaClient connects
    end

    Note over T1,T2: Both tabs active simultaneously.<br/>Each has its own access token (in memory),<br/>own WebSocket, own Gateway instance.<br/>Path-scoped cookies don't interfere.
```

Key properties:
- **Shared cookie jar** — both tabs are same-origin, so refresh cookies coexist (different paths)
- **Independent access tokens** — stored in memory per tab, not shared
- **Independent WebSockets** — each `NebulaClient` has its own Gateway connection
- **No cross-talk** — updates arrive only on the correct tab's connection
