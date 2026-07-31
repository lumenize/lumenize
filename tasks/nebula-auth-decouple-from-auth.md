# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 📝 **DRAFTED 2026-07-31.** Hand-reviewed + `/review-task` **Stage 1** resolved (20 findings,
all applied). **Phases next** — `/write-task` pass 2, then Stage 2.

## Objective

**`packages/nebula-auth` stops depending on `@lumenize/auth` — no entry in its `package.json` at all.**
Three moves, split by **security weight**:

1. **Extract** the JWT/crypto core into `@lumenize/crypto` — a *generic* primitive package carrying no
   auth policy (see Decisions). Shared, one owner, security fixes land once.
2. **Copy** the email sender and turnstile into `nebula-auth`. Deliberately forked, free to diverge,
   never re-synced.
3. **Spend the freedom immediately**, as a late phase: **stamp a required `instanceName` on
   `EmailMessage` and delete the URL re-parse**. Impossible before the copy, cheap right after, and
   what makes this task deliver a working improvement rather than only preventing future drift.

**The consequence that makes it worth doing: `packages/auth` ends with zero `src` consumers anywhere in
the repo** — `mesh` and `apps/nebula` drop it too. It becomes a leaf: still published, still documented,
no longer load-bearing in Nebula's production graph, free to go dormant whenever that is the right call.

## Why this exists

`nebula-auth` was **forked** from `@lumenize/auth`, not composed with it, and the two have been quietly
diverging on policy ever since. The forcing example is a live `security.md` **conformance gap**:
`packages/auth/src/lumenize-auth.ts:358` still revokes-and-reissues on refresh — *"Revoke old refresh
token (rotation)"* — a month after that was recorded as **dropped, do not re-introduce**. It landed in
`nebula-auth` only, and nobody noticed, because sharing a package manufactures an impression of shared
ownership that is not true. ⚠️ **Reliability, not vulnerability** — the failure mode is a spurious
logout when two refreshes race a single-use token, and nobody consumes base `@lumenize/auth` but us.

The day-to-day cost is ceremony disproportionate to the change: a 2026-07-30 refactor of the email
sender's header hook — code with **exactly one real consumer** — required a `BREAKING` commit, a
repo-wide override sweep, and a release-notes flag against a package with 25 npm downloads a month.

This does **not** deprecate `@lumenize/auth` (see Decisions); it makes deprecating it *possible* later.

## What is actually coupled — measured 2026-07-30/31

`nebula-auth/src` imports **13** symbols from `@lumenize/auth`, and they split cleanly by security weight:

