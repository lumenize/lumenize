# Personas

**Status:** STUB, 2026-09-08 — the design sections below are Larry's to write and are deliberately empty. What follows them is gathered reference: the decisions already pinned and where each was argued, what is verified on disk, what is stale, and what this file still has to settle. None of it is a constraint on the design; it is here so the writing does not start with a hunt.

## Context

One of Lumenize Nebula's main selling points is that every app built automatically gets a robust fine-grained access control model using our DAG orgTree model for Resources.

Right now, the preview in Nebula Studio is a single iframe. The user-dev is be expected to log in as founder, invite other users with their own dummy email addresses, accept those invites, and then log out as founder and in as each of those other users one at a time to test their fine-grained access control and see how the UI changes based upon those permissions. That does not align with Lumenize's de✨light✨ful DX core value.

Further, we want to guide each user to good software development practices and one of those practices includes utilizing a cast of named personas to think about the experience of their users. We already have some support in the platform standing guidance (AGENTS.md, skills, etc.) [add references to that guidance and name the files that the LLM will produce (`docs/personas.md`, the provisioning script, and the `define-the-cast` skill)] for encouraging this but we have more planned including testing. 

This task is the next increment on that fine-grained permissioning journey and we've chosen to tie the permissioning model to a cast of personas, not a list "roles", partially to highlight the difference between our ReBAC, not RBAC, model. [Add reference(s) to ReBAC introduction in docs/vision/ and or blog post(s)].

## Objective and goals

**Objective -- create a de✨light✨ful experience for testing a Studio authored app as each persona.**

**Goals:**

1. **Provision each persona as a user.** Everytime the personas file, which includes the provisioning script [Or does it just reference that in a separate file?], either provision from scratch, if the .dev Star was wiped, or adjust the existing provisioning to match the lastest of those two files.
2. **Populate with (on a wipe), or adjust existing (no wipe), test data to minimally show off the difference in each persona's permissions.** [Should this require another script? or maybe this is out of scope for this task file?]
3. **Accept each persona's invite.** Create dynamic email addresses for each persona [Would it make sense to use `{u}.{g}~{personaSlug}@lumenize.io` as the format for the email address (note the use of tilde instead of dash to help with parsing since u and g slugs can contain dashes, but maybe some other delimeter is better)?]. Send those emails and auto-accept those invites. [Do we need to upgrade the platform standing guidance to recommend short nicknames as slugs for each persona? "Manager Mary" might just become "mary".]
4. **Log each persona in to a separate tab in the preview area.** The preview area gets a list of tabs with the persona slug as the tab label.

## Relationships

- **Was gated by the Profile access-control work** ([archive/nebula-profile-access-control.md](archive/nebula-profile-access-control.md)), BUILT and archived 2026-09-08 — so this file is unblocked. Its mint refusal is why a persona must accept before it can be impersonated, and its owner-branch change is what lets an impersonated persona own its own profile.
- **Shares the Workspace-repo write path** with ⑤ ([nebula-ontology-history-file.md](nebula-ontology-history-file.md)), and not its append-only rule — personas are edited, history is not.
- **Mines the tab half of** [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md) — its favored default is § *Pinned*'s tab row below, and its question about how test users are minted is answered by decision 1. **That file is not deleted**: its other half is the fate of `/create-star` and how a pre-created tenant Star is founded, which this task does not touch. Shipping personas trips its second open question, whether admin-created tenant Stars are still needed at all.
- **Shares the subject/grant/scope core with** [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md) — **not superseded**. That is the pull half, someone climbing the tree to ask an admin for access; this is the push half, a cast provisioned up front. Share the core, do not fork it.
- **The cast's home is ①'s** ([archive/nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md), shipped): `docs/personas.md` as numbered prose keyed on persona name, a seed template naming mint, node, edge and grant, and a `define-the-cast` skill that elicits the cast and hands it to the executor designed here.

## Pinned already — decided, with where each was argued

