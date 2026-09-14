# Which domain is for what — `lumenize.com`, `lumenize.io`, `lumenize.dev`

**Status:** ✅ **DECIDED 2026-09-11 — alternative C**, measured rather than argued (§ *Measured — the C experiment*). Larry: the ceiling is fine and the certificate delay is the only thing that bites, so ship C and mitigate the delay with a progress indicator rather than a pre-issued pool. An ADR follows and this file is its evidence; how a person holds a session on each host — the name in a web address, like `tenant1.crm.acme.lumenize.dev` — is decided separately, in [sessions-per-origin.md](sessions-per-origin.md).

**Context.** We own `lumenize.com`, `lumenize.dev`, and `lumenize.io`. Today's allocation was never chosen — it accreted one task at a time.

**Question.** What is each domain we own *for*, decided on what makes sense rather than on what we happen to have wired up? 

**What this file is.** The working scratchpad/record for that decision: the measured current state below, then the alternatives we weigh and why each survives or dies. It is the **evidence** an ADR cites rather than inlines — `docs/adr/README.md` keeps an ADR to about one page and sends research records here. When the ADR is drafted, this archives as `tasks/archive/decision-domain-allocation.md` and stops changing; anything learned after that goes into the ADR's § *Alternatives considered*.

**How to weigh it.** Current usage is the **tie-breaker, never the argument** (Larry, 2026-09-11). Fixing this is cheap now and impossible later: pre-alpha, one batched wipe gate, zero external users, so a reallocation today is a config sweep and after invites it is a migration plus dead links plus comms. `.claude/rules/workflow.md` § *Evaluating alternatives* prices the alternative — a permanent divergence costs per-reader-per-encounter forever, and you spot one by asking *why is this different?* — when the honest answer is history rather than a requirement, it is one.

---

## Measured 2026-09-11

All four zones sit on Cloudflare nameservers (`cory` / `ariadne`). `dig` output, trimmed:

| Zone | MX | A | DMARC | What it does today |
|---|---|---|---|---|
| `lumenize.com` | **Google Workspace** (`aspmx.l.google.com`) | Cloudflare-proxied | ⚠️ **none** | The public docs site — `website/docusaurus.config.ts` sets `url: 'https://lumenize.com'`, and ~170 `@see https://lumenize.com/docs/…` JSDoc links across `packages/**` point at it. Also Larry's real human mail. |
| `nebula.lumenize.com` | — | Cloudflare-proxied | — | **The only `custom_domain` in the repo** (`apps/nebula/wrangler.jsonc`). The trusted control plane: Studio, auth, Gateway. |
| `lumenize.io` | Cloudflare Email Routing (`route1/2/3.mx.cloudflare.net`) | none | `p=reject` | Inbound mail. A catch-all the `/live` harness rides for real magic-link round trips (`.claude/rules/live.md`), and the post-wipe `claude@lumenize.io` receiver. |
| `personas.lumenize.io` | **none** | **none** | — | Reserved as *undeliverable* — the namespace-nobody-can-hold argument in [nebula-persona-sessions.md](nebula-persona-sessions.md). Nothing enforces the emptiness. |
| `lumenize.dev` | **none** | **none** | none | ⭐ **Completely empty. No records of any kind.** It exists only in prose. |
| `test.lumenize.com` | none | none | — | Nothing. Was the first choice for personas and lost on `lumenize.com`'s Google MX with no DMARC. |

⭐ **The untrusted data plane has zero infrastructure**, so discounting its current usage costs exactly nothing — there is none. What exists is three forward-referencing JSDoc comments (`profile-pictures.ts`, `home-logic.ts`, `nebula-auth-facade.ts`) and one task file. [What do you mean by the "untrusted data plane"?]

**The several `lumenize.dev` host shapes written down are not scattered decisions — they are unresolved forks inside one file**, [on-hold/use-lumenize-dev-domain-and-support-custom-domains.md](on-hold/use-lumenize-dev-domain-and-support-custom-domains.md): flat `acme--crm.lumenize.dev` against nested `crm.acme.lumenize.dev`, star-in-path against star-in-host (`acme--crm--tenant1`), and `app.acme.lumenize.dev` for the custom-domain switch. That file also already plans a PSL submission. Its split — `nebula.lumenize.com` trusted control plane, `lumenize.dev` untrusted data plane — was the closest thing to a commitment before this file. ⚠️ **That task is OBE and MUST NOT be read as the plan** (Larry, 2026-09-11): its custom-domain half is Beta at the soonest, and its half that moves apps onto their own subdomains is overtaken by § *Alternatives considered*. [We should probably have a todo in the final task file to clean all of that up. Where should we keep track of all the places we find that need cleaning up?]

