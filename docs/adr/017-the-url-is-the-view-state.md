# ADR-017: A Shared URL Reproduces the Sender's View

**Date**: 2026-07-29
**Status**: Proposed — the *principle* is Larry's, stated 2026-07-29 and held as a hard UI requirement for a decade+; the boundary and scope clauses below are new and pending his read.
**Deciders**: Larry
**Evidence**: `apps/nebula-studio-ui/src/App.vue` — `/app/{scope}` supplies `authScope`, `activeScope` starts equal to it and then diverges when a user "opens" a Star, and that divergence never reaches the URL; discovered 2026-07-29 while designing the admin-debug flow in `tasks/archive/nebula-mint-narrower-token.md`, where it breaks the support use case outright. [ADR-008](008-full-org-tree-visibility.md) (visibility ≠ capability — enforcement at the point of action) is what makes the decision safe; [ADR-012](012-global-profile-visibility.md) is the worked example of where the boundary is *permissive*.

## Context

Support, debugging, and collaboration all start the same way: *"here's what I'm looking at."* The cheapest possible carrier for that is the URL the person already has in their address bar — if it is complete. When it is not, every one of those flows degrades into a conversation ("which scope? which record? which tab?"), and the degradation is **invisible to the author**, because their own state was restored from component memory or `localStorage` and looked right the whole time.

That invisibility is why this needs to be a written commitment rather than a habit. The default reflex — for a competent contributor and for a fresh LLM session alike — is to hold view state in component-local state (`ref()`, `useState`), because it is fewer lines, every framework tutorial does it, and nothing fails. The cost appears later, in someone else's session, and gets paid by whoever is trying to help. It has been re-decided wrongly here repeatedly.

Nebula multiplies it. Studio does not just *have* a UI — it **generates** them, and its docs are written for the LLM doing the generating. A commitment here propagates to every app a user-developer ships; a Studio-only convention does not.

## Decision

**A URL one person shares must take the recipient to the same page *and the same view state*.** View state that changes *what you are looking at* belongs in the URL — the active scope, the selected record, the open tab or panel, filters, sort, pagination. State that merely reflects *what you are doing* does not: scroll offset, hover, focus, and unsaved input drafts stay out.

The test, when it is unclear: **would the sender be surprised that the recipient did not see it?** If yes, it is view state.

⚠️ **The URL names WHAT you are looking at. It never grants permission to look.** Authorization is re-evaluated for the recipient on arrival, exactly as for any other request — so a shared URL is safe to paste into a ticket, and a recipient without access simply gets denied. Concretely, the URL carries **no credentials, no tokens, and no personal data**. This is [ADR-008](008-full-org-tree-visibility.md)'s "visibility ≠ capability" applied to addressing: naming a resource is not access to it, and enforcement stays at the point of action.

⚠️ **The boundary is narrower than the reflex wants, and [ADR-012](012-global-profile-visibility.md) is the case that proves it.** A `profileId` in a URL is **fine**, even though it is an unguessable handle that grants something: what it grants is a person's PUBLIC display fields (`name`/`nickname`/`picture`) to an already-authenticated caller — the same tier `github.com/{user}` serves, which we say openly is public. `privateNotes` and email are not reachable with it; they sit behind `requireOwnerOrAdmin`, which a URL never confers. **Do not "harden" this** by inventing a non-capability alias to address profile views: that is friction against a deliberately-open surface (`.claude/rules/calibration.md` §1) and buys nothing real. The test is not *"does holding this value reveal anything?"* — it is ***"does it reveal anything that is not already public?"***

**Scope:** Studio, the Nebula UI, and **the codegen scaffold** — a generated app inherits this, so the scaffold and the docs Studio's LLM reads must produce URL-reflected view state by default.

**Mechanism is unspecified and swappable.** Path segments, query parameters, and their encoding are implementation; the commitment is the property. Whatever the mechanism, a view-state parameter is a **public, stable name** once shipped — shared URLs outlive releases.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Component-local state only** (status quo) | Cheapest to write and it never fails for the author — which is exactly the defect. The breakage is only visible to the person who receives the link, so it is never caught by the person who caused it. This is the state that produced the `activeScope` bug. |
| **`localStorage` / `sessionStorage` restore** | Solves a different problem — *your own* reload — and does nothing for sharing. Worse, it actively **hides** the defect: your scope survives your refresh, so nobody notices it was never in the URL. Complementary at best; never a substitute. |
| **Server-side view state behind a share id** | Works, but buys storage, a lifetime, and a garbage-collection question to solve what the URL solves for free — and it inverts the safety story: a share id is a *new* credential to protect, where a plain URL is safe precisely because it grants nothing. |
| **Put everything in the URL, including drafts and credentials** | Violates the boundary: credentials and personal data must not ride a URL (they leak via logs, referrers, and history — `.claude/rules/critical.md` already forbids logging `request.url` for exactly this reason). Unsaved drafts are also not view state; they are unsaved work. |

## Consequences

### Positive
- Support and debugging work **by construction** — "send me your URL" is sufficient, and it is the direct prerequisite for the admin-debug flow that `/mint-narrower-token` exists to serve.
- Deep links, browser back/forward, refresh, and bookmarks all behave without per-view effort.
- **Testable.** A test can navigate to a URL and assert the resulting view, instead of driving a click-path to reach it — cheaper and less brittle.
- Every generated app inherits it, so user-developers get shareable URLs without knowing this decision exists.

### Negative / mitigations
- URLs get longer, and every new piece of view state becomes a small API decision (a name that must stay stable). That cost is real and is the point — it is paid once, by the author, instead of repeatedly by everyone who receives a link.
- The boundary needs judgment at the margin. **An opaque identifier is not automatically a secret** — ask what holding it actually gets you, and compare that against what is already public, rather than reasoning from unguessability. The genuine exclusions are narrow and mostly obvious: session/refresh tokens, magic-link and invite tokens (which already ride URLs today as one-time *login channels*, not view state), API keys, and personal data.