| Piece | Lines | Consumers outside `packages/auth` | Security weight | Verdict |
|---|---|---|---|---|
| `jwt.ts` — Ed25519 sign/verify/importKeys, `hashString`, `generateRandomString`, `parseJwtUnsafe`, `createJwtPayload` + the `JwtPayload` / `JwtHeader` / `ActClaim` types | 281 | mesh (`src`), nebula-auth (`src` + tests), apps/nebula (`src` type-only, + harness) | **HIGH** — crypto, incl. BLUE/GREEN key rotation (`verifyJwtWithRotation`) | **Extract** → `@lumenize/crypto`, reshaped |
| `auth-email-sender-base.ts` + `EmailMessage` | 217 | **nebula-auth only** — mesh touches it in `test/browser/` + `test/for-docs/`, never `src` | none | **Copy**, collapsed into `NebulaEmailSender` |
| `turnstile.ts` (`verifyTurnstileToken`) | 47 | nebula-auth | low — a thin API call | **Copy** |
| `extractWebSocketToken` (of `hooks.ts`'s 416) | 13 | nebula-auth, apps/nebula | low | **Move to `@lumenize/mesh`** — not copied |

**The other consumers**, all of which also lose their `@lumenize/auth` manifest entry:

- **`mesh/src`** — `parseJwtUnsafe` + `JwtPayload` (`lumenize-client.ts`, via the `/client` subpath) and
  `signJwt` / `importPrivateKey` / `createJwtPayload` (`create-test-refresh-function.ts`, via the
  barrel). All move to `@lumenize/crypto`. ⚠️ **This is the reason the package exists** —
  `createTestRefreshFunction` is mesh **public API** (`index.ts:83`, documented in getting-started), it
  needs real Ed25519 signing, and `mesh.md` § dependency direction forbids `mesh → nebula-*`.
- **`apps/nebula`** — `src` is 2 imports (`type ActClaim`, `extractWebSocketToken`), but `test` is **50**
  and `harness` **3**, and `@lumenize/auth` is a `dependency`, so there is no devDependency escape hatch.
  ⚠️ All 50 test imports are `generateUuid`, which is **deleted rather than repointed** (Decisions).
- **`apps/nebula/harness/`** — imports `@lumenize/auth/client` and runs under plain Node/tsx. It is the
  shared boot for all six `/live` scenarios, so it must move in the **same phase** as the subpath
  deletion or the `/live` gate below stops booting. It is also the surface that actually proves
  `@lumenize/crypto` is Node-safe.

## Design intent

### The manifest is the guard, not a comment

A future session writing `import { AuthEmailSenderBase } from '@lumenize/auth'` would be **adding one
line to a file** — no manifest change, no review signal, and it reads as tidying away a duplicate.
Removing the entry makes re-coupling cost a deliberate dependency addition, visible in review.
⇒ **Success is measured on the manifest, not on import counts.**

### The copies are renamed and collapsed, not mirrored

`AuthEmailSenderBase` + `NebulaEmailSender` become **one `NebulaEmailSender`**: after the copy there is
exactly one consumer, so the base/subclass split has nothing left to abstract, and the originals stay
live in `mesh/test/**`, `packages/auth/test/**` and five website docs — where an identically-named copy
would be ambiguous at every call site. Each copied file still carries a header naming its origin, the
date, and that it is a **deliberate divergence not to be re-synced**; without it, a future session
diffing the two and unifying them looks diligent while silently restoring the coupling.

### The copy unblocks Nebula-specific email

Today `NebulaEmailSender` overrides no template and no subject — it sets `appName`, a `from`, and
`headers()`, inheriting all five templates verbatim, so Nebula's mail is the generic MIT templates with
a name substituted in. Nebula-specific templates are wanted soon, and each would otherwise be either an
override fighting a shared default or Nebula vocabulary pushed into the MIT package.

### The `instanceName` stamp, and what it actually costs

The registry builds a URL and the sender **re-parses the instance back out of it**
(`nebula-email-sender.ts` `parseInstanceName`). The direct design — passing the `instanceName` the
registry already holds — was rejected only because it would push Nebula vocabulary into the shared MIT
type. After the copy that reason is gone.

**It closes a correctness gap.** Tagging off the URL can only tag mail whose URL carries an instance
segment, so mail that *is* about an instance but links to `/app` would ship untagged though its
instance was known. ⚠️ **Latent today** — Nebula emits only `magic-link` and `invite-new`, both
instance-bearing — but `invite-existing` is exactly the app-redirect shape that trips it and is one of
the variants wanted soon. The fix lands *before* the bug.

⚠️ **`instanceName` is REQUIRED, and the phase must EARN that — today it would buy nothing.** The claim
"required means the compiler forces every send site to supply it" is false as the code stands:
`nebula-auth-registry.ts:1025` is `#sendEmail(message: any)` reading `(this.env as any).AUTH_EMAIL_SENDER`,
so `EmailMessage` is type-erased twice, and CI runs vitest only — `type-check` is separate and manual.
Adding the field today produces **zero** diagnostics. ⇒ **Typing the choke point is part of the phase**:
`#sendEmail(message: EmailMessage)`, a typed `AUTH_EMAIL_SENDER` binding if it can be typed,
`npm run type-check` in the phase's success criteria, and a capable-of-failing check (deleting
`instanceName` from one send site must error). There are **three** send sites, not two —
`#resumeClaimIfOwner` (~`:467`) is the third and sits behind `if (this.#isTestMode) return`, so no
vitest test reaches it.

⚠️ **Three pieces of standing guidance expire with this phase and it owns rewriting all three:**
`nebula-email-sender.ts`'s `headers()` JSDoc argues in bold for the URL derivation being deleted;
`calibration.md` §2 cites that same derivation as its dated 2026-07-30 *derive-don't-enumerate* worked
example, and is **always loaded**; `INSTANCE_BEARING_ROUTES`'s *"the two ends fail apart silently"*
rationale stops being true once there are no two ends (the list keeps a separate job — it types
`instanceAuthUrl`'s `route` — so re-derive whether that alone earns its keep rather than deleting it;
`calibration.md` §4). Leave these and the next reader re-derives this change as a *reversal* to the
enumeration that shipped the untagged-invite bug.