## Constraints — what is already fixed

Three tiers. **The third exists because two things that feel immovable are not**, and treating them as constraints would decide the question by inertia.

### Not ours to change

- **Every `lumenize.dev` host is HTTPS-only, and a broken certificate is a DEAD PAGE rather than a warning.** Google runs the `.dev` top-level domain and put the whole of it on the browsers' built-in HSTS preload list — the list that tells a browser never to offer the *"proceed anyway"* interstitial for a domain. It is their policy, not a setting of ours, and there is no opting out.

- ⭐ **INVARIANT, agreed 2026-09-11: the certificate set MUST NOT grow with tenants.** A fixed, small set of wildcards at any depth is fine; one per universe, galaxy, star or persona is not. This names what we are protecting rather than a proxy for it — "one level" and "one wildcard" each forbid harmless shapes while naming nothing that actually hurts. Two further invariants ride with it: **every production host is HTTPS** (free on `.dev`, which enforces it anyway), and **`lumenize.dev` goes on the Public Suffix List before external users**.

- **A free certificate covers the apex plus ONE wildcard label, and a wildcard matches exactly one label.** `*.lumenize.dev` covers `manny--acme--crm.lumenize.dev` and does **not** cover `manny--acme.crm.lumenize.dev`. Going deeper needs Advanced Certificate Manager at $10/month per zone, with each deeper wildcard listed explicitly, ~49 per certificate. Larry already purchased it for `lumenize.dev`.
  - ⭐ **The money is a footnote; the real cost is WHERE issuance lands.** Keep every variable part in one label and one free certificate covers unlimited hosts forever. Put a variable part to the right of a dot and you need `*.{galaxy}.lumenize.dev` — one certificate per galaxy, so *create a galaxy* becomes *issue a certificate and wait*. This is what forced the flat single-label grammar in [nebula-persona-sessions.md](nebula-persona-sessions.md) § *The name*. [Isn't there a $0.10 cost for each new batch of 49 certificates? If so, we should warn that hundreds is a rounding error. Thousands, not a worry out of Larry's pocket. 10's of thousands might start to be a problem but by then, Larry expects to have venture funding, so also not a worry.]
- **A DNS label holds 63 characters; an email local part holds 64.** Already binding — it is what produced the 11/24/24 caps. [Should we also list the set of characters valid for both `a-z`, `0-9`, and `-`?]
- **Cloudflare Email Routing supports thirty subdomains per zone, apex included.** [Do any of the alterantives below use the subdomains for email?]

### Fixed by the outside world — very painful to move

- **`lumenize.com`'s APEX MX belongs to Google Workspace** and carries Larry's real mail, as a domain alias of `maccherone.com`. ⭐ **The constraint is the apex record, never the zone** — `email.lumenize.com`, or any other label under it, is free to point at Email Routing.
- **`lumenize.com`'s apex serves the live marketing and docs site.** Nine published blog posts back to 2025-10-10, cross-posted to Discord, Medium and Substack, where the inbound links cannot be edited. Moving the apex strands those. ⓘ The ~170 in-repo `@see https://lumenize.com/docs/…` JSDoc links are **not** the cost — no package is published yet, so they are a mechanical sweep (`.claude/rules/calibration.md` §3(c)).

### Looks fixed, is not — discount these

- **`nebula.lumenize.com` as the control plane.** It is the only `custom_domain` in the repo, which makes it read as load-bearing. It is not: no external users, every session dies at the wipe, magic links expire, and it is one route plus one DNS record plus a handful of constants.
- **`lumenize.io`'s Email Routing and catch-all.** The `/live` harness rides it and [ADR-009](../docs/adr/009-real-auth-path.md) makes real-email login the default path — but the harness is ours and every address it mints is disposable. A config cost, not a constraint.
- **`personas.lumenize.io`.** Reserved by a task-file decision with nothing deployed and no rows behind it. Free.

### One-way doors — not constraints yet, but decided once

- **A Public Suffix List entry.** The PSL is how a browser knows where one organisation's domain ends — `co.uk` is on it, which is what makes `foo.co.uk` and `bar.co.uk` different companies rather than siblings. ⭐ **What it buys here is narrower than it sounds.** Separate hosts already give separate `localStorage` and `sessionStorage`, and `lumenize.dev` and `lumenize.com` are already different domains, so the two planes are isolated from each other today with nothing to do. **Cookies are the exception — they are scoped by domain, not by origin**, where an origin is `https://` plus a host, such as `https://crm.acme.lumenize.dev`. A generated app on `acme--crm.lumenize.dev` can set `Domain=lumenize.dev`, and every sibling host, persona tabs included, then sends it. A PSL entry makes browsers refuse that, which is why `workers.dev`, `pages.dev` and `vercel.app` all carry one. Cost: weeks to months to reach browser releases, and harder to undo than to do.
- **Durable Object namespace names.** `test-nebula` is redeployed under one stable name because fresh names strand a DO-namespace set per run, and only a dashboard project-delete removes them. This constrains environment naming rather than the planes.

**The option space is the three domains we already own** — `lumenize.com`, `lumenize.io`, `lumenize.dev`. Buying a fourth is ruled out (Larry, 2026-09-11), and nothing below proposes one.

## The axes, and where each one stands

| # | Axis | Status |
|---|---|---|
| 1 | **Trust boundary** — which domain serves user-developer code | **Settled** — `lumenize.dev` is everything user-facing; § *The allocation* |
| 2 | **Registrable-domain count** | **Settled** — the three we own, no fourth (Larry, 2026-09-11). The planes are already separate domains, so a PSL entry buys sibling isolation INSIDE `lumenize.dev`, nothing else |
| 3 | **Mail** — which zones carry MX | **Partly** — which zones deliver is settled; the enforcement posture is deferred, and whether personas receive mail is not this file's |
| 4 | **Certificates** | **Settled and measured** — alternative C, § *Measured — the C experiment* |
| 5 | **Customer custom domains** | **Deferred** — Beta at the soonest (Larry, 2026-09-11), via Cloudflare for SaaS when it comes |
| 6 | **Brand — what a user-developer sees** | **The name is decided** — the product is Lumenize (Larry, 2026-09-13). What `lumenize.com` does at beta is still a direction; § *The allocation* marks it |
| 7 | **Environments** | **Settled** — reserved STAR slugs, never domain labels, which is what keeps them free of certificates |

⚠️ **This decision MUST NOT settle whether personas receive mail.** That is [nebula-persona-sessions.md](nebula-persona-sessions.md) § *Open questions* 1, and it runs the other way: if the email round trip stays, the persona domain must deliver; if it goes, it must not. So the allocation names what each domain is *for* and makes both a mail-receiving and a deliberately-undeliverable home expressible — and that file picks. Writing "the persona domain resolves no mail" here would decide an open question by side effect.

## The allocation

### `lumenize.com` — the brand, and human mail

**Two things about the apex cannot move**, and neither constrains the rest of the zone. Its MX belongs to Google Workspace and carries Larry's real mail as a domain alias of `maccherone.com`. Its A record serves the live marketing and docs site — nine published posts back to 2025-10-10, cross-posted where inbound links cannot be edited. **Labels under it are free**, so `email.lumenize.com` or anything else may point wherever it likes.

**Today it carries the `@lumenize/*` open-source package docs.**

**The name is decided: the product is Lumenize** (Larry, 2026-09-13). "Nebula" is the project's code name, so it leaves every user-facing surface — URLs, hostnames, UI copy, emails and published docs — while code identifiers keep it.

ⓘ **What `lumenize.com` does at beta is still a DIRECTION, not a decision.** At beta it becomes the product's marketing site, the `@lumenize/*` packages are demoted from a marketing point of view, the package docs move to `lumenize.io`, and the site is free to stop being Docusaurus. The ADR notes it without committing to it (Larry, 2026-09-13).

**The docs move is already safe, which is why it can stay a direction.** `website/static/_redirects` exists and does exactly this job today — two 301s repointing a renamed package's doc URLs, placed there for external and bookmarked links. Docusaurus copies `static/*` to the build root verbatim and the site deploys as a Worker, so Workers Assets honours the file. Destinations may be absolute URLs and `lumenize.com` keeps being served, so a cross-domain move is one more line per path prefix. ⚠️ **Not `@docusaurus/plugin-client-redirects`** — it is not installed and should not be: it emits client-side JavaScript redirects for same-site renames, which is strictly worse here.

⭐ **`nebula.lumenize.com` disappears.** Alternative C makes Studio the galaxy origin, so the control-plane host has no job left — and the branding decision above would have made its name wrong regardless.

### `lumenize.io` — inbound mail, and later the package docs

Cloudflare Email Routing on the apex, DMARC `p=reject`, with a catch-all. **Internal testing rides that APEX catch-all, not a subdomain**: `apps/nebula/harness/prod.ts` mints `spin-<8 hex>@lumenize.io` and the catch-all forwards to a deployed email-test Worker. `claude@lumenize.io` is the post-wipe inbound receiver.

`personas.lumenize.io` is reserved and carries no records, pending [nebula-persona-sessions.md](nebula-persona-sessions.md) § *Open questions* 1.

ⓘ **Direction:** the package docs move here when `lumenize.com` becomes the product's marketing site. A zone serving docs while also carrying mail is ordinary.

### `lumenize.dev` — everything user-facing

**Grammar: alternative C.** Beyond it, four platform reservations:

- **The root is a landing page for user-developers**, deployed as a Workers project and linked prominently from `lumenize.com`.
- **`platform.lumenize.dev` is the host of the `platform` scope** — login, the magic-link consume, Home, and superusers, who are simply members of that scope. [sessions-per-origin.md](sessions-per-origin.md) is what this host does. The reserved scope value `nebula-platform` (`PLATFORM_SCOPE` in `packages/nebula-auth/src/types.ts`) becomes `platform`; it is stored as a scope id and appears in URLs, so the rename is free before the wipe and a migration after.
- ⚠️ **Platform labels share the UNIVERSE-slug namespace, so that is where they are reserved.** Under C a universe is a first label with no `--` — `acme.lumenize.dev` — so a platform label such as `platform` or `email` looks exactly like a universe a customer could claim. Every platform label goes into `RESERVED_UNIVERSE_SLUGS`, which is already due for re-deriving (§ *Shared by every alternative*).
- **A Public Suffix List entry lands before external users.** Cookies are scoped by domain rather than origin, so without it a generated app can set `Domain=lumenize.dev` and reach every sibling, Studio included.

Advanced Certificate Manager is enabled on this zone as of 2026-09-11, $10/month.

### Mail posture across all three

All three zones now carry DMARC: `lumenize.io` at `p=reject`, and `lumenize.com` plus `maccherone.com` at `p=none` through Cloudflare DMARC Management, enabled 2026-09-11. ⚠️ **Moving the latter two to quarantine and then reject is deliberately deferred to this allocation**, so the posture is set once across every zone rather than per-zone by accident. `lumenize.dev` sends nothing today and wants its own treatment — a null SPF and an enforcing DMARC — once it is clear whether it ever sends.

## Sessions and cookies

Decided separately, in [sessions-per-origin.md](sessions-per-origin.md). `platform.lumenize.dev` establishes a session by top-level redirect and every scope host keeps its own host-only refresh cookie — sent back only to the exact host that set it — so no cookie carries a `Domain` attribute and the PSL entry stands.

## Shared by every alternative

Both alternatives below put **everything user-facing on `lumenize.dev`, with a PSL entry underneath**. They differ only in how a host spells a scope. So what follows belongs to that shared premise rather than to either option, and filing it under one of them would make the other look cheaper than it is.

**Resolved:**

- **Star-in-host — RESOLVED, and by construction.** Both alternatives put the star in the host: A as a segment of the flat label, B as a label of its own. So the star-in-path fork [on-hold/use-lumenize-dev-domain-and-support-custom-domains.md](on-hold/use-lumenize-dev-domain-and-support-custom-domains.md) left open cannot be taken under either. Consequence: Stars of one galaxy no longer share an origin, so each tenant has its own cookie jar and cross-tenant navigation is cross-origin. Likely right — that is tenant isolation — but recorded as decided rather than inherited.
- **Where the auth endpoints live — RESOLVED in [sessions-per-origin.md](sessions-per-origin.md).** Login and the magic-link consume live on `platform.lumenize.dev`; each scope host serves only its own `refresh-token` and `callback` endpoints, and gets its session through a signed value minted during a top-level redirect. The PSL is what forced that: once `lumenize.dev` is a public suffix a browser refuses `Domain=lumenize.dev`, so no one host can place a cookie on another. The Gateway is unaffected — it carries a bearer token, so `gateway.lumenize.dev` against `lumenize.dev/gateway` is taste.

**Open under either, and not blocked on choosing between them:**

- **Custom domains.** `app.acme.com` arrives as a Cloudflare for SaaS custom hostname — 100 free, then $0.10/month each — and serves Studio to a galaxy scopeAdmin or the app's own landing page to anyone else. ⚠️ That means Studio's session cookie lands on the CUSTOMER's domain, which is worth deciding rather than inheriting.
- **Studio has no host of its own**, being the galaxy origin. That deletes `nebula.lumenize.com` from the design and puts the trust boundary inside one registrable domain — which is what promotes the PSL entry from hygiene to load-bearing, since a sibling setting `Domain=lumenize.dev` would otherwise reach Studio.

**Obliged by either, and cheapest before the wipe — three reservations to settle, one of them by re-deriving rather than extending:**

- **Environment names become reserved STAR slugs.** `RESERVED_STAR_SLUGS` is `{'dev'}` (`packages/nebula-auth/src/types.ts`), enforced in `claimStar`, and its JSDoc already says to extend it with `staging` / `prod`. Reserve generously — `dev`, `staging`, `prod`, `test`, `preview`, `sandbox`, `qa`, `demo` — because releasing a reserved name later is free while reclaiming one a customer holds is a migration and a conversation. Star tier only: reservation is per galaxy, since uniqueness is on the full `{u}.{g}.{s}`, and a galaxy named `dev` collides with nothing because the dev Star sits a level deeper.
- ⚠️ **`RESERVED_UNIVERSE_SLUGS` must be RE-DERIVED, never extended.** It holds `app`, `auth`, `gateway`, `assets`, `studio`, `pictures`, and every entry is justified by one sentence in its JSDoc: a universe's page is served scope-first at `nebula.lumenize.com/{universe}`, so the slug IS a first path segment. Both halves of that die here — a universe becomes a HOST LABEL rather than a path segment, and `nebula.lumenize.com` disappears once Studio is the galaxy origin. So some entries lose their reason while new ones appear: anything that would shadow a platform label such as `platform`, `email` or `www`. Re-derive the list against the new grammar (`.claude/rules/calibration.md` §4 — a justification expiring is a trigger to re-derive, never to trust or delete).
- **A second copy of the star set will drift silently.** `apps/nebula/test/test-helpers.ts` declares its own `RESERVED_STAR_SLUGS` and checks it separately; adding `staging` in one place leaves the lanes disagreeing with nothing red. Fold it into the shared import when the names go in.

## Certificate mechanisms — three of them, and they do not compete

Whichever host grammar wins, three ways exist to get a certificate in front of it. ⭐ **They scale on opposite axes, which is what decides where each belongs.**

| | Cost | Scales with | Personas, tenants, environments | Ceiling |
|---|---|---|---|---|
| **Universal SSL wildcard** | $0 | nothing — one free wildcard, one label deep | free | none |
| **ACM wildcards** | **$10/month per ZONE, flat** | levels that VARY — universes + galaxies | **free**, they ride a wildcard | ~4,900, undocumented below Enterprise |
| **Cloudflare for SaaS** | $0 to 100 hostnames, then **$0.10 each** | **distinct HOSTNAMES** | **$0.10 each**, no wildcard to ride | 50,000, documented |

⚠️ **Compounding `{p}--{s}` into one label is free only under a wildcard.** Cloudflare for SaaS has none, so `manny--dev.crm.acme.lumenize.dev` is its own host needing its own certificate. Wildcard custom hostnames exist but are **Enterprise-only**. So the trick that makes personas free under C buys nothing there.

**Which puts break-even far earlier than it looks.** Assume a customer with a galaxy, a dev workspace, five tenants and a cast of eight — fifteen distinct hosts:

```
customers   hostnames   Cloudflare for SaaS   ACM
       13        ~200          $10  ← break-even   $10
      100      ~1,500         $140                  $10
    2,450     ~36,750       $3,665                  $10
```

**Break-even is ~200 hostnames, roughly THIRTEEN customers** — not a hundred galaxies. Past that ACM stays flat while Cloudflare for SaaS grows linearly, and at 2,450 customers you would also be nearing the 50,000 hostname cap. Even on a stingy three-hosts-per-customer assumption with no personas, 2,450 customers is ~$725/month against ACM's $10.

**And going Cloudflare for SaaS early costs more than money:** certificate issuance moves onto the persona-provisioning and tenant-signup paths rather than sitting on galaxy creation alone. Defining a cast of eight becomes eight certificate orders a user-developer watches happen.

⭐ **Switching later is NOT a URL migration, which retires the main reason to decide early.** `tenant1.crm.acme.lumenize.dev` is the same string under both — only what certifies and routes it changes. No dead links, no lost cookie jars, no origin change. It is additive rather than a cutover: create custom hostnames while the wildcard still serves, let the more specific certificate take over as each is issued, then retire the wildcard. Real config work, since a custom hostname routes via a fallback origin rather than a proxied wildcard record, but not an outage.

⇒ **ACM for the bulk, Cloudflare for SaaS at the margin** — past the ceiling, and for customers bringing their own domain. Not a migration to plan for; a second way in, added where the first runs out.

ⓘ **Alternative A is immune to this whole axis.** Every host is one label riding the free wildcard, so it needs no ACM subscription and Cloudflare for SaaS would cost it $0 — one more thing C's $10 and eleven extra characters are being weighed against.

## Measured — the C experiment

Run 2026-09-11 against `lumenize.dev`, a **Free Website** zone with no DNS records, using a token scoped to that zone's SSL and Certificates. Twenty advanced certificate packs ordered from Google Trust Services, TXT validation, 90-day validity; all deleted afterwards.

| Question | Result |
|---|---|
| Are two-level wildcards accepted? | **Yes.** `*.u1.lumenize.dev` and `*.g1.u1.lumenize.dev` ordered on one pack and reached `active`. |
| Is domain control validation automatic at depth? | **Yes.** Cloudflare placed `_acme-challenge` TXT records itself at the apex, at `u1`, and at `g1.u1` — names with no other records. No manual step at any level. |
| What is the per-zone certificate limit on Free? | **≥20, no refusal.** The run stopped at its own cap, not Cloudflare's. At ≥20 packs × 49 wildcards that is past 1,000 wildcards on a free zone, so the ~2,450-customer ceiling stands and may be higher. |
| How long from order to active? | **~150 s in validation, then deployment fans out; 12 of 20 were active at t+188 s and 17 of 20 by t+251 s.** |

⭐ **The validation wall is roughly FIXED rather than per-certificate** — twenty packs cleared it in about the time one did. So a pre-issued pool would amortise extremely well if one is ever built. What that does not fix is a galaxy created cold, which still waits three to four minutes.

**Method notes, so this is reproducible rather than asserted:**

- ⚠️ **The certificate-packs list endpoint hides non-active packs unless you pass `?status=all`.** The first listing after ordering twenty showed `count: 1` and read as though every order had failed.
- ⚠️ **The timing is contaminated past t+299 s**, where cleanup deletions overlapped the tail and the counts run backwards. Everything to t+251 s is clean. Before anyone builds against 188 s, re-run with ONE certificate on a quiet zone and no concurrent deletes.
- **A certificate being `active` is NOT the same as a host serving.** An SNI handshake for `tenant1.g1.u1.lumenize.dev` against Cloudflare's edge returned nothing, because the edge maps SNI to a zone through a proxied DNS record and the zone has none. Proving the last mile needs one proxied wildcard record plus a Worker route — still unverified.

## Alternatives considered

### A — flat scope label, environment as a second-level label

**The proposal.** Everything user-facing lives on `lumenize.dev`. A host's FIRST label carries the scope, `--`-delimited, and segment count says what it is. A second-level label, drawn from a fixed set we control, carries the environment.

```
lumenize.dev                              landing page for user-developers, a Workers project
email.lumenize.dev                        reserved: no-`--` labels are platform-owned
acme--crm.lumenize.dev                    a galaxy  (2 segments) — serves Studio
acme--crm--tenant1.lumenize.dev           a tenant Star (3 segments), production
acme--crm.dev.lumenize.dev                that galaxy's dev workspace
manny--acme--crm.dev.lumenize.dev         a persona in it (3 segments under `dev`)
```

**Certificates: two wildcards, $10/month for the zone, forever.** `*.lumenize.dev` is free under Universal SSL; `*.dev.lumenize.dev` and any later `*.staging.` / `*.test.` are advanced certificates, and **ACM is priced per ZONE rather than per certificate**, so the whole fixed set costs one subscription. Domain control validation is automatic on a full Cloudflare setup, and renewal is automatic. Nothing is issued when a tenant is created, which is what keeps the certificate count independent of how many tenants exist.

**Character budget — the tenant namespace binds, because `{u}` and `{g}` appear in both:**

```
tenant   {u}--{g}--{s}         u + g + s  ≤ 59   →  19 / 19 / 19
persona  {persona}--{u}--{g}   persona    ≤ 21   once u and g are 19
```

So **19 characters for every scope slug**, which is a revision of the 11/24/24 in [nebula-persona-sessions.md](nebula-persona-sessions.md) § *The name* and costs nothing, since none of it is built. What makes 19 painless is the scope display name in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Scope full names*: the slug is an identifier, the name is free text.

**What it buys.** Segment count is a total parse — no reserved prefix, no lookup, no arity collision between personas and tenant Stars. Two of the three precedents it copies are spelled the same way (`{branch}.{project}.pages.dev`, `{worker}.{subdomain}.workers.dev`), and all three sit on the Public Suffix List.

**What is open inside it:**

- **Environment as a domain LABEL rather than a star slug.** `{u}.{g}.{env}` is already the anticipated vocabulary in `RESERVED_STAR_SLUGS`' JSDoc, but there it is a star slug. Moving it to a label means the origin stops being a positional rendering of the scope id, so something must map between them — `parseId`, `RESERVED_STAR_SLUGS` and the `s[2] === 'dev'` tests in `star.ts` and `galaxy.ts` all read the slug position today.

### B — a label per galaxy, the `pages.dev` shape

**The proposal.** The galaxy gets a DNS label of its own, and everything inside it becomes a label to its left — the spelling `pages.dev` and `workers.dev` both use.

```
acme--crm.lumenize.dev                    a galaxy — serves Studio (unchanged from A)
tenant1.acme--crm.lumenize.dev            a tenant Star
dev.acme--crm.lumenize.dev                that galaxy's dev workspace
manny--dev.acme--crm.lumenize.dev         a persona in it
```

⭐ **What it buys is the character budget, and it buys a lot of it.** Each label gets its own 63, so the caps stop competing:

```
A   {u}--{g}--{s}.lumenize.dev        19 / 19 / 19
B   {s}.{u}--{g}.lumenize.dev         u,g ≤ 30 each, and s ≤ 63 on its own
```

`northwind-traders-intl` is 22 characters — it fits under B and does not under A. That is the whole of the case, and it is a real one.

**What it costs, and cost is NOT the word.** It needs `*.{u}--{g}.lumenize.dev`, one wildcard per galaxy. ⚠️ **Do not reject this on price** — Advanced Certificate Manager is billed per ZONE, so a thousand per-galaxy wildcards cost the same $10/month as two. Three things are the real objection:

- **Certificate issuance lands on the critical path of creating a galaxy.** Order, issue, propagate, and only then does the origin answer. Creating a galaxy becomes asynchronous and gains a failure mode at a certificate authority, for a reason the user-developer cannot act on.
- **The galaxy ceiling becomes a number Cloudflare does not publish.** 100 edge certificates per zone is documented for Enterprise and nothing is stated for Free, Pro or Business. At ~49 wildcards per certificate the ceiling is real but unknown, and it is theirs to change.
- **It contradicts the invariant agreed above**, which is fine to do knowingly and not fine to do because the money turned out to be small.

**The honest steelman, which decides how seriously to take it:** creating a galaxy may already be slow. It provisions a Durable Object, a container and a git tree, so if that is tens of seconds already, a certificate order inside it may be lost in the noise — and Cloudflare runs exactly this machinery for Pages, so it is proven at scale. **What separates us from them is that issuance is an internal operation for a certificate authority's own infrastructure and an API call with propagation for everyone else.** Before rejecting B, measure how long creating a galaxy takes today and how long an advanced certificate actually takes to serve traffic.

⚠️ **B is not a later migration from A.** Every origin changes spelling, so every cookie jar, every stored link and every custom-hostname mapping moves with it. Whichever is chosen is chosen now, which is the argument for settling it before invites rather than after.


### C — nested scope labels, personas compounded into the star label

**The proposal.** One label per scope tier, and the persona rides the star's label rather than taking one of its own. Environments stay star slugs, where the code already puts them.

```
acme.lumenize.dev                   a universe        free *.lumenize.dev
crm.acme.lumenize.dev               a galaxy          *.acme.lumenize.dev       one per universe
dev.crm.acme.lumenize.dev           the dev workspace ┐
tenant1.crm.acme.lumenize.dev       a tenant Star     ├ *.crm.acme.lumenize.dev  one per galaxy
manny--dev.crm.acme.lumenize.dev    a persona in dev  ┘
```

⭐ **Certificates count dots, not characters** — which is the whole reason this shape works. A `--` compound lives inside one label and costs nothing, while every `.` where something varies needs its own wildcard. So personas are free, and so are environments, because both are values inside a label that is already covered. Adding `staging` and `prod` later adds no certificates at all.

**Cost: universes + galaxies**, at $10/month for the zone however many there are. At one galaxy per universe that is 2 entries per customer, and against the ~4,900 the Enterprise limit implies, roughly **2,450 customers with unlimited tenants and personas each**.

**Character budget — the compound label is the only tight position, so one rule covers everything:**

```
{p}--{s}   N + 2 + N ≤ 63  →  N ≤ 30
{g}, {u}   their own labels, 63 each — never binding
```

**30 characters for every slug, one validator, no per-tier table.** `northwind-traders-intl` is 22 and `warehouse-management-system` is 27; both fit here and neither fits A's 19. The parse is `split('--')` on the first label — one part is a Star, two parts is a persona in a Star.

**What it costs beyond the money:**

- **Certificate issuance lands inside "create a galaxy."** Order, issue, propagate, then the origin answers. Creating a galaxy becomes asynchronous and can fail at a certificate authority for a reason the user-developer cannot act on. Creating a tenant or a persona stays instant, which is the improvement over every earlier nesting we costed.
- **Certificate lifecycle becomes ours, and teardown is the flaky half.** A deleted galaxy leaves its wildcard, so something must reap and reconcile — the same way a deleted Worker leaves Durable Object namespaces behind. ⚠️ **Observed rather than predicted:** packs sat in `pending_deletion` for **400+ seconds**, and one delete returned `1406 Bad response certificate service` and succeeded on retry. The reaper needs retries and reconciliation, never a fire-and-forget call.
- **The ceiling sits on an undocumented number.** 100 certificates per zone is published for Enterprise and nothing is published for Free, Pro or Business.

**The escape hatch, and what it costs.** Cloudflare for SaaS serves subdomains of a zone we own, 100 hostnames free then $0.10/month each, with a documented 50,000 cap — ten times the wildcard headroom. ⚠️ **It arrives as a discontinuity, though:** the ceiling bites NEW galaxies while existing ones keep their wildcards, so past it you would have two classes of galaxy wearing different grammars, permanently. That is the consistency objection B was rejected for, arriving later and larger.

**Both open numbers were measured on 2026-09-11 — § *Measured — the C experiment* carries them.** The ceiling scenario that would have killed C did not happen; the galaxy-creation delay is real and is the one cost C ships with.

⚠️ **An earlier draft of this entry priced personas at $0.10 each against a 50,000 cap.** That costed the variant where a persona takes its own LABEL (`{p}.{s}.{g}.{u}.…`), which needs one wildcard per Star. Compounded into the star's label, personas cost nothing. Do not re-inherit the old number.
