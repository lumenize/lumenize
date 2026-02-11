---
title: "Passwordless Auth for Cloudflare Workers — No External Service Required"
slug: lumenize-auth-standalone
authors: [larry]
tags: [auth, announcement]
draft: true
description: "@lumenize/auth brings passwordless magic-link authentication to any Cloudflare Workers project — no Auth0, no Clerk, no external auth service. Just a Durable Object and Ed25519 keys."
---

If you're building on Cloudflare Workers and Durable Objects, you've probably wired up auth at least once — JWT validation, token refresh, key rotation, permission checking. It's not glamorous work, and bolting on an external auth service (Auth0, Clerk, Supabase Auth) means another dependency, another bill, another point of failure, and latency from round-trips to someone else's infrastructure.

**`@lumenize/auth`** is a different approach: passwordless authentication that runs entirely inside your Cloudflare Worker. No external service. No SDK. Just a Durable Object that handles magic-link login, JWT signing, refresh token rotation, and access control — all at the edge.

<!-- truncate -->

## Why another auth library?

Because the existing options for Workers are either too heavy or too light:

- **External auth services** add latency, cost, and a dependency on infrastructure you don't control. Your Workers are at the edge; your auth shouldn't be in `us-east-1`.
- **Rolling your own** means re-solving key rotation, refresh token revocation, admin approval flows, and WebSocket auth every time.

`@lumenize/auth` sits in between. It's a single Durable Object (`LumenizeAuth`) that stores subjects (aka "users") in DO SQLite storage, signs Ed25519 JWTs, and exposes a handful of HTTP routes. You get [passwordless magic-link login](/docs/auth/getting-started), [two-phase access control](/docs/auth/#access-flows) (email verification + admin approval), [zero-downtime key rotation](/docs/auth/getting-started#key-rotation), [delegation via RFC 8693](/docs/auth/delegation), and [drop-in `routeDORequest` hooks](/docs/auth/getting-started#createroutedorequestauthhooks) that protect your DOs with one line of wiring.

## Works with any Workers project

`@lumenize/auth` is the default auth for [Lumenize Mesh](/blog/announcing-lumenize-mesh), but it doesn't require Mesh at all. There are two pieces to wire up: auth endpoints (magic link, token refresh, invites) and JWT verification on your protected routes.

```bash
npm install @lumenize/auth
```

[`createAuthRoutes`](/docs/auth/getting-started#createauthroutes) handles the first piece — it returns a handler with the signature `(request: Request) => Promise<Response | undefined>`. Wire it into your `fetch` handler; it returns a `Response` for auth routes and `undefined` for everything else, so it chains naturally with whatever routing you already have. If you use [Hono](https://hono.dev), this is the same convention — drop it in and let unmatched requests fall through.

[`createRouteDORequestAuthHooks`](/docs/auth/getting-started#createroutedorequestauthhooks) handles the second piece — JWT verification, two-phase access enforcement, and per-subject rate limiting, packaged as `onBeforeRequest` and `onBeforeConnect` hooks for [`routeDORequest`](/docs/routing/route-do-request). Each hook returns `Response` (to block), `Request` (to enhance and forward), or `undefined` (to pass through) — again, the standard middleware shape that works with Hono or any fetch-based router.

If you'd rather wire the contracts into your own routing, that's straightforward too — the auth header contract is just `Authorization: Bearer {jwt}` on every request to your DOs. See [Integrating Alternative Auth](/docs/mesh/security#integrating-alternative-auth-advanced) for the exact requirements.

The [getting started guide](/docs/auth/getting-started) walks through both pieces end-to-end — key generation, Worker entry point, email provider (Resend in 5 minutes), and the optional Turnstile and rate limiting add-ons.

## What's next

If you just need auth, [start here](/docs/auth/getting-started). If you want the full mesh — where DOs, Workers, and browser clients are all equal peers with access control baked in — check out the [Lumenize Mesh announcement](/blog/announcing-lumenize-mesh).
