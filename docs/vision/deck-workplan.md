# Pitch-Deck Workplan — gaps between the vision docs and a fundable deck

| | |
|---|---|
| **Status** | Working doc, created 2026-07-02 from an analyst review of `strategy.md` + `enterprise.md`. |
| **Audience** | Morgan (CEO / pitch process). Internal — **not** a leave-behind, **not** a `/review-task` lens. |
| **Relationship** | `strategy.md` + `enterprise.md` carry the narrative halves of the deck (Problem, Why Now, Solution, GTM arc, Moat, Founder). This file lists everything a deck needs that those docs deliberately don't contain — mostly research and numbers — plus the diligence-hardening pass. |

---

## Deck skeleton — what exists vs. what's missing

| Slide | Source | Status |
|---|---|---|
| Problem (insecure agentic apps + liability shift) | `strategy.md` *Why now* | ✅ Written, sourced |
| Why now (red ocean, wedge, machine-speed attacks) | `strategy.md` *Why now* | ✅ Written |
| Solution / demo (secure-by-default + bounded AI + coach loop) | `strategy.md` positioning + coach section | ✅ Written; needs the live demo asset (below) |
| Market size | — | ❌ Research (item 1) |
| Business model | `strategy.md` open questions (designed, release-gated) | ❌ Needs the hypothesis slide (item 3) |
| GTM (PLG wedge → enterprise expansion) | `enterprise.md` | ✅ Written |
| Competition / moat | `strategy.md` walled garden + `enterprise.md` incumbent objection | ✅ Written |
| Traction | — | ❌ Assemble (item 2) |
| Team & plan | — | ❌ Write (item 4) |
| The ask | — | ❌ Decide (item 5) |

## 1. Market sizing (TAM / SAM / SOM)

Three defensible approaches; a deck usually shows two that triangulate:

- **Top-down** — the low-code/citizen-development market plus the agentic-app-builder market (analyst firms size both); the "sanctioned citizen dev" budget line can be anchored on Power Platform's disclosed revenue.
- **Bottom-up** — (addressable solopreneurs + intrapreneurs) × platform ARPU, plus take-rate × projected builder GMV. This is the credible one for our stage; it also forces the pricing hypothesis (item 3).
- **Comparables** — Replit/Lovable disclosed ARR and valuations as trajectory anchors; Shopify as the take-rate economics anchor.

## 2. Traction slide

Pre-revenue, the demo **is** the traction: the loop is live end-to-end on deployed prod (`nebula.lumenize.com` — magic-link login → claim a Universe → agentic chat → a working generated app renders). To do:

- A tight (≤90s) recorded demo of that loop; investors forward videos, not repos.
- Roadmap position honestly stated: pre-alpha, friends-and-family invites next — and the first alpha user-developer already exists with a self-written spec (Jennifer; see item 4): [Luminize Almanac — product vision + functional requirements + data model](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit) and its companion [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit) (also Jennifer's, written for the intended designer).
- **Start capturing metrics now** so the next conversation has a curve, not a point: builders invited/activated, apps created, time-to-first-shipped-app, coach interventions per shipped app.

## 3. Business-model slide (hypothesis-grade is enough)

The architecture is designed and external launch is gated on it (per `strategy.md`); the deck needs the *hypothesis stated with conviction*:

- Structure: platform subscription + Shopify-style take-rate on builder revenue (exact numbers TBD — pick one worked example and show the unit economics for a single successful builder).
- The one-liner that fuses model and wedge: **commerce enforces security** — paying end users and the payment rails (Stripe suspends breached merchants) make secure-by-default the thing that keeps a builder's revenue on, not a checkbox.
- Coach economics: coaching is high-touch by design at wedge stage (it's the product-feedback engine, not just support — see `strategy.md`); the deck should frame the cost as paid product R&D that compounds into agents/docs/defaults, not a permanent COGS line. Research: what did the analogous loop cost/yield in Larry's prior products?
- Feeds `monetization.md` when written — that doc is the next sibling vision doc.

## 4. Team & plan

- Founder-market fit is already the strongest card (DevSecOps manifesto author, running the shadow-IT-gets-sanctioned arc a second time) — but a solo technical founder + CEO needs a **key-person answer and a hiring plan** (first 3–5 hires, sequenced against the milestones below).
- Current roles (strategy review panel = these three):
  - **Larry** — founder, product/tech.
  - **Morgan** — CEO; owns the pitch process, deal structuring, and the legal/diligence pass (item 6).
  - **Jennifer** — chief sanity checker on strategy; test-automation background (second most technical on the team); currently acting-CPO-ish — she wrote her own spec for her alpha-testing app ([Luminize Almanac](https://docs.google.com/document/d/1P_YF2qVwQSAFYvg43qCvj3Nc170zBkpBboG8kcjdBGc/edit)), which also makes her the **first user-developer** (see item 2: that spec-in-hand alpha builder is a traction artifact, not just a team fact).
- **Austen** (UX degree) is Jennifer's intended UX designer for the Almanac — the [UX brief](https://docs.google.com/document/d/10UZ5KaZJXG2MdaHTwA2UPGrFKM_daGDdJaSbg6wGeFo/edit) is Jennifer's doc written *for* her, and Austen hasn't engaged yet. **Not** a strategy reviewer; involvement tentative (full plate) — don't count her on the team slide or in plans.

## 5. The ask

Amount, use of funds, and what it buys. The milestone slide is nearly free: **the enterprise *Timing gates* in `enterprise.md` (paid wedge traction, independent security validation, reference champions, designed governance surface) ARE the milestones** — funding buys reaching them.

## 6. Diligence-hardening pass (legal review — Morgan's wheelhouse)

- **PLD / CRA / NIS2 claims** (`strategy.md` *Why now*): verify the softened phrasing survives a lawyer's read — especially PLD applicability to pure SaaS and CRA scope/timing. Direction-of-travel framing only; never "strict liability is law" unqualified.
- **Autonomous-exploitation stats**: any success-rate number used externally must carry a real citation; the widely-repeated ladder figures don't survive sourcing. Qualitative claim is currently in the doc; keep it qualitative unless a sourceable number is found.
- **The AI claim**: always the bounded form — "the AI can never *read* what the asking user can't read" — never "can't leak" unqualified (see `strategy.md`).
- **Claude Tag figures**: re-verify at deck time against [the announcement](https://www.anthropic.com/news/introducing-claude-tag) (currently: public beta 2026-06-23; ~65% of Anthropic's product team's code via their internal version).
- **Security validation**: an independent pen test of the secure-by-default claims is both an enterprise timing gate and a deck asset; scope/cost it early.

## 7. Third-party category validation — a free "why now" asset (added 2026-07-31)

Y Combinator's [Fall 2026 RFS](https://www.ycombinator.com/rfs) independently asks for two things we are building, which is a cheap credibility card for the deck (details and the citation discipline are in `strategy.md`):

- **A Cloud for Small Software** (Pete Koomen, YC group partner) — building is easy now, deploying and sharing is not; of the three hard problems the RFS names, two are our substrate (*auth & permissions*, and nontechnical users sharing arbitrary code securely).
- **Multiplayer AI** (Aaron Epstein, YC group partner) — anyone dropping into the same live agent session to watch, redirect, and hand off. ⚠️ **Demo this as the open invitation it is** — the builder invites whoever they need into the thread with Nebula, on a uniform participation floor. Presenting it as "a coach can join" names one use case, undersells a built substrate as a service offering, and misses the RFS, which asks for the general form.

**How to use it.** This answers the "is this a real category or a founder's hobby?" reflex without us asserting anything — the strongest form of that answer, since it comes from the investor side. Best placement is a supporting line on *Why now*, not a slide of its own; a deck that leans on someone else's RFS for its thesis looks derivative.

**How not to use it.** (a) YC's small software is bespoke tools for one or a few users; ours is multi-tenant and revenue-capable — cite it for the infrastructure thesis, never for the positioning. (b) That RFS's headline is deployment simplicity, with security as a sub-problem; that matches our committed wedge sequencing, but do not present it as YC validating *secure-by-default* specifically, because it doesn't. (c) The Fall 2026 application deadline (2026-07-27) has passed — this is deck evidence, not an open application.
