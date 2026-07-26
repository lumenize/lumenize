# Profile linking — recognizing one human under two email addresses

**Status:** ON HOLD (2026-07-19). ⏳ **Resume trigger: a real human presents two different email addresses across scopes and wants them merged.** Until then the interim convention is **one email per human** — which is sufficient, because same-email-any-scope is already handled by [nebula-auth-identity-mint.md](../nebula-auth-identity-mint.md) §3 (email match at `getAndVerifyIdentity`, on first proof of the mailbox).

⚠️ **The design below is NOT settled spec — it is broken in three independent ways** (found by the `/review-task` framing panel, 2026-07-19, and verified against source). It is preserved as a starting point, not a plan. Anyone resuming this **redesigns**; they do not implement.

## What it is for
The one case the server cannot see: **different email, same person, same browser**. Same-email-across-scopes is linked at first verification. A manual **merge-profiles** feature is the fallback for everything else (different browser, cleared cookie) and remains unbuilt.

**Not a use case:** plus-addressed test aliases (`larry+*@lumenize.io`) exist to *simulate different people*. Those **should** stay separate profiles. An earlier draft cited them as motivation — that was wrong.

## Settled rails (carried forward — do not violate on redesign)
- The breadcrumb cookie is **advisory ONLY — never an input to the link decision** *(pinned 2026-07-13, re-affirmed 2026-07-19)*. Signing narrows *forgery*; it never establishes *control*.
- **Linking proves control of BOTH identities.** A confirm modal alone is not proof — an attacker clicks yes.
- **Shared/kiosk-browser identity contamination** is the failure mode these rails exist to close.
- **Never link silently.** Austen logs in (breadcrumb = X) → Bob accepts an invite in the same browser → without proof, Bob's profile re-points into Austen's populated one. Auto-heal corrects the cookie's *value* going forward but does **not** undo the merge.
- Cookie mechanics if one is used: `Path=/` set **explicitly**; `SameSite=Lax` (the magic-link click is a cross-site top-level navigation — `Strict` would withhold it); host-only; JS may write it **only** to clear it ("not me").

## 🔴 Why the previous design does not work
**1. The write destroys the input the read depends on.** The cookie was to be set in `consumeAndLogin` ([worker-token.ts:145](../../packages/nebula-auth/src/worker-token.ts)) — a bodiless 302 committed *before* any SPA JS runs — single-valued and overwriting. By first paint the "candidate" **is** the current profile, always. Nothing captured the prior value, so the offer can never fire. A redesign must specify capture explicitly (read the inbound `Cookie`, compare old vs new, and carry the prior `{profileId, scope}` on a channel that is **not** a URL query param — security.md).

**2. The proof was forgeable, and forgeably by design.** The plan read "a valid access token with `profileId === candidate`" as proof of control. It is not: `handleDelegatedToken` ([worker-token.ts:344](../../packages/nebula-auth/src/worker-token.ts)) deliberately mints act-for tokens carrying **the target's `profileId`** for any admin caller. Accepting that as proof reopens the admin→global-profile takeover that the identity-mint task's §5 exists to close. And the forgeable reading was **forced**: the refresh cookie is `HttpOnly` + `Path`-scoped, so a client can forward nothing *but* the minted token. A redesign must verify the candidate's **refresh cookie server-side** (the `hashString`→KV lookup `handleRefreshToken` uses) — which means the endpoint has to live where that cookie is sent. ⚠️ One request cannot carry two differently-path-scoped cookies, and the router's authenticated path ([router.ts:228](../../packages/nebula-auth/src/router.ts)) verifies exactly one Bearer against one `instanceName` — so a cross-scope two-proof endpoint **does not fit the existing shape**. That is the core problem to solve.

**3. The re-point re-splits the human it merges.** `UPDATE Identities SET profileId=?` carried no `WHERE`, and convergence was per-`sub` (`RefreshTokenIndex WHERE sub=?`) — transposing `setIdentityAdmin`'s correctly-per-sub writer onto an operation whose unit is a **profileId set**. `idx_Identities_profileId` is non-unique precisely because a `profileId` spans 1..N `sub`s. Correct form: `UPDATE Identities SET profileId = <surviving> WHERE profileId = <losing>`, then converge the KV refresh records for **every** affected `sub`, each re-applying its **original absolute expiry**.

## Also carried here
- **The `Path=/` container-cookie hazard** — this exists *only because* a root-path platform cookie is introduced; it is a consequence of the design, not an independent requirement. `/dev-container/*` is `run_worker_first` on the same origin, and `LumenizeContainer.fetch` forwards the request after `stripContainerTargetPort` (which strips only that one header), so a `Path=/` cookie would reach the container serving LLM-generated code. If a root-path cookie is ever introduced, **scrub platform cookies at that same seam**. Invariant regardless: **never forward platform cookies into user-controlled code or the container.**
- **Convergence matters for attribution**, not just correctness: under the ADR-013 amendment the `profileId` claim is stamped as *permanently immutable* attribution, so a stale claim minting for up to `REFRESH_TOKEN_TTL` (~30 days, no rotation) permanently mis-attributes every message posted in that window.
- **Deferred alternatives** if a live-session proof proves insufficient: a magic-link round-trip to the candidate's email, or parking the candidate and asking from its own next session.

## Relationships
- **Depends on** [nebula-auth-identity-mint.md](../nebula-auth-identity-mint.md) §3 (`profileId` join at verification) — this is the *remainder* of that model, covering only the case email-match cannot see.
- **Would supply** the collapse task's blocking profile-completion modal with a second branch ([nebula-galaxy-collapse-and-chat.md](../nebula-galaxy-collapse-and-chat.md) § profile-completion). That modal has **no link branch today**, and adding one is part of this work, not a prerequisite of it.
- **Lineage:** was `icebox/nebula-profile-p2-global-person.md` (parked 2026-07-15) → un-iced + merged into the identity-mint task 2026-07-19 → cut back out the same day when the panel showed the mechanism unbuildable. The `#mintIdentity` email-match half **stayed** in the identity-mint task; only the breadcrumb/linking half is here.
