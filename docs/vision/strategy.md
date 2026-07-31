# Nebula Product Strategy

> **Nebula is where domain experts build secure SaaS apps — and get paid.**

| | |
|---|---|
| **Status** | Living doc — current strategy as of 2026-06-21. Update in place; note material pivots with a dated line. |
| **Audience** | Internal. Also a `/review-task` product-vision lens — tasks that optimize against the checks below should get flagged. |
| **Scope** | Nebula the SaaS platform. The MIT packages (Mesh and friends) are the substrate, not the subject. |
| **Convention** | This doc, `enterprise.md`, and `self-improving-platform.md` are **dual-purpose** (VC pitch / leave-behind **and** the `/review-task` lens). Files in this folder prefixed `_` (e.g. `_review-lens.md`) are **internal-only** — they feed the review lens but are **not** part of the external narrative. Ignore `_`-files for the deck. `deck-workplan.md` is a third kind: the internal pitch-process gap list for the CEO — not a leave-behind, not a lens. |

The macro thesis is that AI is the earthquake creating fissures that the traditional software development factory and roles are collapsing into, and at the same time creating new higher ground for the rise of the solopreneur/intrapreneur. 

---

## The positioning, in one line

**Nebula is where domain experts build secure SaaS apps and get paid.**

Three load-bearing words, none optional:

- **Secure** — security is the default, not a feature you remember to turn on; the same access control even governs the built-in end-user-facing AI chat, so it answers only from data the user may already see. This is the wedge (see *Why now*).
- **SaaS apps** — real products with real end users, not toys or demos. The unit of value is a deployed, multi-tenant, revenue-capable application.
- **Get paid** — the builder can charge their customers. This is the motivator that outlasts novelty, and it's what makes Nebula a *business platform* rather than a hobby gallery.

The persona is always the **user-developer**: a solopreneur or intrapreneur who is a *domain expert*, who may not be an experienced coder. Never "vibe-coder."

**Which word does which job — committed 2026-07-02 (formerly an open question):** **get paid** (plus agentic speed) is the *acquisition hook* — it's why a builder shows up, because solopreneurs choose tools on outcome, not on liability fear. **Secure** is the *trust moat* — why they stay, why their end users pay, and the entire enterprise expansion. The **coach loop** (see *The coach in the loop* below) is the *conversion layer* in between — how a domain expert who showed up for the outcome actually gets to a shipped, paying app. Don't pitch security as the reason to sign up; pitch it as the reason you can charge money on day one and never look back.

---

## Why now

The agentic-build space is a red ocean (Replit, Lovable, Cursor, v0, Bolt, Claude, …), all converging on integrated deployment. Differentiating on "agent builds your app" is a losing feature war against better-funded incumbents.

**The wedge is that those apps aren't secure.** The tools reliably generate a working UI — and ship it wide open. The failure compounds at every layer:

