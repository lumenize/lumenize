# ADR-021: Every Scope Has Its Own Host on `lumenize.dev`

**Date**: 2026-09-14
**Status**: Proposed — pending Larry's read
**Deciders**: Larry
**Evidence**: [`tasks/domain-allocation.md`](../../tasks/domain-allocation.md) — the three zones as measured on 2026-09-11, alternatives A, B and C, and an experiment on `lumenize.dev` the same day: two-level wildcards accepted, domain validation automatic at every depth, at least 20 certificate packs on a Free zone with no refusal, and three to four minutes from order to active. The Public Suffix List's own guidelines, which say a project not yet serving thousands of users is likely to be declined.

## Context

Lumenize owns three domains — `lumenize.com`, `lumenize.io` and `lumenize.dev` — and what each one is for accreted a task at a time. One host served everything user-facing, with the scope in the path.

Two things push against one host:

1. **A browser isolates by origin** — `https://` plus a host, such as `https://crm.acme.lumenize.dev`. Studio, the apps it generates, and each persona a user-developer tests as all need cookies and storage the others cannot touch. So each needs a host of its own.
2. **The outside world fixes the shapes a host can take.**
   - Google put all of `.dev` on the browsers' HSTS preload list, so every `lumenize.dev` host is HTTPS-only. A broken certificate is a dead page, not a warning.
   - A wildcard certificate matches exactly one label: `*.lumenize.dev` covers `acme.lumenize.dev` and not `crm.acme.lumenize.dev`.
   - A DNS label holds 63 characters. The only characters legal in both a label and an email local part are `a-z`, `0-9` and `-`.

The rest of this ADR says what each domain is for, how a host spells a scope, and what that spelling costs in certificates.

> **Today's code differs.** None of this is built. `lumenize.dev` has no DNS records, and every scope is served from `nebula.lumenize.com` with the scope in the path. The preview runs generated code on Studio's own origin, and the platform scope is named `nebula-platform`. `isValidSlug` has no length cap, no persona slug check exists, and the reserved slug sets still assume a scope is a path segment. [`tasks/domain-allocation.md`](../../tasks/domain-allocation.md) § *What changes in today's code* lists the sites.

## Decision

### What each domain is for

- **`lumenize.dev` is everything a user-developer or their users see.** The apex is a landing page for user-developers. `platform.lumenize.dev` serves login, the magic-link consume, Home, and superusers, who are members of the `platform` scope. Every universe, galaxy, Star and persona has a host beneath it.
- **`lumenize.com` is the brand and human mail.** Its apex mail belongs to Google Workspace, and its apex site is today's docs and blog, whose inbound links cannot be edited. At beta it is expected to become the product's marketing site — a direction, not a commitment made here.
- **`lumenize.io` is inbound mail.** Its catch-all carries the `/live` harness's real login round trips, and `personas.lumenize.io` is reserved for persona addresses. The package docs are expected to move here at beta.
- **There is no fourth domain.** "Nebula" is a code name, so it appears in no hostname, and `nebula.lumenize.com` retires.

### How a host spells a scope

**One label per scope tier, read right to left, with a persona joined to its Star's label by `--`:**

```
acme.lumenize.dev                  universe
crm.acme.lumenize.dev              galaxy — serves Studio
dev.crm.acme.lumenize.dev          the galaxy's dev Star
tenant1.crm.acme.lumenize.dev      a tenant Star
manny--dev.crm.acme.lumenize.dev   persona manny, in the dev Star
```

These things follow:

- **The host is the scope.** `tenant1.crm.acme.lumenize.dev` is `acme.crm.tenant1`, so the server derives the scope from the host. The first label splits on `--`: one part is a Star, two parts are a persona and its Star.
- **`--` can only ever be a join**, because `isValidSlug` refuses a doubled hyphen inside a slug.
- **Every slug is at most 30 characters, and a persona slug at least 3.** A persona and a Star share one 63-character label, and 30 + 2 + 30 fits; `warehouse-management-system` is 27. The floor exists because a label with `--` as its third and fourth characters is reserved for punycode names such as `xn--bcher-kva`, and certificate authorities refuse to name one. So `ed--dev` would be refused wherever a host gets a certificate of its own.
- **Environments are reserved Star slugs, never labels.** `dev`, `staging`, `prod`, `test`, `preview`, `sandbox`, `qa` and `demo` are reserved in every galaxy. Reserve generously: releasing a name later is free, and reclaiming one a customer holds is a migration.
- **Platform labels are reserved universe slugs.** `platform.lumenize.dev` looks exactly like a universe named `platform`, so `platform`, `email`, `www` and every later platform label are refused as universe slugs.

