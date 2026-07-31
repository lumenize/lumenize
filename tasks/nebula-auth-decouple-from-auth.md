# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 📝 **DRAFTED 2026-07-31**, not yet reviewed. The design intent below came out of a
measured conversation (every number in it was checked against disk that day) but it has had **no
`/review-task` pass** — run one before `/build-task`. Phases are written because the shape was settled
in that conversation, not because the file is review-approved.

## Objective

**`packages/nebula-auth` stops depending on `@lumenize/auth` — no entry in its `package.json` at
all — while `packages/mesh` keeps depending on a package it can honestly justify.**

Two moves get there, and the split between them is the whole design:

1. **Extract** the JWT/crypto core into its own tiny package. Shared, one owner, security fixes land
   once.
2. **Copy** the email-sender base and two small utilities into `nebula-auth`. Deliberately forked,
   free to diverge, never re-synced.

## Why this exists

`nebula-auth` was **forked** from `@lumenize/auth`, not composed with it, and the two have been
quietly diverging on policy ever since. The forcing example is a live security drift:
`packages/auth/src/lumenize-auth.ts:358` still revokes-and-reissues on refresh — *"Revoke old refresh
token (rotation)"* — a month after `security.md` recorded that decision as **dropped, do not
re-introduce**. It landed in `nebula-auth` only, and nobody noticed, because sharing a package
manufactures an impression of shared ownership that is not true.

The day-to-day cost is ceremony disproportionate to the change. A 2026-07-30 refactor of the email
sender's header hook — code with **exactly one real consumer** — required a `BREAKING` commit, a
repo-wide override sweep, and a release-notes flag against a package with 25 npm downloads a month.

⚠️ **This does NOT deprecate `@lumenize/auth`.** It stays published, stays documented at
`website/docs/auth`, and keeps serving `packages/mesh` and any external user. The question this file
answers is only *what `nebula-auth` should depend on*.

## What is actually coupled — measured 2026-07-30/31

`nebula-auth/src` imports **13** symbols from `@lumenize/auth`. They split cleanly by security weight,
and that split is the design:

| Piece | Lines | Consumers outside `packages/auth` | Security weight | Verdict |
|---|---|---|---|---|
| `jwt.ts` — sign/verify/importKeys + `parseJwtUnsafe`, `createJwtPayload` | 281 | mesh (`src`), nebula-auth (`src` + tests) | **HIGH** — crypto, incl. BLUE/GREEN key rotation (`verifyJwtWithRotation`) | **Extract** |
| `auth-email-sender-base.ts` + `EmailMessage` / `ResolvedEmail` | 217 | **nebula-auth only** — mesh touches it in `test/browser/` + `test/for-docs/`, never `src` | none | **Copy** |
| `turnstile.ts` (`verifyTurnstileToken`) | 47 | nebula-auth | low — a thin API call | **Copy** |
| `extractWebSocketToken` (of `hooks.ts`'s 416) | 13 | nebula-auth, apps/nebula | low | **Copy** |

Copied total ≈ 280 lines, well under CLAUDE.md's *"favor copy-paste-with-attribution over a dependency
for <1000 SLOC"* threshold.

**Why crypto is the exception rather than more of the same.** "Only we call it, so divergence is safe"
is true of *policy* and false of *crypto*: a verification bug or key-handling fix would have to land
twice, and the second landing is the one that gets forgotten. The rotation drift above is that exact
failure, already demonstrated. Duplicating `jwt.ts` would trade a coordination cost we notice (a
breaking-change sweep) for a security cost we don't.

## Design intent

### The manifest is the guard, not a comment

Leaving `"@lumenize/auth": "*"` in `nebula-auth`'s `dependencies` while merely *preferring* the local
copies would not hold. A future session writing `import { AuthEmailSenderBase } from '@lumenize/auth'`
would be **adding one line to a file** — no manifest change, no review signal, and it reads as tidying
away a duplicate. Removing the entry makes re-coupling require a deliberate dependency addition,
which is visible in review. Same reasoning as `instanceAuthUrl`'s compile-time guard beating a
warning comment: a structural guard cannot rot.

⇒ **Success is measured on the manifest**, not on import counts.

### The extraction is justified without `nebula-auth`

Three consumers already reference the JWT core from `src`: `packages/auth` (46), `nebula-auth` (15),
`mesh` (8). This is extraction, not speculative generality (`workflow.md` § YAGNI gates capability,
never generality).

**Independently: the MIT foundation currently depends on a full auth product with a Durable Object in
it to obtain six pure functions.** `packages/auth/src/index.ts:11` exports `LumenizeAuth`, and
`lumenize-auth.ts:2` imports `DurableObject` from `cloudflare:workers`. That is not a bundle-size
problem — `jwt.ts` has exactly one import and it is **type-only**, so it tree-shakes to nothing — it
is a **module-graph reachability** problem, and it has already produced three workarounds in this
repo:

- `mesh/src/lumenize-client.ts:3` imports `parseJwtUnsafe` from `@lumenize/auth/client`, not the
  barrel, to dodge it.
- `@lumenize/nebula-auth`'s own barrel has the identical shape (`NebulaAuthRegistry` →
  `cloudflare:workers`), which is why `RECOMMENDED_MIN_TTL_SECONDS` could not be imported into the
  client during `archive/nebula-impersonation-client.md`.
