---
status: draft
status_dated: 2026-06-21
---

# Nebula Enterprise Strategy — the Intrapreneur Expansion

> The enterprise play is the **expansion, not a second strategy**: same product, same secure-by-default wedge, different buyer, a later clock. Read [`strategy.md`](strategy.md) first — this doc only adds the enterprise-specific depth.

| | |
|---|---|
| **Status** | Living doc as of 2026-06-21. The expansion is *committed in direction, gated in timing* (see § *Timing gates*). |
| **Audience** | Internal. A `/review-task` lens for any task touching enterprise/governance/multi-org concerns. |
| **Relationship** | Sibling of `strategy.md`. Where the two conflict, `strategy.md` wins — the wedge funds and proves the expansion, not the other way around. |

---

## The thesis: agentic building is the new shadow IT

Domain experts inside companies are **already** building apps on Replit, Lovable, and friends — bypassing IT and security entirely. That is shadow IT, 2026 edition. Enterprises are responding the way they always first respond: **enforcement**. And enforcement always fails, because *your best people always route around a ban.* You cannot stop a motivated domain expert from solving their own problem.

The resolution is never a better ban. It is a **sanctioned, secure way to do the thing they're already doing.** That exact arc is how "shadow IT" — developers provisioning their own cloud against policy — became cloud-native and DevSecOps: the org stopped fighting it and figured out how to do it securely, and the once-derided practice became the standard.

**Nebula is that move for agentic / citizen development.** Not "stop your people from building" — "give them the secure, governed place to build that you can actually stand behind."

**Founder-market-fit:** Larry authored the original DevSecOps manifesto. This is not pattern-matching the shadow-IT-gets-sanctioned arc from the outside — it's running it a second time, with the credibility of having run it the first time. That is a signal a competitor cannot manufacture.

**Corroboration of the ANSWER SHAPE — Cloudflare ran this play on itself (added 2026-08-05).** Cloudflare built [Cloudflare OS](https://blog.cloudflare.com/cloudflare-os/) — a sanctioned internal place for every employee to build apps and automate work, with mediated capability access instead of shared credentials — deployed it internally in May, then open-sourced it. **Weigh it for what it is.** As *demand* evidence it is weaker than the YC RFS below: N=1, a company of engineers on its own platform, and open-sourcing it drives Workers consumption, so a skeptical buyer discounts it as self-serving and not-like-them. Where it is uniquely strong is the **shape of the answer**: an investor saying the problem is real is a different claim from a sophisticated engineering organization, facing it internally, building precisely the sanctioned-secure-place answer this doc argues for rather than an enforcement regime. Cite it for *"this is what serious orgs build when they take it seriously,"* never for *"look how big the demand is."* ⚠️ It is also the sharpest competitive objection we face — see § *The newer objection* below; the same artifact does both jobs and the two readings must not be blurred.

**Third-party corroboration of the demand (added 2026-07-31).** The thesis above rests on an assertion — that domain experts inside companies are already building — and the enterprise pitch lives or dies on the buyer believing it. Y Combinator's [Fall 2026 RFS](https://www.ycombinator.com/rfs) makes the same assertion from the investor side, in **A Cloud for Small Software** (Pete Koomen, YC group partner): every team does things differently, and demand for bespoke tools — workflows, the numbers a team tracks, sprints, shared prototypes — is effectively unlimited; that software is now easy to build and still hard to deploy and share. That is our intrapreneur, described by someone with no stake in our framing, and two of the three hard problems the RFS names are our substrate (*auth & permissions*; nontechnical users sharing arbitrary code securely). Cite it precisely because it isn't us saying it — an IT buyer discounts our claim that their people are already building, and discounts it far less coming from a YC partner asking to fund the infrastructure.

---

## The buyer & the pain

- **Buyer** — IT / security / platform-engineering leadership. *Not* the builder. (The builder is the champion, not the purchaser.) ⚠️ **Skews smaller than the titles suggest** — the sweet spot is the org with *no platform team*, where this is a CTO or head of ops rather than a CISO. Reasoning in § *The newer objection* below.
- **Champion** — the intrapreneur already using Nebula bottoms-up. The wedge produces the internal advocate for free.
- **Pain** — "My domain experts are shipping apps on tools I can't see, can't govern, and can't secure — and under strict-liability law (see `strategy.md` *Why now*) the org is now on the hook for what they ship."
- **Trigger event** — an incident, a failed audit, a procurement review, or the dawning realization that the enforcement memo isn't working.

The enterprise pitch is therefore not "build faster." It is **"convert your ungoverned shadow IT into a governed, secure, auditable estate — without fighting the people doing it."**

**The invitation is the land motion (added 2026-07-31).** The build chat is multi-participant by construction: the builder invites whoever they need into the thread with Nebula, on a uniform participation floor (`strategy.md`, *The coach in the loop*). Inside a company the person invited is a **colleague** — so the champion expands the footprint by doing their ordinary work, and every collaborator pulled into a thread is account expansion nobody had to sell. YC's Fall 2026 RFS asks for this shape directly — **Multiplayer AI** (Aaron Epstein, YC group partner): anyone on a team dropping into the same live agent session to watch it work, redirect it, and hand it off. ⚠️ **This is substrate, not governance surface.** It does not move the § *Timing gates* below and it is not a reason to build seat management, team billing, or org-chart UI early (`strategy.md` check 3, and check 1 here). What it changes is only the GTM story: inside an account, seats grow through use rather than through a sales motion.

---

## Why land-and-expand, not enterprise-first

The dominant enterprise-SaaS pattern of the last 15 years — Slack, Dropbox, Figma, Notion, Datadog, GitHub itself — is **individual users adopt → the org buys to govern, secure, and scale it.** Selling the enterprise cold, before the model is proven, means long sales cycles, no reference customers, and building governance surface no real user has validated. The intrapreneur wedge supplies warm champions, live proof, and references as a *byproduct* of the self-serve motion. We let the wedge grow into the enterprise; we do not stand up a parallel enterprise org to chase it early.

---

## The incumbent objection — "we already have Power Apps"

The "sanctioned citizen development" budget line has owners: **Microsoft Power Platform** (already on the E5 agreement, already with SSO/DLP/audit), with Retool, Airtable, Mendix, and OutSystems adjacent. The buyer we describe *will* ask "why not Power Apps?" — answer it before they do:

- **They were built pre-agentic and are struggling to retrofit.** Their paradigm is forms-over-tables plus per-connector plumbing; the AI story is a bolted-on copilot over that old model — and bolted-on AI is exactly the leak surface (`strategy.md`, EchoLeak). Nebula is agentic-native: the chat *is* the builder, and the same access substrate governs it by construction.
- **Domain experts don't choose them.** Steep learning curves aimed at IT-adjacent builders, expensive per-seat enterprise licensing, top-down procurement. The revealed preference is the whole point of the shadow-IT thesis: when your best people route around the ban, they route to Replit and Lovable — *not* to the Power Apps license the org already owns. Governing the tool nobody voluntarily uses governs nothing.
- **Internal tools are their ceiling and our on-ramp.** They produce forms and dashboards for employees, not real multi-tenant, revenue-capable SaaS with external end users — the intrapreneur building a product (or the solopreneur building a business) can't get there on them. ⚠️ **Say it as a trajectory, never as a verdict on internal tools** — bespoke small-team software is an *underserved category* (that's the YC RFS above), it's how most intrapreneurs start, and it's the first thing anyone builds on us. Dismissing it contradicts our own demand argument and throws away the room's most common starting use case. The difference is where the artifact can go next: on Power Platform an internal tool stays one, because the product was built for forms-over-tables inside the org boundary; on Nebula that same app is already sitting on a multi-tenant, revenue-capable substrate, so acquiring an external user or a price is a change of circumstance, not a rebuild.
- **The motion is inverted.** They're bought top-down and pushed down; Nebula lands bottom-up — the Slack/Jira arc — with a champion already inside.