### What certificates may cost

**The certificate set must never grow with tenants or personas.** A tenant per customer and a cast of eight are created in seconds and in bulk, and a certificate order for each would put a wait of minutes on every one. The grammar above holds because a certificate counts dots, not characters: a Star or a persona is a value inside a label an existing wildcard already covers.

**It does grow with universes and galaxies, and that is accepted.** Creating either orders one wildcard — `*.acme.lumenize.dev`, `*.crm.acme.lumenize.dev` — and the hosts beneath it answer only once that certificate is active. So creating a universe or a galaxy is asynchronous, and the pages that create them show the wait.

Today's mechanism is Cloudflare's Advanced Certificate Manager for those wildcards, with Cloudflare for SaaS custom hostnames past its per-zone ceiling and for a customer's own domain. Both serve the same host names, so moving between them is not a URL migration.

### Nothing depends on the Public Suffix List

Every `lumenize.dev` host is a sibling under one registrable domain until a Public Suffix List entry makes each universe its own. The list declines projects that do not yet serve thousands of users. So **nothing we build may depend on the entry**: our cookies are safe without it ([ADR-022](022-each-host-holds-its-own-session.md)), and the entry is submitted once Lumenize qualifies.

## Alternatives considered

- **A — one flat label per scope,** `acme--crm--tenant1.lumenize.dev`, with an environment as its own label. One free wildcard covers every host, and nothing waits on a certificate. Rejected on characters: three slugs share 63, so each caps at 19, and `northwind-traders-intl` at 22 does not fit.
- **B — a label per galaxy,** `tenant1.acme--crm.lumenize.dev`. It buys the characters back and costs the same per-galaxy wait. Rejected because it spells a galaxy one way and a Star another (Larry, 2026-09-11).
- **A persona as its own label,** `manny.dev.crm.acme.lumenize.dev`. It needs a wildcard per Star, so the certificate set grows with tenants.
- **An environment as its own label,** such as `crm.acme.dev.lumenize.dev`. A Star slug already carries the environment for nothing, and a label would stop the host being a direct spelling of the scope.
- **Cloudflare for SaaS for every host from the start.** It has a documented ceiling, but a certificate per host puts issuance on every tenant and persona created, and its cost grows per host rather than per zone. Kept for the margin.
- **A pre-issued pool of certificates, to erase the wait.** Validation took about as long for twenty certificates as for one, so a pool would amortise well. Not built now: a progress indicator answers the wait until signups show it hurts (Larry, 2026-09-11).
- **Studio and auth on a registrable domain of their own,** as `nebula.lumenize.com` is today. It keeps generated apps' cookies away from Studio by construction. Rejected because the galaxy's host is where the app lives, so it serves Studio to the people building the app (Larry, 2026-09-11), and `__Host-` cookie names answer the cookie threat a second domain answered.
- **A fourth domain.** Ruled out (Larry, 2026-09-11).

## Consequences

### Positive

- **A link names the scope it opens.** The host alone says universe, galaxy and Star, which is what [ADR-017](017-the-url-is-the-view-state.md) needs from a shared link.
- **Every Star and persona is its own origin**, with its own cookies and storage, so the browser keeps tenants and persona tabs apart without our code doing it.
- **Tenants, personas and environments cost no certificates**, and one 30-character rule covers every slug.

### Negative / mitigations

- **Creating a universe or a galaxy waits three to four minutes.** A progress indicator on the create pages shows it, and a pre-issued pool stays available.
- **Certificate lifecycle becomes ours.** A deleted galaxy leaves its wildcard behind, and certificate deletes can stall and fail transiently, so reaping retries and reconciles rather than firing once.
- **The per-zone wildcard ceiling is unpublished below Enterprise.** Past it, new galaxies get their certificates through Cloudflare for SaaS under the same names.
- **Moving between scopes is cross-origin.** Clicking from Studio into `tenant1` and then `tenant2` establishes a session on each ([ADR-022](022-each-host-holds-its-own-session.md)).

### Deliberately open

- **Customer custom domains**, Beta at the soonest.
- **Whether persona addresses receive mail.** [`tasks/nebula-persona-sessions.md`](../../tasks/nebula-persona-sessions.md) § *Open questions* decides it, and `personas.lumenize.io` can go either way.
- **Mail enforcement.** DMARC on `lumenize.com` stays at `p=none` until one posture is set across all three zones.