- The `mesh-do-in-light-index-breaks-transform` memory records a third.

Three workarounds for one recurring cause is the signal to fix the cause.

### A copy that is not marked as deliberate will be "cleaned up"

Each copied file must say, at the top, that it is a **deliberate divergence from `@lumenize/auth`,
not to be re-synced**, and why. Without that, a future session diffing the two and unifying them looks
diligent while silently restoring the coupling this file exists to remove.

### What the copy unblocks

Owning `EmailMessage` locally removes the objection that killed the better fix for the
instance-tagging bug. The registry currently builds a URL and the sender **re-parses the instance back
out of it** (`nebula-email-sender.ts` `parseInstanceName`), guarded by `instanceAuthUrl`'s typed route
union. The direct design — the registry *passing* the `instanceName` it already holds, on the message
— was rejected only because it would push Nebula vocabulary into the shared MIT type. After the copy
that reason is gone. ⚠️ **Not in scope here** (it is a behaviour change, and the current guard is
sound); noted so the next person does not re-derive the rejection from a premise that has expired —
`calibration.md` §4.

## Open questions

1. **Package name, and what rides along.** `jwt.ts` today also exports `generateRandomString`,
   `generateUuid` and `hashString`, which are **not** JWT concerns. Shipping them inside a package
   called `@lumenize/jwt` is the kind of name that costs a re-derivation every time someone goes
   looking for them (`calibration.md` §5). Options: (a) `@lumenize/jwt` carrying all ten exports and
   accepting the misnomer; (b) `@lumenize/jwt` for the eight JWT/key symbols plus a separate home for
   the three utilities; (c) a broader name (`@lumenize/crypto`) that honestly covers both. **Decide
   before Phase 1** — it sets the public surface.
2. **Does `packages/auth` consume the new package, or keep a local copy?** It has 46 `src`
   references and four files importing `./jwt`. Consuming it is the consistent answer and keeps one
   owner; confirm there is no publish-order problem under Lerna's synchronized versioning.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Extract the JWT core; copy the rest** | *Copy everything, including `jwt.ts`.* Duplicated crypto means a security fix lands twice, and the live rotation drift is proof the second landing gets missed. |
| **Extract the JWT core; copy the rest** | *Share everything (status quo).* Keeps manufacturing false shared ownership over code that is already forked in policy, and taxes every email-template change with breaking-change ceremony. |
| **Remove `@lumenize/auth` from `nebula-auth`'s `package.json`** | *Keep the dependency and merely prefer local copies.* The manifest entry is the affordance — re-coupling would cost one import line and show no review signal. |
| **`@lumenize/auth` stays published and documented** | *Deprecate it.* It serves `mesh` and external users, and CLAUDE.md's mission #1 is the MIT package suite. Its low adoption (25 downloads/month) is an argument about *investment*, not about deletion — and not this file's question. |
| **`mesh` keeps depending on an extracted package, never on `nebula-auth`** | *Inline `auth` into `nebula-auth` wholesale.* `mesh/src` needs the JWT core, and `mesh.md` § dependency direction forbids `mesh → nebula-*`. |

## Phases

1. **Extract the JWT/crypto core into its own package.** Resolve Open question 1 first. Move `jwt.ts`
   as-is (no rewrite) plus the `JwtPayload` / `JwtHeader` interfaces it type-imports from
   `packages/auth/src/types.ts`. New package follows the shape of an existing small one
   (`packages/structured-clone`, `packages/routing`), added to the root `workspaces` list.
   - **Success —** the new package builds and type-checks with **zero runtime dependencies** (today
     `jwt.ts`'s only import is type-only; that property is the reason extraction is cheap and should
     be asserted, not assumed).
   - **Success (capable of failing) —** its own tests cover sign → verify round-trip, `verifyJwt`
     rejecting an expired `exp`, and `verifyJwtWithRotation` accepting a token signed by the
     non-first key in the array. **Mutation:** drop the `exp` check → the expiry test reds.
     ⚠️ Do not port assertions that only ever exercised the happy path.