## What "done" looks like

⚠️ **Not phases** — `/write-task` pass 2 writes those. This is what done *means*, plus the hazards.

- **The criterion is the MANIFEST, and it is self-verifying.** `@lumenize/auth` in neither
  `dependencies` nor `devDependencies` of `packages/nebula-auth/package.json` or `apps/nebula/package.json`
  (neither has a devDependency escape hatch), verified by `npm ls @lumenize/auth`. ⚠️ **A grep for the
  import string is the weaker form and must not be the criterion** — it passes while the affordance
  remains.
- **Repo-wide sweep criterion, not a count.** `grep -rln "@lumenize/auth" --include="*.ts" packages apps`
  returns only `packages/auth/**` and `mesh/test/**`. Counts rot; this does not. *(Scale, so the phase
  is not surprised: nebula-auth 11 test files · apps/nebula 2 src + 50 test + 3 harness · mesh 2 src.)*
- **`grep -rn "@lumenize/auth/client" packages apps` returns nothing** — the subpath is deleted, not
  merely unused. Six live importers, plus four JSDoc/prose sites naming it as the canonical Node-safe
  pattern (`nebula-auth/src/testing.ts`, `access-claims.ts`, `create-nebula-test-token.ts`,
  `harness/lib/harness.ts`) and `backlog.md`.
- **The manifest change is one entry out and one entry IN.** `auth-email-sender-base.ts:2` imports
  `createEmailTransport` from `@lumenize/email`, which `nebula-auth` gets transitively today and does
  not declare. Copying the sender means **adding `@lumenize/email`**.
- **`@lumenize/crypto` carries its own tests** — its own vitest project and a `test` script, or
  `scripts/test-code.sh` (which tests a workspace *iff* its `package.json` has one) silently skips it
  and `scripts/release.sh` publishes it untested. Today there is no `jwt.test.ts`: coverage lives in
  `packages/auth/test/auth.test.ts`, which stays behind, and `verifyJwtWithRotation` has **zero** direct
  tests. Shipping the repo's highest-security-weight code with no owned tests would gut this file's own
  *one owner, fixes land once* premise. Also repoint `website/docs/auth/index.mdx` (a `@check-example`
  on `JwtPayload`, which hard-breaks under the type split) and `website/docs/mesh/lumenize-client.mdx`.
- ⚠️ **Extraction is a TYPE SPLIT, not a file move.** `jwt.ts`'s one type-only import points at
  `packages/auth/src/types.ts`, which mixes `ActClaim` / `JwtPayload` / `JwtHeader` in with `Subject` /
  `MagicLink` / `InviteToken` / `RefreshToken` / `EmailMessage` / `AuthRoutesOptions` / `CorsOptions` /
  `LoginResponse` / `AuthError`. `index.ts:58-72` likewise exports the three JWT types inside one block
  alongside ten that stay — so that edit is a **split, not a delete**. `hooks.ts:3` has a second
  `import type { JwtPayload }` the "two swaps" framing misses.
- **The `packages/auth` sweep is 2 swaps + 2 deletions.** `hooks.ts` and `lumenize-auth.ts` repoint
  `./jwt` → `@lumenize/crypto`; `client.ts` and `index.ts` are re-export barrels whose crypto blocks are
  **deleted**, which empties `client.ts` entirely and removes the `"./client"` entry from
  `packages/auth/package.json`. Dropping the symbols also breaks `for-docs/test-helpers.test.ts` and
  `endpoints.test.ts` on the auth side.
- ⚠️ **`nebula-email-sender.test.ts` is the ONE test that does not move mechanically.** Its whole subject
  is that `headers()` derives the tag from the URL without enumerating types — the mechanism the
  `instanceName` phase deletes. That phase **rewrites** it to assert the new contract. Treat "this test
  still passes unchanged" as a signal the phase did not land.
