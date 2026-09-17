# ADR-021: Every Scope Has Its Own Host on `lumenize.dev`

**Date**: 2026-09-14
**Status**: Proposed — line-by-line review with Larry, 2026-09-14
**Deciders**: Larry
**Evidence**: [the domain-allocation record](../../tasks/archive/decision-domain-allocation.md) — the three zones as measured on 2026-09-11, alternatives A, B and C, and an experiment on `lumenize.dev` the same day: two-level wildcards accepted, domain validation automatic at every depth, and three to four minutes from order to active. [A 2026-09-14 run](../../experiments/wildcard-host-routing/RESULTS.md) served every depth from one DNS record and one route. The Public Suffix List's guidelines, which decline projects not yet serving thousands of users.

## Context

Lumenize owns three domains — `lumenize.com`, `lumenize.io` and `lumenize.dev` — and what each one is for accreted a task at a time. One host served everything user-facing, with the scope in the path.

Two things push against one host:

1. **A browser keeps storage apart by origin, and cookies apart by host.** An origin is `https://` plus a host, such as `https://crm.acme.lumenize.dev`, and `localStorage`, `sessionStorage` and IndexedDB each belong to one. A cookie goes back only to the host that set it, unless it carries a `Domain` attribute, which widens it to every host under that domain. [ADR-022](022-every-session-lives-on-the-platform-host.md) forbids that for our cookies and keeps all of them on `platform.lumenize.dev`, which gives each page a token for the host it runs on. Studio, the apps it generates, and each persona a user-developer tests as all need storage the others cannot touch, and tokens for their own scope alone. So each needs a host of its own.
2. **The outside world fixes the shapes a host can take.**
   - Google put all of `.dev` on the browsers' HSTS preload list, so every `lumenize.dev` host is HTTPS-only. A broken certificate is a dead page, not a warning.
   - A wildcard certificate matches exactly one label: `*.lumenize.dev` covers `acme.lumenize.dev` and not `crm.acme.lumenize.dev`.
   - A DNS label holds 63 characters. The only characters legal in both a label and an email local part are `a-z`, `0-9` and `-`.

The rest of this ADR says what each domain is for, how a host spells a scope, and what that spelling costs in certificates.

> **Today's code differs.** None of this is built. `lumenize.dev` has no DNS records, and every scope is served from `nebula.lumenize.com` with the scope in the path. The preview runs generated code on Studio's own origin, and the platform scope is named `nebula-platform`. `isValidSlug` has no length cap, no persona slug check exists, and the reserved slug sets still assume a scope is a path segment. [The domain-allocation record](../../tasks/archive/decision-domain-allocation.md) § *What changes in today's code* lists the sites.

## Decision

### What each domain is for

- **`lumenize.dev` is everything a user-developer or their users see.** The apex is a landing page for user-developers. `platform.lumenize.dev` holds every session and serves login, the magic-link consume, Home (where the user chooses what scope to work in), and superusers, who are members of the `platform` scope. Every universe, galaxy, Star and persona has a host beneath it.
- **`lumenize.com` is the brand, human mail, and the package docs.** Its apex mail belongs to Google Workspace, and its apex site is today's docs and blog, whose inbound links cannot be edited. At beta it is expected to become the product's marketing site, with the `@lumenize/*` package docs staying on it at `lumenize.com/docs` or `docs.lumenize.com` (Larry, 2026-09-14).
- **`lumenize.io` is the platform's own mail.** Nebula sends as `noreply@lumenize.io`, a Cloudflare Worker reads named inboxes such as `claude@lumenize.io`, and `personas.lumenize.io` holds persona addresses, which receive no mail ([ADR-022](022-every-session-lives-on-the-platform-host.md) § *A persona's host*).
- **"Nebula" is retired.** It was the product's code name during development, and it appears nowhere a user can see — so `nebula.lumenize.com` retires, since a host shows in the address bar. Code identifiers keep the name, because renaming them buys a user nothing.
- **There is no fourth domain a user sees.** `lumenize.ai`, `lumenize.app`, `lumenize.org` and `lumenize.net` are all taken. `lumenize-test.dev` carries only test traffic, pages and mail.

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

- **The host is the active scope.** The host `tenant1.crm.acme.lumenize.dev` is the scope `acme.crm.tenant1`, so the server derives `activeScope` from the host and the client never sends one.
- **A persona gets its own host by joining its Star's label with `--`.** The first label splits on `--`: one part is a Star, two parts are a persona and its Star, which is always an environment Star such as `dev` or `test` and never a tenant (Larry, 2026-09-14). `--` is safe as the delimiter because `isValidSlug` refuses a doubled hyphen inside a slug, and a slug can neither start nor end with `-`. Netlify spells its branch hosts the same way, as in `staging--mysite.netlify.app`.
- **Every slug is at most 30 characters, and a persona slug at least 3.** A persona and a Star share one 63-character label, and 30 + 2 + 30 fits; `warehouse-management-system` is 27. The floor exists because a label with `--` as its third and fourth characters is reserved for punycode names such as `xn--bcher-kva`, and certificate authorities refuse to name one. So `ed--dev` would be refused wherever a host gets a certificate of its own. Only a persona slug comes before a `--`, so only it needs the floor, and a two-letter galaxy such as `hr.acme.lumenize.dev` stays legal.
- **Environments are reserved Star slugs, never labels.** `dev`, `staging`, `prod`, `test`, `preview`, `sandbox`, `qa` and `demo` are reserved in every galaxy, so a later `staging.crm.acme.lumenize.dev` is one more host under the galaxy's wildcard. Reserve generously: releasing a name later is free, and reclaiming one a customer holds is a migration.
- **Platform labels are reserved universe slugs.** `platform.lumenize.dev` looks exactly like a universe named `platform`, so `platform`, `email`, `www` and every later platform label are refused as universe slugs.