| Pinned | Where it was decided |
|---|---|
| Personas ride `impersonate()`; no `synthetic` column; each is a real `@lumenize.io` account that accepts like anyone. | Decision 1, [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*; the trail is § *② Personas*' 2026-09-07 and 2026-09-08 bullets. |
| The owner shown stacked behind a persona in the app is acceptable, and a user-developer may not render it as a stack at all. | Same. |
| Acceptance is enforced at the mint, so an invited-but-unaccepted persona is not impersonable. | [archive/nebula-profile-access-control.md](archive/nebula-profile-access-control.md), built. |
| Key the persona file on NAME, never `sub` — subs are ADR-010 randoms and every wipe re-mints them. | § *② Personas*. |
| Persona tabs are iframes inside the Studio page, never separate browser tabs: a child renews through its parent's in-process mint helper, so a reload recreates them by construction. | § *② Personas*, from the 2026-09-06 teardown answer. |
| The set of OPEN personas is view state and rides the URL ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)); each is re-minted on load from the file's name-to-`sub` map. | Same. |
| Per-persona identity lives in each iframe's own JS realm, never Web Storage — `sessionStorage` partitions per tab, not per iframe, and `NebulaClient` takes an injected `sessionStorage` per context. | Same. |
| `provision(plan)` is human-gated, never a loop tool: it mints identities and grants above the chat floor, so the plan is shown and the poster confirms. | § *② Personas*, from ①'s design conversation. |
| Execution shape: the model reads the prose and produces ONE plan, typed in TypeScript and typia-validated before dispatch (ADR-001); the executor is deterministic, create-if-missing throughout, and returns the realized tree plus the name-to-`sub` map. | Same. Rejected there: granular per-step tools, and a typed block Studio parses. |
| The run's record is machine-owned under `.nebula/`, and survives `resetDevData`, which touches only the Star. | Same. |
| The `.dev` Star stands in for a tenant Star whose founder is a stranger, so the first persona gets `admin` on the root node plus `scopeAdmin` at `.dev`, as one plan entry and an explicit `setPermission` — never an arrival. | Same. ⚠️ The seed latch and `resetDevData`'s re-arming are described there; arrival order decides and is never relied on. |
| The creating call should originate from the user-developer's own request, not the singleton — a DO's first call fixes where it lives forever. | Same; needs `CallOptions.locationHint` from [on-hold/mesh-origin-request.md](on-hold/mesh-origin-request.md). |
| Multi-user testing happens on the `.dev` Star, never on pre-created tenant Stars, rendered as a tab strip where the single preview iframe sits today — one iframe per test user. | [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md), its favored default, stated 2026-08-17 and mined here. It predates goal 4 and agrees with it. |

## Verified on disk — so it need not be re-derived

- **`invite()` returns the minted `sub`** on `InviteeSummary`, which is the name-to-`sub` map's source.
- **`impersonate(sub, activeScope)` is built and driven** — two live scenarios exercise it, and disposing the parent tears every child down through one seam, so a bare disconnect leaves the personas intact.
- **`dagTree().setPermission` attaches the grants**, reached through the plane's gate once ④ lands.
- **The refresh cookie is one fixed name at `Path=/auth/{scope}`**, so two real logins at one scope overwrite each other. That is what made a real login per persona expensive, and it is why impersonation won.
- **Persona mailboxes already exist as infrastructure.** The `@lumenize.io` catch-all routes to a deployed email-test Worker, and `uniqueTestEmail(prefix)` mints `prefix-<uuid>@lumenize.io`. The harness already claims, invites, waits for the real mail, clicks the link and accepts, in `apps/nebula/test/lib/email-login.ts`. Porting that path to production is this file's early phase.

## Stale — do not carry forward

⚠️ **§ *② Personas*' "the one capability gap is a no-send mint" bullet predates decision 1 and should be re-derived, not adopted.** It argued for minting invites without sending mail, so a wipe would not re-bounce real magic links off the sender. Decision 1 makes the mail the *mechanism*: a persona is a real account that accepts through inbound mail. So the gap may be retired outright, or may survive in a narrower form for re-provisioning after a wipe. Settle it here.

## Open, and this file's to settle

Mined from the sections above on 2026-09-08. The first is a fork with a pinned decision and the rest are ordered by how much of the design moves if the answer changes.

**A. Plan or script? Your § *Context* names "the provisioning script" as one of the three files the LLM produces; § *Pinned* says the model emits ONE plan, typed and typia-validated, for a deterministic executor.** Those are different artifacts: a script is code that runs, a plan is data that is checked before anything runs, and only the second can be refused whole. The pinned form was chosen over granular tools and over a typed block Studio parses. Decide which the prose means, because goal 1's bracket — whether the personas file carries it or references a sibling — only has an answer once this does.

**B. ANSWERED in shape (Larry, 2026-09-08): re-provisioning wipes the `.dev` Star first, so create-if-missing is enough and nothing converges.** `resetDevData` is a `deleteAll()` on that Star alone, so the nodes, the edges, the grants and the Resources all go and there is nothing left to adjust. No deletes, no per-removal authority event, no half-migrated tree. **Residual, and it is a DX question rather than a mechanism one:** is the wipe suggested, offered as the default of a two-button apply, or forced? Goal 2's data is what makes it feel expensive, so answer it with D.

**B2. The Registry is NOT wiped, and it accrues far less than it looks — check this before designing a sweep.** `Memberships` carries `UNIQUE (emailId, universeGalaxyStarId)` and `#mintIdentity` returns the existing row when one is there, so re-provisioning an unchanged persona **reuses its `sub`**. Cruft therefore accrues per persona **renamed or removed**, not per re-provision, which is bounded by how often a user-developer edits the cast rather than by how often they test.

