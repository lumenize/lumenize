# Nebula Product Strategy

> **Nebula is where domain experts build secure SaaS apps — and get paid.**

| | |
|---|---|
| **Status** | Living doc — current strategy as of 2026-06-21. Update in place; note material pivots with a dated line. |
| **Audience** | Internal. Also a `/review-task` product-vision lens — tasks that optimize against the guardrails below should get flagged. |
| **Scope** | Nebula the SaaS platform. The MIT packages (Mesh and friends) are the substrate, not the subject. |

This doc is downstream of the macro thesis in `docs/presentation-and-blog-drafts/The coming earthquake.md` (the AI-driven collapse of traditional software roles, the rise of the solopreneur/intrapreneur, and strict-liability law making security non-optional) and upstream of the architecture commitments in `docs/adr/`. Strategy is the *why* those ADRs serve.

---

## The positioning, in one line

**Nebula is where domain experts build secure SaaS apps and get paid.**

Three load-bearing words, none optional:

- **Secure** — security is the default, not a feature you remember to turn on. This is the wedge (see *Why now*).
- **SaaS apps** — real products with real end users, not toys or demos. The unit of value is a deployed, multi-tenant, revenue-capable application.
- **Get paid** — the builder can charge their customers. This is the motivator that outlasts novelty, and it's what makes Nebula a *business platform* rather than a hobby gallery.

The persona is always the **user-developer**: a solopreneur or intrapreneur who is a *domain expert*, who may not be an experienced coder. Never "vibe-coder."

---

## Why now

The agentic-build space is a red ocean (Replit, Lovable, Cursor, v0, Bolt, Claude, …), all converging on integrated deployment. Differentiating on "agent builds your app" is a losing feature war against better-funded incumbents.

Two structural shifts make **secure-by-default** the durable wedge:

1. **Strict liability is law.** The EU Product Liability Directive (2024/2853, effective Dec 2026) and the Cyber Resilience Act treat software as a product under strict liability — "reasonable and customary practice" is no longer a shield. NIS2 adds personal executive liability. When a domain expert ships a SaaS app, they are now *liable* for its security in a way they were not three years ago.
2. **Attacks run at machine speed.** Autonomous exploitation (Project Shannon-class, ~96% success in published results) targets the application/API/auth layer — exactly the surface a non-expert builder is least equipped to defend.

A domain expert building their own SaaS app cannot personally secure it, and the law no longer forgives them for failing to. **Nebula's answer: they don't have to.** The platform's substrate — the ReBAC/DAG access-control model, secure-by-default node core (ADR-007), structured-clone-everywhere correctness (ADR-002), temporal/non-destructive resources (ADR-004), optimistic-concurrency idempotency (ADR-005) — makes the *default* app a secure app. That is a claim our competitors structurally cannot make, because they let you deploy anywhere and write arbitrary server code.

---

## Segments & sequencing — one wedge, two buyers

Nebula is **one product with one wedge (secure-by-default), sold to two buyers in sequence** — not two strategies.

- **Now: the self-serve wedge.** Solopreneurs and intrapreneurs — the same domain-expert persona — adopt Nebula bottoms-up to build a secure app, ship it, and get paid. An intrapreneur is just a solopreneur with an employer.
- **Later: the enterprise expansion.** Once the model is proven and mature, the enterprise *buys* — to govern, secure, and scale what its people are already doing on Nebula.

This is the dominant enterprise-SaaS pattern of the last 15 years — Slack, Dropbox, Figma, Notion, Datadog, GitHub itself: **individual users adopt → the org buys to govern, secure, and scale it.** The bottoms-up motion *is* the enterprise land motion; intrapreneurs are the wedge into their own companies. We don't run a separate enterprise play — we let the wedge grow into one.

**Why the expansion eventually dwarfs the wedge:** enterprises already know their domain experts are building on insecure tools (Replit, Lovable, …) and that enforcement fails — the best people always route around a ban. The resolution is never a better ban; it's a *sanctioned, secure way to do the thing they're already doing*. That is the arc that turned "shadow IT" into cloud-native and DevSecOps. Nebula is that move for agentic/citizen development. (Full thesis, buyer, and timing gates: [`enterprise.md`](enterprise.md).)

**Sequencing discipline:** the enterprise-governance surface (SSO, audit logs, admin/org controls, compliance) is **gated behind a proven self-serve wedge.** Building it early is the same premature-investment error as shipping density-dependent features before there's density. The expansion is real and probably the larger market — but it is an *expansion*, not a parallel track competing for focus today.

---

## The walled garden is the moat (and its own ceiling)

Nebula is intentionally constrained:

- You deploy to Nebula. Full stop.
- Server-side code is limited and sandboxed (external connectivity runs in governed Cloudflare Dynamic Worker sandboxes — a future capability).
- The creative surface is the client side.

**Why the constraint is an asset:** homogeneity. Every app runs on the same secure substrate. That makes two things possible that fragmented competitors cannot cleanly do:

1. **Real one-click remix-and-run.** No "works on my infrastructure," no deployment-target fragmentation. Any app is deployable by anyone.
2. **Remix without inheriting risk.** Fork a stranger's app on any other platform and you inherit their security bugs and access-control mistakes. On Nebula, the substrate keeps a fork secure *even if the original author was careless*. "Remix without footguns" is the fusion of our two strengths — secure-by-default makes remixing **safe**, homogeneity makes it **trivial**.

**Honest about the ceiling:** the garden caps what can be built (the most valuable apps often need exactly the server-side flexibility we sandbox), and "you deploy to Nebula, full stop" *is* the platform-risk story competitors will tell. We accept this trade deliberately. Our bet is that the secure-default + get-paid value, for this persona, outweighs the lock-in objection — and that the homogeneity it buys is worth more than the flexibility it costs.

---

## Three flywheels — know which one is the business

A recurring strategic error is conflating these. They are different network effects and the first does **not** spin the third.

| Flywheel | Mechanic | Role for Nebula |
|---|---|---|
| **Builder → builder** | fork / remix / shared components / lineage | *Acquisition & inspiration.* Long-tail (most artifacts are never forked). Real, but not the business. |
| **Builder → user** | a builder's app reaches paying end users | **This is the business.** Two-sided marketplace: payments, payouts, trust, discovery, distribution. Where "get paid" lives. |
| **User → user** | the apps themselves are social | Only matters for apps that happen to be social. Not a platform-level effect. |

The crown jewel is **builder → user**: a domain expert builds a SaaS app and *reaches paying customers* on a secure substrate. Remix and discovery (builder → builder) are an acquisition mechanic feeding that marketplace — not a substitute for it.

### Sequencing: single-player value first

Community and discovery are an *outcome* of density, never a shortcut to it — they accrue only once the platform is full of apps worth finding. Three disciplines follow:

- **Single-player value first.** Nebula must be the best place to build a secure, paying SaaS app *even if you are the only user on it* — DX, security, the agentic loop, getting paid. Everything network-effect-driven comes after.
- **Density-dependent features ship late.** Leaderboards, trending, collections, hackathons are worthless empty and *signal failure* when empty — not early bets.
- **Anti-slop is a day-one constraint.** Agentic generation drives creation cost to ~zero, so discovery is a spam-filtering problem from the first week; any ranking or reputation signal must be hard to game and actually mean something.

---

## What we are NOT

- **Not a deployment-flexibility play.** "Deploy anywhere" is the opposite of our moat.
- **Not a social-network play.** Remix and discovery are an acquisition funnel, not the product; forks and "trending" are not success metrics — retained, paying user-developers are.
- **Not collaboration-first.** The persona is ~90% solo user-developers. Multi-user collaborative editing is, at most, a late and minor feature.
- **Not a toy gallery.** The unit of value is a deployable, revenue-capable SaaS app.

---

## Strategic guardrails (the `/review-task` lens)

Flag a task that:

1. **Trades away security defaults for flexibility or speed** — the wedge is secure-by-default; a footgun is a strategy violation, not just a bug.
2. **Optimizes a vanity metric** (forks, trending, stars) as if it were the business, or builds density-dependent features before single-player value exists.
3. **Assumes collaboration / multi-user as a primary persona** rather than the ~90%-solo user-developer.
4. **Weakens the "get-paid" path** — anything that makes it harder for a user-developer to reach or charge end users undercuts the crown-jewel flywheel.
5. **Erodes homogeneity** — special-casing, escape hatches to "deploy elsewhere," or per-app infrastructure divergence dissolves the moat.
6. **Treats discovery as a someday problem** — adds publishable artifacts without an anti-slop/quality story.
7. **Builds enterprise-governance surface before the wedge is proven** (SSO, audit, admin/org controls, compliance) — the enterprise expansion is gated behind a proven self-serve wedge (see [`enterprise.md`](enterprise.md)); premature enterprise build is the same error as premature social features.

---

## Open questions

- **Monetization mechanics.** "Get paid" imports App-Store/Shopify-grade infrastructure: payments, payouts, trust, refunds, fraud, taxes, and *getting end users to discover and pay for a stranger's agentic app*. This is the hardest unsolved piece and probably deserves its own vision doc.
- **Anti-slop / durable reputation.** What makes a ranking or reputation signal meaningful when output is machine-generated and near-free to produce?
- **The garden ceiling.** Where exactly is the line between "secure sandbox" and "too constrained to build anything valuable"? The Dynamic Worker sandbox story (governed external connectivity) is the current answer — its limits define the addressable app space.
- **Wedge sequencing.** Secure-by-default is the differentiator, but is it the *acquisition hook* (why a builder shows up) or the *retention/trust moat* (why they stay)? If the former, what gets them in the door before they care about liability?

---

*Add sibling vision docs under `docs/vision/` as the strategy decomposes (e.g. `monetization.md`, `discovery-and-trust.md`). Each becomes another `/review-task` lens.*