**Discipline:** never fight Power Platform on governance-checkbox count early — theirs is mature and ours is deliberately gated (§ *Timing gates* below). The pitch is not "better governance than Microsoft"; it is **"your people already chose agentic tools; govern the thing they actually use."**

---

## The newer objection — "Cloudflare just open-sourced this" (added 2026-08-05)

[Cloudflare OS](https://blog.cloudflare.com/cloudflare-os/) is free, modern, agentic-native, and from a company with real security credibility. It will come up, and "we're more secure" is the wrong answer — theirs is a good design for their customer. **The answer is operator burden, and it is the cleanest segmentation line we have:**

- **It is a kit you deploy and staff, not a product you buy.** You host it in your own Cloudflare account with your own Access policies, AI Gateway config, and integrations — and each external system needs a **Gatekeeper**, a Worker somebody writes and maintains, carrying that service's policy logic. So adoption presumes a platform team. ⇒ **Its natural adopter is an organization that could already have solved this.** It does nothing for the company of 60 — which is where the shadow-IT problem is *worst*, because there is no platform team to route around *to*.
- **Hand-written policy per service is the footgun we exist to remove.** A Gatekeeper written thinly is a wide-open one, and nothing warns you. That is the same objection we make to arbitrary server code (`strategy.md`, walled garden), landing in a new place.
- **It stops at the org boundary.** Everyone is an employee behind Cloudflare Access; there is no row-level or relationship-based control *inside* an app because there are no tenants to isolate. So it is subject to the same trajectory argument as Power Platform above: an internal tool built there stays one.
- **Its motion is top-down; ours is not.** Someone must *decide* to deploy Cloudflare OS, and roll it out. That is a platform-adoption event. Nebula arrives one intrapreneur at a time and the org buys later to govern what is already happening — this doc's whole land motion. The inversion argument we make against Power Platform gets **stronger** against a better competitor, not weaker.

**What this sharpens: the buyer skews smaller than this doc has been assuming.** The large end of the enterprise market is exactly the end most able to self-host a free kit. Our sweet spot is the organization with no platform team — where the buyer is a CTO, head of ops, or an IT lead rather than a CISO; procurement is a card rather than a nine-month cycle; and the governance surface that satisfies them is **lighter** than the SSO/SCIM/SOC 2/residency stack below. This is good news twice over: the expansion starts earlier and cheaper than a big-enterprise framing implies, and there is less to build.

⚠️ **This moves the buyer, NOT the gates.** A smaller buyer needing less surface is not permission to build governance surface early — § *Timing gates* below and `strategy.md` check 7 stand unchanged, and the smaller surface is an argument for building *less later*, not *something now*. ⚠️ It is also not a retreat from large enterprises; it is where the wedge lands **first**. The estate a big org eventually buys to govern is still the prize.

## What "the secure way" requires — the governance tier

The enterprise tier is **governance and assurance layered on top of the one secure-by-default core** — never a forked, separate security model. Concretely:

- **Visibility** — an inventory of what's been built, by whom, on what data. (You cannot govern what you cannot see.)
- **Governance** — org-scoped access control (the ReBAC/DAG model extends to org hierarchy naturally) and approval flows for outside-world connectivity (the Dynamic Worker / egress story).
- **Identity** — SSO, SCIM, directory integration.
- **Audit & compliance** — audit logs, data-residency controls, SOC 2 / ISO posture, and the evidence trail strict liability now demands.

**Structural advantage:** much of this rides on substrate Nebula *already has*. Nothing on Nebula is ever silently destroyed — every change is a new version — so the audit trail is a property of the data model, not a bolt-on *(internally: ADR-004)*. The ReBAC/DAG access model is the same machinery org-governance needs. The audit substrate is the product, not a feature we have to graft on later.

---

## Timing gates — what "proven and mature" means

Do **not** pursue enterprise sales until all of these hold:

1. **The wedge works** — a critical mass of *paid* solopreneurs/intrapreneurs actively building (self-serve retention + revenue, not signups).
2. **Security is provable to a CISO** — independent validation (pen test / audit) of the secure-by-default claims, not just our own assertion.
3. **Champions exist** — reference intrapreneurs inside real orgs willing to advocate internally.
4. **The governance surface is designed** — even if not fully built, the shape is known.

Until these hold, enterprise effort is premature investment and pulls focus from the wedge that funds it.

---

## Investor framing

- **The arrow, not two arrows.** "A PLG wedge that lands enterprise expansion" is the capital-efficient, large-ACV story investors reward — far stronger than "a solopreneur strategy *and* an enterprise strategy."
- **Founder-market-fit.** The author of the DevSecOps manifesto, riding the same shadow-IT-gets-sanctioned wave a second time.
- **TAM shape.** Self-serve proves the model and funds the climb; enterprise is where the market eventually dwarfs the wedge.
- **Strategic acquirers exist and are aligned.** Cloudflare is the natural one: Nebula is the up-stack proof of what Workers-for-Platforms-class infrastructure is *for* — an opinionated app platform for domain experts that Cloudflare doesn't build itself (different customer, different DNA; see `strategy.md`, walled-garden section). We build for independence; the acquisition path is a floor under the outcome, not the plan.

---

## Review checks (the `/review-task` lens for enterprise tasks)

Flag a task that:

1. **Builds governance/SSO/audit/admin surface before the timing gates are met** — the expansion is gated behind a proven self-serve wedge.
2. **Forks the security model** into a separate "enterprise" variant rather than layering governance on the one secure-by-default core.
3. **Treats enterprise as a parallel strategy** pulling focus from the self-serve wedge today.
4. **Weakens the intrapreneur self-serve on-ramp** (the champion path) in the name of top-down selling — the bottoms-up motion *is* the land motion.

---

## Open questions

- **Entry point & buyer title.** CISO, platform engineering, or line-of-business? The trigger event likely decides.
- **Pricing the governance tier.** Per-seat, consumption, or an org platform fee on top of self-serve?
- **Homogeneity vs. residency — direction pinned 2026-07-02, mechanics open.** The moat is uniformity of the *substrate*, not of the *region*: regional cells running the identical substrate (Cloudflare's data-localization / jurisdiction controls are the mechanism) answer data-residency demands without forking the security model. VPC / on-prem remains a real **no** — that's the garden boundary, and some procurement will walk over it. Open mechanics: which certifications and regions gate which deals, and whether a cell is per-jurisdiction or per-customer. **Useful framing found 2026-07-31:** the third hard problem YC's RFS names in this category is that every company will want to customize the environment its software runs in — i.e. our sharpest enterprise objection is a *category-wide* unsolved problem that an investor named independently, not a Nebula defect. Everyone selling into this space owes an answer; ours is regional cells on the identical substrate plus governed sandboxes. That reframes the procurement conversation from "you can't do what the others do" to "here is our answer to the thing nobody has solved" — it does **not** make the answer sufficient, and some deals still walk.
- **The exit story.** Platform-risk and lock-in objections are far sharper in enterprise procurement than for a solopreneur. What is the credible migration/portability answer?
