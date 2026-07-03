# Auth Token Core — Compose, Don't Fork (`@lumenize/auth` ↔ `nebula-auth`) — ON HOLD

**Status**: **ON HOLD** — designed-enough to capture, not yet design-reviewed. Surfaced 2026-07-03 while
discussing JWT-vs-server-session auth strategy; the forcing example is a live security-rule conformance
drift (below). **Needs a `/review-task` design pass before `/build-task`** — and Phase 0 (seam-finding) is
a strong **overnight-run candidate** (nightly backlog `#64`), because it's a review→findings pass with no
build. **Do this AFTER the in-flight mesh continuation-only refactor** — one active child task at a time.

**Un-park trigger:** the mesh continuation-only refactor lands, *or* the overnight loop picks up Phase 0.

## Why this exists (the forcing example — do not fix in isolation)

The 2026-06-29 "drop refresh-token rotation" decision (`8424ee5`) landed in `nebula-auth` **only**. The base
MIT package `@lumenize/auth` still rotates on every refresh — `packages/auth/src/lumenize-auth.ts:345`
(`UPDATE RefreshTokens SET revoked = 1` + mint-new; no grace, no reuse-detection, no family-revoke). That is
the exact no-grace/no-family-revoke form `.claude/rules/security.md` (which globs over `packages/auth/**`)
says *"Don't re-introduce."* So the public package **contradicts our own security rule** and ships the racy
pattern (spurious logout on hibernating/reconnecting clients) to strangers.

**Root cause, not symptom.** The fix drifted because the two DOs are a **forked core** — copying the fix
across again just reloads the gun. This task fixes the fork so the rotation fix, and every future
token-plumbing fix, lands **once**. Patching rotation in `@lumenize/auth` standalone is explicitly
**rejected**: it would deepen the fork. (This supersedes the dismissed "copy the fix" chip, task_65579b49.)

## Current state (verified against source 2026-07-03)

**Already composed — the leaf layer.** `nebula-auth` depends on `@lumenize/auth` and imports: jwt/crypto
primitives, shared types (`ActClaim`, `ResolvedEmail`, `EmailMessage`), `AuthEmailSenderBase`, router
utilities. Crypto is **not** duplicated.

**Forked — the ~1,400-line DO orchestration body.** Route dispatch + refresh-token / magic-link / subject
SQL handlers + cookie construction. Both files admit it in their headers ("Forked from @lumenize/auth …").
The genuine differences are **localized**:
- first-user-is-founder logic — `nebula-auth.ts:1283`
- `access: AccessEntry` claim shape vs `authorizedActors` — `nebula-auth.ts:1361`; `nebula-auth/src/schemas.ts` fork drops `authorizedActors`
- two-scope model + `{u}.{g}.{s}` scope parsing — `nebula-auth/src/parse-id.ts`, `nebula-auth-registry.ts`
- cookie path — base `Path=/` (`lumenize-auth.ts:1314`) vs nebula path-scoped `/auth/{authScope}`

So the drift lives specifically in the **handler-orchestration layer, which has no composition seam today** —
shared crypto sits under two hand-copied refresh handlers. Sizes: `lumenize-auth.ts` ~1,368 lines;
`nebula-auth.ts` ~1,469. The **correct** reference handler (no-rotation, slid expiry) is `nebula-auth.ts:441`.

## Phase 0 — Design pass: find the seam (nightly-shaped; do FIRST, findings-only)

**Goal**: locate the boundary between **generic session/token plumbing** (refresh handler, cookie
construction, magic-link table lifecycle, expiry sweeps, subject-row helpers) and **identity/authz policy**
(founder logic, claim shape, scope parsing, cookie-path policy), and decide whether the existing
`packages/auth/src/hooks.ts` seam can express the four known differences — or whether the fork exists
*because* it can't.

**This is the risk.** The fork headers claim the diffs are localized; a de-fork can discover they're more
entangled than advertised. Phase 0 confirms or kills the clean-seam assumption **before any code moves**.

**Success criteria** (no code):
- [ ] Seam map: every handler in the forked body classified *generic plumbing* (→ shared) or *policy*
  (→ injected), each with a named injection mechanism (hook / param / subclass override).
- [ ] Verdict on `hooks.ts`: sufficient as-is / needs N enumerated new hook points / wrong shape (why).
- [ ] Scope recommendation: **targeted** (extract only the drift-prone token/session plumbing; leave
  founder + scope-parsing forked) vs **full** de-fork, with rationale. *Author's lean: targeted-first — a
  full ~2,800-line unification is high churn for the parts that aren't drift-prone.*
- [ ] Cookie-path + claim-shape confirmed parameterizable as policy (not structural blockers).

## Phase 1 — Extract the shared token/session core (build; pin at `/review-task` after Phase 0)

**Goal**: the refresh/cookie/magic-link plumbing lives once; both DOs compose it and inject policy. The
rotation fix falls **out of** the shared core — no longer a separate change.

**Success criteria**:
- [ ] `auth` and `nebula-auth` share one refresh-token handler; no-rotation slid-expiry is the shared default.
- [ ] Nebula policy (founder, `AccessEntry` claims, scope parsing, cookie path) injected, not forked.
- [ ] Base `@lumenize/auth` no longer rotates on refresh; base cookie path-scoped (or documented why not).
- [ ] `security.md` refresh-token rule now holds for `packages/auth/**` (currently violated).
- [ ] All `auth` + `nebula-auth` tests green; type-check clean. Tests asserting "old token revoked after
  refresh" updated (template: the `nebula-auth` test changes in `8424ee5`).

## Notes / trade-offs

- **No urgency — that's *why* it can wait and be done right.** The rotation footgun is a reliability issue
  (spurious logout), not an exploitable vuln, and nobody consumes base `@lumenize/auth` today but us — via
  `nebula-auth`, which is already correct. Nothing to stop-gap.
- **Rhymes with ADR-007** ("share one narrow core by composition, never reimplemented"). ADR-007 literally
  governs mesh nodes, not these raw `extends DurableObject` DOs, so it doesn't *bind* here — but it's the
  same principle codified one layer up. Cite it in the review as motivation, not as a gate.
- **Latent question for the review**: are two parallel auth DOs the right end state at all, or should
  `nebula-auth` become a thin policy layer over a `@lumenize/auth` core? Phase 0's seam map answers this.

## Related
- `.claude/rules/security.md` § refresh tokens — the violated rule + the "if you ever want breach detection,
  do grace + family-revoke, never the no-grace/no-family-revoke form" note.
- 2026-06-29 rotation-drop decision — commit `8424ee5` (nebula-auth only).
- Nightly backlog `#64` — Phase 0 seam-finding as an overnight review pass.
