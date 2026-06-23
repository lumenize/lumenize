# Enterprise governance — "practices, not policies" (parked, UNREVIEWED)

**Status**: parked 2026-06-22, **not reviewed by Larry**. Cut out of `docs/vision/enterprise.md` and moved here so the `/review-task` product-vision lens (which reads all of `docs/vision/*`) does **not** inject premature enterprise-governance requirements into current wedge-phase / Studio-dev tasks.

**Provenance**: written by a separate Claude session (not the enterprise.md author session). Notable that *two* independent sessions converged on this "practices over policies / guardrails over gates" framing — so it's plausibly worth keeping — but it needs Larry's eval before it goes anywhere. Evaluate when reviewing `enterprise.md` or when enterprise work actually begins. The gating guardrails ("don't build enterprise governance before the wedge is proven") remain in `enterprise.md`; only this prescriptive *how-governance-works* design was removed.

---

## Practices, not policies — guardrails over gates

A clean split keeps the governance tier both real and adoptable:

- **The platform secure-by-default substrate is the non-negotiable floor.** ReBAC/DAG access control, validation, and temporal integrity (ADRs 002/004/005) protect the end-user and are **never** lowered by any org configuration or any builder choice. Substrate-enforced governance (org-scoped access control, egress approval) inherits that hardness.
- **The org's agentic-build practices sit above the floor as advisory guidance with accountability.** Studio follows them by default and **never deviates silently** — any departure is surfaced to the builder and captured as a **documented, attributed exception** in the governance audit trail — while the builder retains the agency to proceed. The governance value here is **assurance and visibility**, not a hard block.

This is deliberate, and it is the lesson every durable DevSecOps program learns: **a hard gate gets routed around** — the very shadow-IT dynamic that brings people to Nebula in the first place (the thesis above; `strategy.md` *Why now*). So the practice layer is engineered to **win adoption by being the easy path**: a practice that imposes friction without a low-effort way to comply, or that obstructs a legitimate engineering improvement, is **revised or retired — not hardened.** Practices are continuously tested against real builder usage and evolve from that feedback. The payoff is a posture the org can stand behind that **keeps the activity governed rather than pushing it back to ungoverned tools** — by design a **light-touch, exception-based** model rather than a heavyweight gate.

**Founder-market-fit, run before.** This is the playbook Larry executed as head of Application Security at a Fortune 50 company: retire static, inward-facing policy in favor of continuously-evolving, dev-team-tested **practices** — to the point engineering adopted them as its own standard and held effective veto over anything that lacked an "easy button" or fought a legitimate improvement effort. The outward-facing assurance posture and this inward-facing practice model are complementary, not contradictory. (Extends the DevSecOps-manifesto founder-market-fit in `strategy.md`.)
