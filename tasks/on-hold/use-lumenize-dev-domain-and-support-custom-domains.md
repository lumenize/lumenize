# Use `lumenize.dev` for hosted apps + support customer custom domains

**Status**: design captured 2026-06-27 (with Larry). **Phase 0 (outbound-URL discipline) DONE 2026-06-27**; the rest is on-hold. Supersedes two backlog items (preview-origin-isolation + Universe-level custom domains), folded in here. No immediate driver — pre-alpha runs everything on `nebula.lumenize.com` and that's fine for now. Pick up the rest when (a) we're about to host untrusted multi-tenant apps, or (b) a customer asks for their own domain, or (c) the `createNebulaClient` `authScope` URL auto-detect (backlog) needs the deployment-URL scheme pinned.

## Objective

Move **rendered user-developer apps** (preview/dev + production) off the platform's own registrable domain onto a **separate registrable domain, `lumenize.dev`** (registered 2026-06-27), and support **customer-brought custom domains** at the Galaxy level. All of it is **pure edge translation**: the canonical identity `{u}.{g}.{s}` — DO `idFromName`, JWT `aud`, mesh address, cookie scope — **never changes**; only the host↔scope presentation does.

## Why a separate registrable domain (the core rationale — not cosmetics)

Hosting untrusted, LLM-generated app code on `*.nebula.lumenize.com` shares the registrable domain `lumenize.com` with the Studio + auth. A hostile/buggy generated app can set `Domain=lumenize.com` and toss cookies at the Studio (the cookie-tossing caveat the old backlog item flagged but couldn't cleanly solve). A **separate registrable domain** kills it at the root — this is exactly why Cloudflare uses `workers.dev`, GitHub `github.io`, Vercel `vercel.app`:

- **Cross-site isolation for free.** `lumenize.dev` and `lumenize.com` are different eTLD+1 → the browser isolates them. An app on `lumenize.dev` simply cannot reach `lumenize.com` cookies/storage.
- **`.dev` is HSTS-preloaded** — browsers force HTTPS on the whole TLD, no downgrade.
- **Public Suffix List (PSL).** Submit `lumenize.dev` to the PSL (the `*.workers.dev` pattern) so even *sibling* tenant apps can't cookie-toss each other. This is the gold-standard multi-tenant isolation; do it before hosting other people's apps.

**Framing:** `nebula.lumenize.com` = **trusted control plane** (Studio, auth, gateway-for-Studio). `lumenize.dev` = **untrusted data plane** (rendered apps + the API calls they make). For a secure-by-default platform running untrusted code, this is the correct architecture, not a nicety.

## Addressing & edge translation (canonical identity unchanged)

Canonical scope stays `{u}.{g}.{s}` (dots, 1–3 segments; `parse-id.ts`). DNS reads small→big, so the host reverses it. Worked examples (all reconstruct the same canonical `acme.crm.tenant1`):

```
today:    https://nebula.lumenize.com/gateway/STAR/acme.crm.tenant1/...
default:  https://crm.acme.lumenize.dev/gateway/STAR/tenant1/...   host {g}.{u}=crm.acme + path {s}=tenant1
custom:   https://app.acme.com/gateway/STAR/tenant1/...            registry host→{u,g} + path {s}=tenant1
```

The host carries what it can ({u},{g}); the path carries the remainder ({s}); the Worker entrypoint rejoins to canonical and dispatches exactly as today. Nothing downstream of the entrypoint changes. (No host-based routing exists today — `entrypoint.ts` is path-only — so this is net-new edge logic, not a rewrite.)

## Refresh-cookie model — RESOLVED, no cookie-code change needed

The existing cookie (`nebula-auth.ts:1424` `#createRefreshTokenCookie`) is already the secure, host-portable shape:

```js
`refresh-token=${token}; Path=${prefix}/${instanceName}; HttpOnly; Secure; SameSite=Strict; Max-Age=...`
//                       e.g. /auth/acme.crm.tenant1  ← authScope IS the path
```

- **No `Domain` attribute → host-only.** Sent back only to the exact host that set it. So each host (`app.acme.lumenize.dev`, `app.com`, `nebula.lumenize.com`) gets an independent refresh-cookie namespace, automatically. **This is the primary isolation, and it already exists.**
- **`Path = /auth/{instanceName}` → the authScope defines the path.** A Star-level user's scope `acme.crm.tenant1` becomes the cookie path → isolates stars that **share** a host (secondary layer).
- **`SameSite=Strict`** → can't be exfiltrated/replayed cross-site; also means the refresh `POST` must be **same-site** as the app → auth must be **co-located on the app's own host** (Option X), not centralized on `nebula.lumenize.com`. The same Worker serves all hosts, so it sets the host-only cookie on whichever host served `/auth/...`. No change required.

Two layers compose:

| Boundary | Isolated by |
|---|---|
| Across hosts — galaxies, custom domains, platform vs app | host-only (no `Domain`) + `SameSite=Strict` |
| Across stars **within** one host (only relevant under Fork B = star-in-path) | `Path` = authScope |

**Custom-domain switch behaves correctly and by design** (`app.acme.lumenize.dev` → `app.com`):
- **Re-login required** — host-only + Strict means the cookie can't travel to `app.com`. *Forced by the security model, not a bug.* Do **not** build cross-domain SSO to avoid it — a custom-domain switch is a rare, deliberate admin act; one re-login is cheaper than the cross-site coupling SSO reintroduces.
- **Data persists** — keyed by canonical `acme.crm.tenant1` in the DO, host-independent.
- **Both hosts stay live, same data** — automatic from canonical identity; mirrors the existing `workers_dev: true` kept alongside the custom domain in `apps/nebula/wrangler.jsonc`.

## ⚠️ THE central risk — host-aware outbound URLs (silent failure mode)

The refresh cookie lands on **whatever host served the magic-link verification**. So **every** user-facing URL we mint — the magic-link URL *and* the post-login redirect (`this.#redirect`) — must echo the host the login *began on* (`app.com` / `crm.acme.lumenize.dev` / `nebula.lumenize.com`), never a hardcoded platform host. If a magic link initiated on `app.com` points at `nebula.lumenize.com`, the cookie lands on the wrong host and the app never sees it.

**Why this is the trickiest part (Larry, 2026-06-27):** miss it in *one* place and the failure is **silent** — the user just has to log in twice. Most people won't notice URLs, will assume double-login is normal, and **won't report it** (they self-resolve by re-logging in). So we can't rely on bug reports to catch a missed site.

**Mitigation = make it structurally un-missable, not vigilance:**
- **Single source of truth** for "what public host did this request arrive on" — derive it once at the entrypoint (from `Host`/the host→scope map) and thread it; never let any handler hardcode a host.
- **Outbound-URL audit** — enumerate every site that emits a user-facing absolute URL (magic-link build, `#redirect`, any email link, any redirect) and route all through the one helper.
- **Capable-of-failing test** — assert the magic-link host **echoes the inbound host** across all three host shapes (platform / `lumenize.dev` / custom). A test that would actually go red if a handler reverted to a fixed host.

### Phase 0 — outbound-URL discipline (DONE 2026-06-27)

Done early and independently of the rest, because the cost is asymmetric: cheap now (few minting sites), expensive later (a hardcoded host could spread across new auth/email/redirect sites and fail silently). **Audit-on-implementation finding: the surface is *already* host-aware**, so Phase 0 *locks it in* rather than fixes it:
- **Magic-link URL** — already derived from `url.origin` (`nebula-auth.ts:248`, `#handleEmailMagicLink`). ✅
- **Post-login redirect** — `NEBULA_AUTH_REDIRECT` is the **relative path** `/app`, emitted as `Location: /app/{scope}` (`nebula-auth.ts:362`), so the browser resolves it against the inbound host → host-following. ✅ (No flip needed — the "hardcoded host" worry was unfounded; it was never absolute.)
- **JWT issuer** — `NEBULA_AUTH_ISSUER = https://nebula.lumenize.com` is correctly **fixed** (it's an identity claim, not a routed URL); the inverse trap is a future "make hosts dynamic" sweep wrongly touching it.

**Shipped:** a capable-of-failing guard — `describe('Outbound URL host-awareness (Phase 0 guard)')` in `packages/nebula-auth/test/nebula-auth-routes.test.ts` — three `it`s: (1) magic-link URL echoes the inbound host across two host shapes + no issuer-host leak; (2) post-login redirect stays relative/host-following; (3) JWT issuer stays canonical even on a custom host. **Mutation-verified**: changing `baseUrl = url.origin` → `NEBULA_AUTH_ISSUER` turns guard (1) red. This is the durable insurance that lets the rest stay deferred without the debt compounding — a future hardcoded host fails CI.

## Open forks (don't silently resolve — decide before building)

**Fork A — host encoding / TLS cost.**
- Dotted `{g}.{u}.lumenize.dev` is a **two-deep wildcard** → free Universal SSL (`*.lumenize.dev`, one level) does NOT cover it → needs ACM (~$10/mo) or a per-universe cert provisioned on universe-claim (a moving part).
- Flat single label `acme--crm.lumenize.dev` IS covered by free `*.lumenize.dev` Universal SSL, zero per-universe provisioning. `--` is collision-proof because slugs can't contain consecutive hyphens (`parse-id.ts:13`).
- **Lean: flat for the default host** (users bring a custom domain when looks matter). Reconsider only if the dotted hierarchy is worth the cost + cert-provisioning step.

**Fork B — where does `{s}` live: path or host?**
- Star-in-**path** (`crm.acme.lumenize.dev/.../{s}/`): stars of one galaxy share an **origin** → shared localStorage/IndexedDB/cookies → **not** browser-isolated between stars. Fine if a production Galaxy has one live Star (multi-star = dev/staging or in-app data partitioning).
- Star-in-**host** (`tenant1.crm.acme.lumenize.dev` or flat `acme--crm--tenant1.lumenize.dev`, path carries no scope): every star is its own origin → real isolation. Needed if Stars are per-end-customer silos that must be isolated in the browser.
- **Decider: the real multiplicity of Stars per Galaxy in production.** Open. (Note: star-in-host makes the cookie `Path` layer redundant-but-harmless; star-in-path keeps it earning its keep.)

## Custom domains — Galaxy-level (shifted from the old Universe-level plan)

Customers will want their own domain for an **app** (`app.acme.com` → one product = one Galaxy), not their whole org → **Galaxy** is the natural v1 level (the old backlog item said Universe; Galaxy is the better default). The mechanism is identical at either granularity, so Universe-level can be added later.

- **Mechanism:** Cloudflare for SaaS / Custom Hostnames (SSL for SaaS). Customer CNAMEs `app.acme.com` at the zone; CF validates + auto-provisions the cert; the Worker just sees `Host: app.acme.com`.
- **Storage:** a `host → {u,g}` map in the registry, next to the instance/email data.
- **Ownership, both halves:** only honor `app.acme.com → acme.crm` after proving the requester both **controls the domain** (CF-for-SaaS hostname validation) AND **admins the Galaxy**.
- **Bonus:** on a custom domain, login discovery is free — the host *is* the galaxy → skip the email→workspace lookup.
- **Cost note to verify:** CF-for-SaaS Custom Hostnames are billed per active hostname at scale — fine early, model it before mass adoption.

## Preview origin-isolation consequence (folded in from the removed backlog item)

Once previews are origin-isolated on `lumenize.dev`, the Studio "Wipe"/"Reset data" should also **clear that isolated origin's client storage** (localStorage/cookies/IndexedDB) + reload — generated apps legitimately use client storage, and on a shared origin we couldn't blindly `localStorage.clear()` (it would nuke the Studio's own `nebula.authScope`). Origin isolation makes the clean wipe possible. **Pairs with** the still-open backlog items it used to live next to: *breaking-ontology → Reset-data/Revert prompt* and *clear app source / true fresh-start* (both remain in `tasks/backlog.md`, unrelated to domains otherwise).

## Touch points (file:line, for when this is picked up)

- `packages/nebula-auth/src/nebula-auth.ts:1424` — `#createRefreshTokenCookie` (already host-portable; verify no change needed).
- `packages/nebula-auth/src/nebula-auth.ts:248` (magic-link `url.origin`) + `:362` (`Location: /app/{scope}`, relative) — **already host-aware** (Phase 0 audit); guarded by the Phase-0 test. Keep new minting sites going through the same host-derived pattern.
- `apps/nebula/src/entrypoint.ts` — add Host→scope translation at the edge (currently path-only); derive the canonical scope + the originating public host once here.
- `packages/nebula-auth/src/parse-id.ts` — canonical scope parse/format + slug rules (`--` collision-proofness; auth-scope patterns Star/Galaxy/Universe/`*`).
- `apps/nebula/wrangler.jsonc` — routes: keep the exact `nebula.lumenize.com` custom domain; add the `lumenize.dev` wildcard route(s); CF-for-SaaS custom-hostname config.

## Verify against live CF docs when building

- Whether **proxied wildcard DNS** records need a Business-tier plan.
- Current **ACM** pricing (only relevant if Fork A goes dotted).
- **CF-for-SaaS Custom Hostname** pricing/quota at scale.

## What this unblocks

- `createNebulaClient` `authScope` URL auto-detect (backlog) — waits on this deployment-URL scheme.
- `client.logout()` cookie-clear is already path-scoped and host-portable, so it rides along unchanged.

## Provenance

Design discussions: session `5679b512` (2026-06-26, 23:02–23:16 — wildcard/vanity-domain detour) and `fbacc3ed` (2026-06-27, email-from/`lumenize.io` thread). Refresh-cookie resolution + `lumenize.dev` reframing + host-aware-URL risk: this session (2026-06-27). Replaces backlog items "Studio: isolate the preview's origin" and "Nebula: Universe-level custom domains" (removed 2026-06-27).