- **Authentication** — independent scans find most vulnerabilities in vibe-coded apps are reachable with no authentication at all. ([Escape.tech](https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/), 5,600+ apps, 2025.)
- **Access control** — missing row-level security is endemic: Lovable's [`CVE-2025-48757`](https://nvd.nist.gov/vuln/detail/CVE-2025-48757) (CVSS 9.3) let anyone read and write arbitrary tables, and one [scan](https://mattpalmer.io/posts/cve-2025-48757/) found **170 live projects** leaking emails, phone numbers, payment data, and API keys.
- **The agentic layer** — the rung no one has solved: there's no reliable way to stop an AI assistant from answering with data the asking user shouldn't see. [OWASP's LLM Top 10](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) states there is *no fool-proof prevention* for prompt injection; benchmarks find no built-in defense fully blocks exfiltration; and it has already shipped — [`CVE-2025-32711`](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711) ("EchoLeak") was a **zero-click** leak from *Microsoft 365 Copilot*, the most heavily-resourced AI product on earth.

If Microsoft can't bolt this on safely, a domain expert on Replit can't either. Secure-by-default is the wedge because the entire field is insecure-by-default — and the agentic rung is one nobody else is even structurally attempting.

**And the cost of that insecurity just went up.** Two shifts turn an insecure app from an embarrassment into an existential risk for the builder:

1. **The liability regime is turning against the shipper.** The EU Product Liability Directive (2024/2853, member-state transposition due Dec 2026) extends strict product liability to software, the Cyber Resilience Act adds security-by-design obligations, and NIS2 adds personal executive liability. The exact reach into pure SaaS is still being transposed and tested — but the direction is one-way: "reasonable and customary practice" is eroding as a shield, and the domain expert who ships is exposed in a way they weren't three years ago.
2. **Attacks run at machine speed.** Autonomous exploitation agents now work the application/API/auth layer — exactly the surface these generated apps leave open — at a speed and cost that makes every exposed app worth probing. *(Deck discipline: any specific success-rate number used externally must carry a citation — the widely-repeated ones don't survive sourcing.)*

A domain expert building their own SaaS app cannot personally secure it, and the law no longer forgives them for failing to. **Nebula's answer: they don't have to.** The platform's substrate — relationship-based access control woven into the data model, a secure-by-default node core, lossless data handling, non-destructive versioned storage, and correctness under concurrency and retries — makes the *default* app a secure app. That is a claim our competitors structurally cannot make, because they let you deploy anywhere and write arbitrary server code.

### The substrate, in plain English

- **Every piece of data knows who may see it.** Relationship-based access control is woven into the data model itself, not checked at the edges — and the built-in AI chat inherits it automatically (the agentic rung, below).
- **Nothing is ever silently destroyed.** Every change is a new version; full history and a "who changed what, when" audit trail are properties of the storage model, not a logging feature someone must remember to add.
- **Concurrent edits can't silently clobber each other, and retried requests can't double-apply.** Correctness under failure is the default, not an advanced setting.
- **Data survives the wire intact.** No lossy translation layers between client, network, and storage — the seams where type confusion (a classic vulnerability source) creeps in.
- **Every node speaks through one guarded core.** There is exactly one implementation of "receive a call, verify who's calling, enforce what they may do" — new capabilities compose it; nobody hand-rolls their own security check.

Each of these is pinned as an **Architecture Decision Record** — a short written commitment that our automated review process checks every piece of work against, so the guarantees can't erode one convenient exception at a time. *(Internally: ADR-002, -004, -005, -007 in `docs/adr/`; the `/review-task` lens reads them in full.)*

**Secure *and* agentic — one claim, not two.** That last rung — the agentic one — is the one Nebula closes by construction. Every app ships with a chat that lets end users query their own data in natural language, and the same ReBAC/DAG substrate that secures the app governs what that chat can read, so it answers only from data the user already has access to. Everyone else bolts AI on after the fact and the model sees more than the user should; here, an AI that **can never read what the asking user can't read** is the default, not a hardening project. (State the claim exactly that way — it is the bounded, defensible one. Prompt injection can still misuse data *within* the user's legitimate scope; what the substrate guarantees is that the blast radius of any such attack is capped at what that user could already see. "An AI that can't leak," unqualified, is an absolute a CISO-grade reviewer will break.)

**Least-privilege without the quality tax.** The obvious objection — if the AI only sees what the user may see, aren't its answers worse than one that sees everything? — has two answers. First, DAG-based ReBAC makes the user's *legitimate* reach precise rather than coarse: they automatically get everything their relationships entitle them to, so the model rarely lacks data it should have had. Second, when an answer would be materially better with data the user *can't* yet see, the system doesn't silently degrade — it routes a just-in-time access request to whoever holds that grant authority up the org tree (the [access-request flow](enterprise.md)), turning the security boundary from a wall into a governed, auditable membrane. Secure-by-default and best-answer stop being a tradeoff — which is the part competitors with no real access model can't follow.

### Independent corroboration — YC's Fall 2026 RFS (added 2026-07-31)

Y Combinator's [Fall 2026 Requests for Startups](https://www.ycombinator.com/rfs) names **A Cloud for Small Software** (Pete Koomen, YC group partner) as a category it wants funded, and its framing is ours: this class of software is now easy to *build* and still hard to *deploy and share*, because the incumbent clouds were designed for software that scales to many users and charge complexity for it — so a cloud designed for the small case could delete most of that complexity.

The load-bearing part for us is the **hard problems it names**. The RFS lists three, and two are precisely what Nebula's substrate exists to solve: that *"auth & permissions are hard"*, and that letting nontechnical users share arbitrary code is hard to do securely. That is an investor-side statement, arrived at independently of us, that the bottleneck under agentic building is the access model and the safe-sharing boundary — *The substrate, in plain English* above, and the walled garden below. The third named problem — every company wanting to customize the environment its software runs in — is the **garden ceiling**, stated by someone with no stake in our answer to it; we take that trade deliberately (see *Honest about the ceiling*).

⚠️ **Two disciplines before using this externally.**

1. **It corroborates the infrastructure thesis, not the positioning.** YC's small software is *bespoke tools with one or a handful of users*; our unit of value is a multi-tenant, revenue-capable app (*What we are NOT*). Cite the RFS for "the category is real and its named hard problems are ours" — never let it pull the product toward internal-tools-for-one-team, which would undercut the get-paid crown jewel.
2. **Security is not that RFS's headline** — it appears as a hard *sub*-problem beneath a deployment-simplicity headline. That is independent confirmation of our own wedge sequencing (*The positioning*, committed 2026-07-02): builders show up for the outcome and the speed; secure is why they can charge money and stay. Read it as evidence *for* that ordering, not as evidence the wedge is wrong.

---

## Segments & sequencing — one wedge, two buyers

Nebula is **one product with one wedge (secure-by-default), sold to two buyers in sequence** — not two strategies.

- **Now: the self-serve wedge.** Solopreneurs and intrapreneurs — the same domain-expert persona — adopt Nebula bottoms-up to build a secure app, ship it, and get paid. An intrapreneur is just a solopreneur with an employer.
- **Later: the enterprise expansion.** Once the model is proven and mature, the enterprise *buys* — to govern, secure, and scale what its people are already doing on Nebula.

This is the dominant enterprise-SaaS pattern of the last 15 years — Slack, Dropbox, Figma, Notion, Datadog, GitHub itself: **individual users adopt → the org buys to govern, secure, and scale it.** The bottoms-up motion *is* the enterprise land motion; intrapreneurs are the wedge into their own companies. We don't run a separate enterprise play — we let the wedge grow into one.

**Why the expansion eventually dwarfs the wedge:** enterprises already know their domain experts are building on insecure tools (Replit, Lovable, …) and that enforcement fails — the best people always route around a ban. The resolution is never a better ban; it's a *sanctioned, secure way to do the thing they're already doing*. That is the arc that turned "shadow IT" into cloud-native and DevSecOps. Nebula is that move for agentic/citizen development. (Full thesis, buyer, and timing gates: [`enterprise.md`](enterprise.md).)

**Sequencing discipline:** the enterprise-governance surface (SSO, audit logs, admin/org controls, compliance) is **gated behind a proven self-serve wedge.** Building it early is the same premature-investment error as shipping density-dependent features before there's density. The expansion is real and probably the larger market — but it is an *expansion*, not a parallel track competing for focus today.

---

## The coach in the loop — how a domain expert actually ships

Every citizen-development thesis has the same credibility hole: most non-coders stall, and the incumbent answer (templates, docs, community forums) doesn't unstall them. Nebula's answer is structural: **the agentic chat where the user-developer builds is multi-participant by construction.** A human coach can join that chat at any moment, see exactly what the builder is struggling with — full context, no "can you describe the problem" — and unblock them in place.

⚠️ **The mechanism is general; the coach is one use of it.** What's built is an open invitation: the builder invites whoever they need into the thread with Nebula — a coach, a designer, a subject-matter peer, a teammate — and **participation is a uniform floor** (post, subscribe, and trigger Nebula) rather than a coach-shaped support channel with observers. Permissions *above* that floor still vary per person; participation itself does not. Say it that way round. Describing this as "a coach can join your chat" is how the capability gets undersold — it names the case instead of the thing, makes a general substrate sound like a service offering, and is the framing to correct on sight (the mechanics are pinned in [`nebula-galaxy-collapse-and-chat`](../../tasks/nebula-galaxy-collapse-and-chat.md)). The coach section that follows is about a *go-to-market motion* that rides this substrate — not about a limit on who may be in the room.

The coaching is nominally success-enablement, and it is that. But its primary value is that it is the **highest-bandwidth product-feedback loop available**: every intervention yields one of two concrete artifacts —

- a **workaround**, which is by definition a Nebula change proposal (the coach just proved the gap *and* the fix in a live session), or
- a **discoverability/learning gap** — the capability existed and the builder couldn't find it — a different, equally concrete class of product improvement.

Every product Larry has shipped has had this loop; it has been hard to sell in advance and decisive in practice every time. What's new is that the market just got a reference point: **Anthropic's Claude Tag** ([announced June 2026](https://www.anthropic.com/news/introducing-claude-tag)) is the same interaction model — one shared agentic chat, multiple humans, anyone can see the work and pick it up where the last person left off — and Anthropic reports tagging Claude is now one of the main ways it gets its own work done (~65% of its product team's code, per the announcement). Claude Tag targets small teams, so it lands slightly off our solopreneur center — but it maps one-for-one onto the coach-joins-your-chat mechanic, and it carries over *directly* to the **intrapreneur working inside an enterprise team**, which is precisely the expansion persona ([`enterprise.md`](enterprise.md)).

**A second, independent reference point — and this one is investor-side (added 2026-07-31).** Y Combinator's [Fall 2026 RFS](https://www.ycombinator.com/rfs) asks for **Multiplayer AI** (Aaron Epstein, YC group partner): anyone on a team should be able to drop into the same live agent session, watch it work, redirect it, and hand it off. Note what is being asked for — *anyone*, and full participation (redirect, hand off), not a spectator channel. That is our participation floor, described by someone who has never seen Nebula. Three things follow. First, it retires the "will anyone want more than one human in the agent chat?" objection — a vendor (Anthropic) shipped it and an investor is asking to fund it, which is a stronger pair than either alone. Second, it is direct support for the 2026-07-19 substrate decision below: shared-thread-by-construction is where the category is going, so building the single-participant version first would be building the thing we'd have to tear out. Third — and this is the one to hold onto — **the match is to the general invitation, not to coaching.** A doc (or a demo) that presents this as "a coach can join" understates what is built and reads as a support feature; the RFS is asking for the uniform thing we already pinned. **Positioning discipline is unchanged** — this is evidence about the *substrate*, and we still do not sell team collaboration (*What we are NOT*).

**What this changed — the substrate, not the positioning (updated 2026-07-19).** Anthropic's number is precisely why the chat is **multi-participant from day one** rather than something team collaboration inherits later: Nebula + the owner + a coach + an invited collaborator share one thread **pre-alpha**. That substrate is now core, and we will not ship the single-participant version. The **positioning is unchanged**: the persona is still the ~90%-solo user-developer, we do not sell team collaboration, and we do not build density-dependent features before single-player value exists. Hold that distinction — *more than one human in the chat* is the intended design, not a scope violation.

Economically, coaching is a scale question (human touch doesn't scale like software), and that's fine at wedge stage: the coach loop is how the wedge *converts and compounds* while the platform is young, not a permanent COGS line — over time the same feedback loop trains the platform's own agents, docs, and defaults — the compounding *self-improving-platform* moat ([`self-improving-platform.md`](self-improving-platform.md)). (Coach economics is a research item in `deck-workplan.md`.)

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

**"Why won't the platform beneath you just do this?"** Because the moat is not the deploy target — it's the substrate (*The substrate, in plain English*, above) — years of opinionated engineering that exists *because* we refuse arbitrary server code. Cloudflare sells neutral primitives to developers; Nebula sells an opinionated app platform to domain experts — different customer, different product DNA. Cloudflare Workers infrastructure is our substrate, not our competitor: they win when we win. And the agentic-builder incumbents (Replit, Lovable, …) can't follow without first abandoning deploy-anywhere and arbitrary server code — i.e., breaking their core promise to their existing base — and then rebuilding this substrate from scratch.

---

## Three flywheels — know which one is the business

A recurring strategic error is conflating these. They are different network effects and the first does **not** spin the third.

| Flywheel | Mechanic | Role for Nebula |
|---|---|---|
| **Builder → builder** | fork / remix / shared components / lineage | *Acquisition & inspiration.* Long-tail (most artifacts are never forked). Real, but not the business. |
| **Builder → user** | a builder's app reaches paying end users | **This is the business.** Two-sided marketplace: payments, payouts, trust, discovery, distribution. Where "get paid" lives. |
| **User → user** | the apps themselves are social | Only matters for apps that happen to be social. Not a platform-level effect. |

The crown jewel is **builder → user**: a domain expert builds a SaaS app and *reaches paying customers* on a secure substrate. Remix and discovery (builder → builder) are an acquisition mechanic feeding that marketplace — not a substitute for it.

Two mechanics attach to the crown jewel:

- **Commerce enforces security — "get paid" and "secure" are one motion.** The moment an app charges real customers, its security stops being optional: paying end users demand it, and the payment rails police it (processors like Stripe suspend merchants who get breached). A solopreneur cannot pass that bar alone; the substrate passes it for them. Secure-by-default is what makes "get paid" *sustainable* — the wedge and the crown jewel are the same product, not two features.
- **Every deployed app is distribution (the powered-by loop).** A builder's app reaches end users who are themselves potential builders — they can see it runs on Nebula and remix it into their own app (safely, per the walled-garden section). This is the Shopify/Calendly-style loop that feeds builder acquisition off the back of builder→user success, without making the product a social network.

### Sequencing: single-player value first

Community and discovery are an *outcome* of density, never a shortcut to it — they accrue only once the platform is full of apps worth finding. Three disciplines follow:

- **Single-player value first.** Nebula must be the best place to build a secure, paying SaaS app *even if you are the only user on it* — DX, security, the agentic loop, getting paid. Everything network-effect-driven comes after.
- **Density-dependent features ship late.** Leaderboards, trending, collections, hackathons are worthless empty and *signal failure* when empty — not early bets.
- **Anti-slop is a day-one constraint.** Agentic generation drives creation cost to ~zero, so discovery is a spam-filtering problem from the first week; any ranking or reputation signal must be hard to game and actually mean something.

---

## What we are NOT

- **Not a deployment-flexibility play.** "Deploy anywhere" is the opposite of our moat.
- **Not a social-network play.** Remix and discovery are an acquisition funnel, not the product; forks and "trending" are not success metrics — retained, user-developers producing money-making apps are.
- **Not collaboration-*sold*.** The persona is still ~90% solo user-developers: we don't market team collaboration, and we don't build density-dependent features (team billing, seat management, org-chart UI) before single-player value exists. But the **multi-participant chat substrate is core and ships pre-alpha** — see *The coach in the loop*. A shared thread is how the work actually gets done; that is substrate, not positioning.
- **Not a toy gallery.** The unit of value is a deployable, revenue-capable SaaS app.

---

## Strategic checks (the `/review-task` lens)

Flag a task that:

1. **Trades away security defaults for flexibility, speed, or AI answer quality** — the wedge is secure-by-default; if the AI needs more data, the answer is just-in-time elevation up the org tree, never broader default access. A footgun is a strategy violation, not just a bug.
2. **Optimizes a vanity metric** (forks, trending, stars) as if it were the business, or builds density-dependent features before single-player value exists.
3. **Sells to teams, or builds density-dependent collaboration features** (team billing, seat management, org-chart UI, presence for its own sake) **before single-player value exists** — the persona is still the ~90%-solo user-developer. ⚠️ **Multi-participant chat is NOT this check** (updated 2026-07-19): a shared thread carrying the owner, a coach, an invited collaborator, and Nebula is the intended pre-alpha design. Flag the *business* assumption, never the *substrate*.
4. **Weakens the "get-paid" path** — anything that makes it harder for a user-developer to reach or charge end users undercuts the crown-jewel flywheel.
5. **Erodes homogeneity** — special-casing, escape hatches to "deploy elsewhere," or per-app infrastructure divergence dissolves the moat.
6. **Treats discovery as a someday problem** — adds publishable artifacts without an anti-slop/quality story.
7. **Builds enterprise-governance surface before the wedge is proven** (SSO, audit, admin/org controls, compliance) — the enterprise expansion is gated behind a proven self-serve wedge (see [`enterprise.md`](enterprise.md)); premature enterprise build is the same error as premature social features.

---

## Open questions

- **Monetization mechanics — designed, release-gated, not yet written down.** The architecture is largely worked out and external launch is gated on it (we do not release without the get-paid path). What remains genuinely open: discovery — *getting end users to find and pay for a stranger's agentic app* — and the operational tail (refunds, fraud, taxes). This is the next sibling vision doc to write (`monetization.md`), and the deck needs its hypothesis-grade business-model slide now (see `deck-workplan.md`).
- **Anti-slop / durable reputation.** What makes a ranking or reputation signal meaningful when output is machine-generated and near-free to produce?
- **The garden ceiling.** Where exactly is the line between "secure sandbox" and "too constrained to build anything valuable"? The Dynamic Worker sandbox story (governed external connectivity) is the current answer — its limits define the addressable app space.
- ~~**Wedge sequencing.**~~ **Resolved 2026-07-02** — committed in *The positioning* above: get-paid (+ agentic speed) is the acquisition hook, secure is the trust moat, the coach loop is the conversion layer between them.

---

*Add sibling vision docs under `docs/vision/` as the strategy decomposes (e.g. `monetization.md`, `discovery-and-trust.md`). Each becomes another `/review-task` lens.*