### What certificates may cost

**The certificate set must never grow with tenants or personas.** A tenant per customer and a cast of eight are created in seconds and in bulk, and a certificate order for each would put a wait of minutes on every one. The grammar above holds it, because a wildcard covers any value in its one label, and `--` keeps a persona inside its Star's label. To a certificate, `manny--dev.crm.acme.lumenize.dev` is just another host under `*.crm.acme.lumenize.dev`, exactly like `tenant1.crm.acme.lumenize.dev`.

**It does grow with universes and galaxies, and that is accepted.** Creating either orders one wildcard — `*.acme.lumenize.dev`, `*.crm.acme.lumenize.dev` — and the hosts beneath it answer only once that certificate is active. So creating a universe or a galaxy is asynchronous, and the pages that create them show the wait.

Today's mechanism is Cloudflare's Advanced Certificate Manager (ACM), $10 a month for the zone however many wildcards it holds. A Free zone took 20 certificates with no refusal, room for 980 wildcards, and Cloudflare does not publish where it stops.

**Past ACM's ceiling, the escape hatch is an Enterprise plan.** It adds two things, and either one keeps a galaxy at one certificate:

- **A documented certificate limit** of 100 per zone — about 4,900 wildcards, or 2,450 universes with one galaxy each.
- **Wildcard custom hostnames in Cloudflare for SaaS**, so `*.crm.acme.lumenize.dev` becomes one custom hostname. It serves the same host names, so no URL changes.

**Cloudflare for SaaS without Enterprise is not an escape hatch.** Every plan has it, but below Enterprise it certifies each host on its own — the first 100 across the zone free, then $0.10 a month each — so every Star and persona would get a certificate, which the rule above forbids. It stays the route for a customer's own domain.

**The ceiling arrives only with hundreds, likely thousands, of customers**, and Larry expects funding at that scale to make Enterprise's negotiated price a non-issue (2026-09-11).

### Every `lumenize.dev` host stays one site

Every `lumenize.dev` host is a sibling under one registrable domain, so a browser treats all of them as one site. A Public Suffix List entry would make each universe a site of its own, and **we do not plan to submit one**: [ADR-022](022-every-session-lives-on-the-platform-host.md) keeps every session on `platform.lumenize.dev`, which can serve a page on another host only while both share a site. A customer who wants a site of its own gets one with its own domain.

## Alternatives considered

- **A — one flat label per scope,** `acme--crm--tenant1.lumenize.dev`, with an environment as its own label. One free wildcard covers every host, and nothing waits on a certificate. Rejected on characters: three slugs share 63, so each caps at 19, and `northwind-traders-intl` at 22 does not fit.
- **B — a label per galaxy,** `tenant1.acme--crm.lumenize.dev`. It buys the characters back and costs the same per-galaxy wait. Rejected because it spells a galaxy one way and a Star another (Larry, 2026-09-11).
- **A persona as its own label,** `manny.dev.crm.acme.lumenize.dev`. It needs a wildcard per Star, so the certificate set grows with tenants.
- **An environment as its own label,** such as `crm.acme.dev.lumenize.dev`. A Star slug already carries the environment for nothing, and a label would stop the host being a direct spelling of the scope.
- **Cloudflare for SaaS for every host from the start.** Rejected for the reason § *What certificates may cost* gives: below Enterprise, the certificate set would grow with tenants and personas.
- **Studio on a registrable domain of its own,** as `nebula.lumenize.com` is today — a trusted control plane kept apart from the apps. It pairs with any of the grammars above. Rejected because the galaxy's host is where the app lives, so it serves Studio to the people building the app (Larry, 2026-09-11), and because Studio shows the app in frames: with Studio on another site, every frame's request to `platform.lumenize.dev` is third-party and Safari withholds its cookies, so no tab could get a token. `__Host-` cookie names answer the cookie threat a separate domain answered. The frame problem also keeps Studio off a customer's own domain.

## Consequences

### Positive

- **A link names the scope it opens.** The host alone says universe, galaxy and Star, which is what [ADR-017](017-the-url-is-the-view-state.md) needs from a shared link.
- **[ADR-015](015-passage-and-dominion.md)'s predicates get their scope from the address bar.** [ADR-022](022-every-session-lives-on-the-platform-host.md) narrows a token's `authScope` to its host, so a universe admin working on `tenant1.crm.acme.lumenize.dev` holds dominion over that Star alone.
- **Every Star and persona is its own origin**, so the browser keeps their storage apart without our code doing it.
- **Tenants, personas and environments cost no certificates.** Only universes and galaxies do.
- **One 30-character rule covers every slug.**

### Negative / mitigations

- **Creating a universe or a galaxy waits two and a half to four minutes, and nothing can pre-pay it.** A certificate names its hosts, so none can be ordered for a galaxy nobody has named yet. Orders placed together validate together, though, so a page creating a universe and its first galaxy orders both and waits once. A progress indicator on the create pages shows the wait.
- **Certificate lifecycle becomes ours.** A deleted galaxy leaves its wildcard behind, and deletes can stall or fail transiently, so reaping retries and reconciles.
- **The per-zone wildcard ceiling is unpublished below Enterprise.** Reaching it means an Enterprise plan (§ *What certificates may cost*).

### Deliberately open

- **Customer custom domains**, Beta at the soonest. The likely case is an app's own domain, serving the app's Stars to their members while Studio stays on `lumenize.dev`; a universe-level domain is unlikely (Larry, 2026-09-17).
- **Mail enforcement.** DMARC on `lumenize.com` stays at `p=none` until one posture is set across all three zones, tracked in [`tasks/backlog.md`](../../tasks/backlog.md) § *Infrastructure*.
