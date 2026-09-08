# Personas

**Status:** STUB, 2026-09-08 — the design sections below are Larry's to write and are deliberately empty. What follows them is gathered reference: the decisions already pinned and where each was argued, what is verified on disk, what is stale, and what this file still has to settle. None of it is a constraint on the design; it is here so the writing does not start with a hunt.

## Context

*(Larry's.)*

## Objective and goals

*(Larry's.)*

## Relationships

- **Gated by the Profile access-control work** ([nebula-profile-access-control.md](nebula-profile-access-control.md)), in build 2026-09-08. Its mint refusal is why a persona must accept before it can be impersonated, and its owner-branch change is what lets an impersonated persona own its own profile.
- **Shares the Workspace-repo write path** with ⑤ ([nebula-ontology-history-file.md](nebula-ontology-history-file.md)), and not its append-only rule — personas are edited, history is not.
- **Adjoins** [on-hold/nebula-studio-multi-user-testing.md](on-hold/nebula-studio-multi-user-testing.md), the same tab UI, and shares the subject/grant/scope core with [on-hold/nebula-request-access.md](on-hold/nebula-request-access.md), the pull half — share it, do not fork it.
- **The cast's home is ①'s** ([archive/nebula-guidance-file-tree.md](archive/nebula-guidance-file-tree.md), shipped): `docs/personas.md` as numbered prose keyed on persona name, a seed template naming mint, node, edge and grant, and a `define-the-cast` skill that elicits the cast and hands it to the executor designed here.

## Pinned already — decided, with where each was argued

| Pinned | Where it was decided |
|---|---|
| Personas ride `impersonate()`; no `synthetic` column; each is a real `@lumenize.io` account that accepts like anyone. | Decision 1, [nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*; the trail is § *② Personas*' 2026-09-07 and 2026-09-08 bullets. |
| The owner shown stacked behind a persona in the app is acceptable, and a user-developer may not render it as a stack at all. | Same. |
| Acceptance is enforced at the mint, so an invited-but-unaccepted persona is not impersonable. | [nebula-profile-access-control.md](nebula-profile-access-control.md). |
| Key the persona file on NAME, never `sub` — subs are ADR-010 randoms and every wipe re-mints them. | § *② Personas*. |
| Persona tabs are iframes inside the Studio page, never separate browser tabs: a child renews through its parent's in-process mint helper, so a reload recreates them by construction. | § *② Personas*, from the 2026-09-06 teardown answer. |
| The set of OPEN personas is view state and rides the URL ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)); each is re-minted on load from the file's name-to-`sub` map. | Same. |
| Per-persona identity lives in each iframe's own JS realm, never Web Storage — `sessionStorage` partitions per tab, not per iframe, and `NebulaClient` takes an injected `sessionStorage` per context. | Same. |
| `provision(plan)` is human-gated, never a loop tool: it mints identities and grants above the chat floor, so the plan is shown and the poster confirms. | § *② Personas*, from ①'s design conversation. |
| Execution shape: the model reads the prose and produces ONE plan, typed in TypeScript and typia-validated before dispatch (ADR-001); the executor is deterministic, create-if-missing throughout, and returns the realized tree plus the name-to-`sub` map. | Same. Rejected there: granular per-step tools, and a typed block Studio parses. |
| The run's record is machine-owned under `.nebula/`, and survives `resetDevData`, which touches only the Star. | Same. |
| The `.dev` Star stands in for a tenant Star whose founder is a stranger, so the first persona gets `admin` on the root node plus `scopeAdmin` at `.dev`, as one plan entry and an explicit `setPermission` — never an arrival. | Same. ⚠️ The seed latch and `resetDevData`'s re-arming are described there; arrival order decides and is never relied on. |
| The creating call should originate from the user-developer's own request, not the singleton — a DO's first call fixes where it lives forever. | Same; needs `CallOptions.locationHint` from [on-hold/mesh-origin-request.md](on-hold/mesh-origin-request.md). |

## Verified on disk — so it need not be re-derived

- **`invite()` returns the minted `sub`** on `InviteeSummary`, which is the name-to-`sub` map's source.
- **`impersonate(sub, activeScope)` is built and driven** — two live scenarios exercise it, and disposing the parent tears every child down through one seam, so a bare disconnect leaves the personas intact.
- **`dagTree().setPermission` attaches the grants**, reached through the plane's gate once ④ lands.
- **The refresh cookie is one fixed name at `Path=/auth/{scope}`**, so two real logins at one scope overwrite each other. That is what made a real login per persona expensive, and it is why impersonation won.
- **Persona mailboxes already exist as infrastructure.** The `@lumenize.io` catch-all routes to a deployed email-test Worker, and `uniqueTestEmail(prefix)` mints `prefix-<uuid>@lumenize.io`. The harness already claims, invites, waits for the real mail, clicks the link and accepts, in `apps/nebula/test/lib/email-login.ts`. Porting that path to production is this file's early phase.

## Stale — do not carry forward

⚠️ **§ *② Personas*' "the one capability gap is a no-send mint" bullet predates decision 1 and should be re-derived, not adopted.** It argued for minting invites without sending mail, so a wipe would not re-bounce real magic links off the sender. Decision 1 makes the mail the *mechanism*: a persona is a real account that accepts through inbound mail. So the gap may be retired outright, or may survive in a narrower form for re-provisioning after a wipe. Settle it here.

## Open, and this file's to settle

1. **One address is one Profile across every app** ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)), so two user-developers whose apps use the same persona address would share one Profile and one display name. Mint each persona an address unique to its Galaxy, or state why sharing is acceptable.
2. **[ADR-016](../docs/adr/016-record-the-acting-principal.md) binds the executor**: its mints and grants are authority events, so each records the full acting claims through the one shared projection.
3. **The [ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md) sizing sentence** — every persona is a membership row in the singleton Registry. Pre-alpha's users times apps times personas is negligible but multiplicative; say so, so a later reviewer need not re-derive the worry.
4. **What replaces the no-send mint**, per § *Stale* above.

## Criteria the plan already says to carry

- A wiped `.dev` Star is re-established from the persona file alone: provision from a seeded `personas.md`, wipe, run, and the tree, the grants and a fresh `sub` per name match the prose. Mutation: drop create-if-missing, and the second run fails on "already exists".
- A plan naming an unknown node is refused before anything runs. Mutation: remove validation, and a grant lands on nothing.