⚠️ **That falsifies a criterion this file inherited.** § *Criteria* says a wiped `.dev` Star re-establishes with *a fresh `sub` per name*. It will not: the membership survives `resetDevData` and is reused, and only ⑥'s worker-delete destroys the Registry. The stable `sub` is the better property anyway — the `.nebula/` name-to-`sub` map stays valid across a dev wipe instead of being rewritten each time — so the criterion is corrected below rather than the behaviour.

**C. What happens to test data hanging off something the wipe removes?** Everything, and that is the point: the wipe takes the data with the tree, so a re-run starts from the plan and the data script alone. The question that survives is D's — what rebuilds it.

**D. Test data — a second artifact, or part of the plan, or out of scope?** Your goal 2's own bracket. Two sub-questions it carries: whose authority writes it, since a Resource created as the founder persona and one created as Studio land under different grants; and what a second run does, which needs a key to be idempotent on.

**E. Is the auto-accept a second door?** Goal 3 sends the invite mail and accepts it for the persona. That reads like the `synthetic` column decision 1 rejected, and it is not — we own the catch-all mailbox, so Studio is the address holder, clicking the real link and posting the real accept through the two endpoints a human uses. **Say that in the file**, because a reviewer who does not see it stated will read the auto-accept as the rejected shape returning.

**F. A persona needs both a session and an impersonation, and the file should say why.** Accepting requires the persona's own path-scoped cookie, so acceptance is a real login. Running its tab is impersonation off the user-developer's session. Goal 3 and goal 4 are therefore different mechanisms, and goal 4's *log each persona in* reads as one.

**G. Is the address stable across a wipe?** Your `{u}.{g}~{slug}@lumenize.io` format is Galaxy-scoped, which settles the shared-Profile worry — one address is one Profile ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)), and this format cannot collide across apps. It also means the Profile, its display name and its picture SURVIVE the wipe that re-mints every `sub`. Probably wanted; say so, since it is the one piece of a persona that a wipe does not reset.

**H. Delimiter.** `~` parses cleanly against slugs that may contain dashes. Check it against the address grammar the Registry and the mail path actually accept before pinning it, and against what the catch-all does with a `.` in the local part.

**I. Do persona slugs need a guidance change?** Your goal 3 bracket. *Manager Mary* becoming `mary` is a naming rule the `define-the-cast` skill would carry, and it is ①'s file rather than this one — so this file states the requirement and ① states the rule.

**J. Which personas get tabs, and is the user-developer one of them?** § *Pinned* says the OPEN set rides the URL ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)), so the tab strip and the open set are not the same list. And the stand-in founder is pinned as the first persona, which either makes the user-developer a persona or leaves them a separate seat.

**K. What does a tab render when its persona cannot reach the app's landing view?** This is the payoff in your § *Context* — seeing the UI change with permissions — and the state most likely to look like a bug rather than a demonstration.

**L. The two adjoined on-hold files, from your bracket.** They differ. `nebula-studio-multi-user-testing.md` is largely absorbed: its favored default is this task, and its open question about how test users are minted for the `.dev` tabs is this file. Two things there are NOT absorbed — whether anything still needs admin-created tenant Stars, and the founding-by-invite decisions — so mine the tab half here and re-home that remainder rather than deleting the file whole. `nebula-request-access.md` is not superseded at all: it is the pull half, someone climbing the tree to ask for access, and it shares only the subject/grant/scope core.

**M. Two references your prose leaves open, both answerable now.** The ReBAC case is made in [auth.md](../docs/vision/auth.md) § *The layers a call passes*, at the data-plane DAG bullet and the *Why relationships rather than roles?* paragraph beneath it, which cites AuthZed on role explosion. The guidance tree is `apps/nebula/platform/`, and the three artifacts are `docs/personas.md`, the `define-the-cast` skill under `platform/skills/`, and whatever A decides the third one is.

**N. Still owed regardless of the above.** [ADR-016](../docs/adr/016-record-the-acting-principal.md) binds the executor, since its mints and grants are authority events that record the full acting claims through the one shared projection. [ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md) wants a sizing sentence, because every persona is a membership row in the singleton and users times apps times personas is multiplicative. And § *Stale* still owes a verdict on what replaces the no-send mint.

## Criteria the plan already says to carry

- A wiped `.dev` Star is re-established from the persona file alone: provision from a seeded `personas.md`, wipe, run, and the tree and grants match the prose. ⚠️ Each unchanged persona keeps the **same** `sub`, because its membership survives a `.dev` wipe and is reused — assert that, not a fresh one (§ *Open* B2). Mutation: drop create-if-missing, and the second run fails on "already exists".
- A plan naming an unknown node is refused before anything runs. Mutation: remove validation, and a grant lands on nothing.
