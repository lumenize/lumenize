# Nebula Enterprise Strategy — the Intrapreneur Expansion

> The enterprise play is the **expansion, not a second strategy**: same product, same secure-by-default wedge, different buyer, a later clock. Read [`strategy.md`](strategy.md) first — this doc only adds the enterprise-specific depth.

| | |
|---|---|
| **Status** | Living doc as of 2026-06-21. The expansion is *committed in direction, gated in timing* (see *Timing gates*). |
| **Audience** | Internal. A `/review-task` lens for any task touching enterprise/governance/multi-org concerns. |
| **Relationship** | Sibling of `strategy.md`. Where the two conflict, `strategy.md` wins — the wedge funds and proves the expansion, not the other way around. |

---

## The thesis: agentic building is the new shadow IT

Domain experts inside companies are **already** building apps on Replit, Lovable, and friends — bypassing IT and security entirely. That is shadow IT, 2026 edition. Enterprises are responding the way they always first respond: **enforcement**. And enforcement always fails, because *your best people always route around a ban.* You cannot stop a motivated domain expert from solving their own problem.

The resolution is never a better ban. It is a **sanctioned, secure way to do the thing they're already doing.** That exact arc is how "shadow IT" — developers provisioning their own cloud against policy — became cloud-native and DevSecOps: the org stopped fighting it and figured out how to do it securely, and the once-derided practice became the standard.

**Nebula is that move for agentic / citizen development.** Not "stop your people from building" — "give them the secure, governed place to build that you can actually stand behind."

**Founder-market-fit:** Larry authored the original DevSecOps manifesto. This is not pattern-matching the shadow-IT-gets-sanctioned arc from the outside — it's running it a second time, with the credibility of having run it the first time. That is a signal a competitor cannot manufacture.

---

## The buyer & the pain

- **Buyer** — IT / security / platform-engineering leadership. *Not* the builder. (The builder is the champion, not the purchaser.)
- **Champion** — the intrapreneur already using Nebula bottoms-up. The wedge produces the internal advocate for free.
- **Pain** — "My domain experts are shipping apps on tools I can't see, can't govern, and can't secure — and under strict-liability law (see `strategy.md` *Why now*) the org is now on the hook for what they ship."
- **Trigger event** — an incident, a failed audit, a procurement review, or the dawning realization that the enforcement memo isn't working.

The enterprise pitch is therefore not "build faster." It is **"convert your ungoverned shadow IT into a governed, secure, auditable estate — without fighting the people doing it."**

---

## Why land-and-expand, not enterprise-first

The dominant enterprise-SaaS pattern of the last 15 years — Slack, Dropbox, Figma, Notion, Datadog, GitHub itself — is **individual users adopt → the org buys to govern, secure, and scale it.** Selling the enterprise cold, before the model is proven, means long sales cycles, no reference customers, and building governance surface no real user has validated. The intrapreneur wedge supplies warm champions, live proof, and references as a *byproduct* of the self-serve motion. We let the wedge grow into the enterprise; we do not stand up a parallel enterprise org to chase it early.

---

## The incumbent objection — "we already have Power Apps"

The "sanctioned citizen development" budget line has owners: **Microsoft Power Platform** (already on the E5 agreement, already with SSO/DLP/audit), with Retool, Airtable, Mendix, and OutSystems adjacent. The buyer we describe *will* ask "why not Power Apps?" — answer it before they do:

- **They were built pre-agentic and are struggling to retrofit.** Their paradigm is forms-over-tables plus per-connector plumbing; the AI story is a bolted-on copilot over that old model — and bolted-on AI is exactly the leak surface (`strategy.md`, EchoLeak). Nebula is agentic-native: the chat *is* the builder, and the same access substrate governs it by construction.
- **Domain experts don't choose them.** Steep learning curves aimed at IT-adjacent builders, expensive per-seat enterprise licensing, top-down procurement. The revealed preference is the whole point of the shadow-IT thesis: when your best people route around the ban, they route to Replit and Lovable — *not* to the Power Apps license the org already owns. Governing the tool nobody voluntarily uses governs nothing.
- **The ceiling is internal tools.** They produce forms and dashboards for employees, not real multi-tenant, revenue-capable SaaS with external end users — the intrapreneur building a product (or the solopreneur building a business) can't get there on them.
- **The motion is inverted.** They're bought top-down and pushed down; Nebula lands bottom-up — the Slack/Jira arc — with a champion already inside.

**Discipline:** never fight Power Platform on governance-checkbox count early — theirs is mature and ours is deliberately gated (*Timing gates* below). The pitch is not "better governance than Microsoft"; it is **"your people already chose agentic tools; govern the thing they actually use."**

---

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
- **Homogeneity vs. residency — direction pinned 2026-07-02, mechanics open.** The moat is uniformity of the *substrate*, not of the *region*: regional cells running the identical substrate (Cloudflare's data-localization / jurisdiction controls are the mechanism) answer data-residency demands without forking the security model. VPC / on-prem remains a real **no** — that's the garden boundary, and some procurement will walk over it. Open mechanics: which certifications and regions gate which deals, and whether a cell is per-jurisdiction or per-customer.
- **The exit story.** Platform-risk and lock-in objections are far sharper in enterprise procurement than for a solopreneur. What is the credible migration/portability answer?