- **Nothing regresses:** `packages/auth` and `packages/nebula-auth` suites stay green *after* accounting
  for the split (state the post-move split, not a raw count), and the `/live` `impersonation-lifecycle`
  scenario — a real invite email end to end through the copied sender — still passes.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Extract the crypto core as `@lumenize/crypto`; `auth`, `mesh`, `nebula-auth` and `apps/nebula` all consume it** | *Copy it into `nebula-auth` and skip the package.* `mesh/src` needs real Ed25519 signing for `createTestRefreshFunction` (public API, `index.ts:83`) and cannot depend on `nebula-*`, so it would grow a **third** copy — worse than the two being collapsed. Relocating that helper to `@lumenize/testing` does not escape it either: `testing` depends only on `routing` + `rpc`, so the same need reappears there. Two packages that cannot depend on each other both need Ed25519; that is what a shared primitive package is for. |
| **`@lumenize/crypto` carries NO auth policy: `JwtPayload` is registered claims (`iss`/`aud`/`sub`/`exp`/`iat`/`jti`/`act`) plus a `claims` bag** | *Move `createJwtPayload` as-is.* It **requires** `emailVerified` + `adminApproved` — policy Nebula retired, which is why `verify.ts:40` double-casts today — so moving it verbatim would put auth's dead policy shape into the shared package and re-manufacture the false shared ownership this file exists to delete. `auth` and `nebula-auth` each layer their own flags on top. The general form costs the same or less than the narrow one (`workflow.md` § YAGNI), and it deletes the double-cast. |
| **Delete `generateUuid` entirely; call `crypto.randomUUID()` directly** | *Repoint its imports to `@lumenize/crypto`.* Its whole body is `return crypto.randomUUID()`, and `coding-style.md` § IDs says to call that directly. Deleting removes 50 `apps/nebula` test imports plus ~14 source sites from the sweep and conforms a rule instead of carrying a wrapper. |
| **`extractWebSocketToken` moves to `@lumenize/mesh`** | *Copy it into `nebula-auth` and re-export for `apps/nebula`.* It is the consumer half of a mesh wire protocol whose producer is `lumenize-client.ts:797` (`lmz.access-token.`); a never-re-sync header between two ends of a live protocol instructs the next session not to reconcile them, and the failure mode is a silent 401 on WS upgrade. Both consumers already depend on mesh, so importing costs less than the 13-line copy. Precedent: `nebula-auth/src/types.ts:14` already imports `TOKEN_REFRESH_AHEAD_SECONDS` from `@lumenize/mesh/client`. |
| **`ResolvedEmail` is imported from `@lumenize/email`, never copied** | *Copy it with the sender.* It is declared in `packages/email/src/types.ts` and merely re-exported by auth; copying makes a third declaration of a type the transport package owns. It is also the one member of the copy set that must stay in lockstep (the sender feeds it straight to `EmailTransport.sendEmail`), so it cannot carry a free-to-diverge header. `@lumenize/email` is becoming a direct dependency anyway. |
| **Collapse `AuthEmailSenderBase` + `NebulaEmailSender` into one `NebulaEmailSender`; rename the other copies on arrival** | *Copy the names verbatim.* The originals stay live in `mesh/test/**`, four `packages/auth/test/**` harnesses and five website docs, so identical names are ambiguous repo-wide — and the manifest removal only closes the accidental-*import* hazard inside `nebula-auth`, not the reader-ambiguity one everywhere else. With one consumer the base/subclass split abstracts nothing. |
| **`@lumenize/crypto` is published + MIT and joins the Lerna train** | *Mark it `private`.* Not rejected on preference — **unavailable**: published `@lumenize/mesh` takes it as a real `dependency`, and npm cannot resolve a private dep from a published package. Recorded because "a package named *crypto* should be private" is the predictable reflex (`calibration.md` §1) and acting on it would silently break external `npm i @lumenize/mesh`. Root `workspaces` is a `packages/*` glob, so it auto-enrols. |
| **Stamp `instanceName` on `EmailMessage` here, as a late phase** | *File it in `backlog.md`.* A backlog entry carries a re-reading cost that grows daily and the context is loaded now; doing it in-file makes the split deliver a working improvement instead of only preventing drift. ⚠️ Rejected as an *objection*: "it reshapes `EmailMessage`, so a green suite no longer proves the copy faithful" — true of one commit, not of a separate late phase with its own criteria. |
| **`instanceName` is REQUIRED on every `EmailMessage` variant** | *Make it optional so the three unemitted variants need not supply it.* Optional rebuilds the silent per-type enumeration that already shipped untagged invite mail once. ⚠️ Required only buys compile-time totality if the phase also types `#sendEmail` and runs `type-check` — see *Design intent*. |
| **Copy all five email templates, subjects and `EmailMessage` variants verbatim** | *Prune the three Nebula never emits.* Nebula sends only `magic-link` and `invite-new` today, so `admin-notification` / `approval-confirmation` / `invite-existing` look dead — but at least one is wanted soon, so this is not a YAGNI question. ⚠️ A second reason (they were the fixtures proving URL-derived tagging) is **spent** — the `instanceName` phase deletes that mechanism. Do not re-cite it. |
| **The `ActClaim` narrow/wide split survives extraction unchanged** | *Fold `nebula-auth`'s widening into `@lumenize/crypto` now that we own it.* ADR-016 / `nebula-pre-alpha.md` schema surgery deletes `projectActClaim` anyway, so widening now buys a shape about to change. ⚠️ Two JSDoc blocks assert the old home and sit adjacent to import lines this task already edits — `nebula-auth/src/types.ts:25-32` (which names *this file* as the reconciler) and `apps/nebula/src/resources.ts:11-17,71`. The phase owns both. |
| **Drop the ten crypto symbols from `@lumenize/auth`'s public API** | *Re-export them for backward compatibility.* No live users, so there is nothing to stay compatible with; a shim is a second reference to the code extraction exists to give one owner. Apply the same no-shim rule to the three JWT types. |
| **`@lumenize/auth` stays published and documented** | *Deprecate it.* Its low adoption is an argument about *investment*, not deletion, and not this file's question. What this file buys is that deprecating it later becomes possible. |
| **The package is `@lumenize/crypto`** | *`@lumenize/jwt`*, and *a compound name.* After the policy reshape above, every symbol is a `crypto`-global wrapper — `crypto.subtle` Ed25519, `getRandomValues`, `subtle.digest` — so the name is accurate. A compound name bakes today's contents into the identifier and rots on the next wrapper. |