2. **Repoint `packages/auth` and `packages/mesh` at the new package.** Both keep working exactly as
   before; this phase changes imports, not behaviour. Drop `mesh/src/lumenize-client.ts`'s
   `@lumenize/auth/client` workaround if the new package is Node-safe (it should be — no DO).
   - **Success —** `packages/auth` (160 tests) and `packages/mesh` suites stay green, and `mesh`'s
     `package.json` no longer needs `@lumenize/auth` **if** nothing else in `mesh/src` uses it.
     ⚠️ Check rather than assume: `AuthEmailSenderBase` appears in `mesh/test/browser/worker/` and
     `mesh/test/for-docs/getting-started/`, so a **devDependency** may legitimately remain. A
     for-docs mini-app is a real consumer, not a stray.

3. **Copy the email seam + the two utilities into `nebula-auth`.** `auth-email-sender-base.ts`,
   `EmailMessage` / `ResolvedEmail`, `turnstile.ts`, and `extractWebSocketToken` (that function only —
   not `hooks.ts`'s other 400 lines).
   - **Success —** every copied file carries a header naming `@lumenize/auth` as its origin, the date,
     and **"deliberate divergence — do not re-sync"** with the reason. This is the phase's real
     deliverable; the code move is mechanical.
   - **Success (capable of failing) —** `nebula-auth`'s suite stays at its current count (255 passed /
     1 skipped as of 2026-07-31) and the `/live` `impersonation-lifecycle` scenario — which drives a
     real invite email end to end — still passes.

4. **Remove `@lumenize/auth` from `nebula-auth`'s `package.json`.** The phase that makes the rest
   hold.
   - **Success — the criterion is the manifest.** `@lumenize/auth` appears in neither `dependencies`
     nor `devDependencies` of `packages/nebula-auth/package.json`. ⚠️ `nebula-auth`'s **tests** import
     seven symbols from it (`parseJwtUnsafe`, `signJwt`, `importPrivateKey`, `hashString`,
     `generateUuid`, `EmailMessage`, `ResolvedEmail`) — all now reachable from the new package or the
     local copies, so re-point them rather than retaining a devDependency for their sake.
   - **Success (capable of failing) —** `npm ls @lumenize/auth` from `packages/nebula-auth` resolves
     nothing. **Mutation:** re-add the dependency → the check reds. A grep for the import string is
     the weaker form and should not be the criterion, since it passes while the affordance remains.

5. **Settle the rotation drift, or record where it is settled.** This file's forcing example is a
   live `security.md` violation in `packages/auth`. Decoupling does not fix it — it makes it *safe to
   fix independently*, which is the point. Either drop rotation in `@lumenize/auth` too, or state
   explicitly that the base package's policy is deliberately different and correct its JSDoc
   (`lumenize-auth.ts:49` advertises rotation as a feature).
   - **Success —** `packages/auth`'s refresh behaviour and its documentation agree with each other,
     and with a decision recorded somewhere findable.

## Relationships

- **Overlaps** [on-hold/auth-token-core-compose-not-fork.md](on-hold/auth-token-core-compose-not-fork.md),
  which names the same rotation drift as its forcing example and whose un-park trigger (the mesh
  continuation-only refactor) has already landed. ⚠️ **Reconcile the two before building** — that file
  argues *compose, don't fork* for the token core, which is the same answer this file gives for
  `jwt.ts` and the opposite of what it gives for the email seam. The likely resolution is that this
  file supersedes it, absorbing its Phase 0 seam-finding; if so, `git rm` it and repoint its pointers
  in one pass rather than leaving a superseded banner (`tasks/README.md`).
- **Unblocks nothing that is currently blocked** — it is cleanup, and its value is preventing future
  drift rather than enabling a feature. Sequence it accordingly.
- **Follows** [archive/nebula-impersonation-client.md](archive/nebula-impersonation-client.md), whose
  `headers(message)` breaking change surfaced the ceremony cost, and whose `RECOMMENDED_MIN_TTL_SECONDS`
  problem is the third instance of the barrel/DO reachability issue Phase 1 addresses.