## Relationships

- **Supersedes** [icebox/auth-token-core-compose-not-fork.md](icebox/auth-token-core-compose-not-fork.md)
  (moved 2026-07-31), which targeted the ~1,400-line DO orchestration body rather than the leaf.
  ⚠️ **Its file:line map is dead** — it cites `packages/nebula-auth/src/nebula-auth.ts`, which no longer
  exists. Do not port those line numbers; do not treat it as a live plan.
- **The orchestration-body de-fork stays out of scope** and has no live task file. ⚠️ If revived, its
  mechanism must change: this file removes `@lumenize/auth` from `nebula-auth`'s manifest, so a shared
  session core can no longer be *"nebula-auth composes @lumenize/auth"* — it must be a third extracted
  package both consume. **Share via extraction, never by depending on the auth product.**
- **Does NOT fix the rotation drift, deliberately.** That is a conformance fix inside `packages/auth`.
  What decoupling buys is that the fix becomes **safe to make independently**.
  [backlog.md](backlog.md) § `@lumenize/auth`.
- **Closes half of [backlog.md](backlog.md) § Lumenize Mesh's `createTestRefreshFunction` row** — moving
  it to `@lumenize/crypto` (no `cloudflare:workers`) fixes the Node-load half for free, and ⚠️ **invalidates
  that row's prescribed remedy**, which names the `@lumenize/auth/client` subpath this task deletes.
  Re-scope it to the residual gap (not exported from `mesh/src/client-index.ts`) — or close it outright
  with the one-line export, which also gives the extraction the Node-import regression test it lacks.
- **Does NOT resolve the test-mode gating asymmetry**, though [backlog.md](backlog.md):41 names this file
  as its home under the dead title `auth-token-core-compose-not-fork`. Repoint that link and re-scope the
  row; threading an explicit flag through the RPC is separate work.
- **Follows** [archive/nebula-impersonation-client.md](archive/nebula-impersonation-client.md), whose
  `headers(message)` breaking change surfaced the ceremony cost.
