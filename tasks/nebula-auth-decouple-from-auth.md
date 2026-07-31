# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 📝 **DRAFTED 2026-07-31.** Hand-reviewed · `/review-task` **Stage 1** resolved (20 findings,
all applied) · phases written (`/write-task` pass 2). **Next: Stage 2 conformance review**, then
`/build-task`.

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
| `jwt.ts` — Ed25519 sign/verify/importKeys, `hashString`, `generateRandomString`, `parseJwtUnsafe`, `createJwtPayload`, `generateUuid` + the `JwtPayload` / `JwtHeader` / `ActClaim` types | 281 | mesh (`src`), nebula-auth (`src` + tests), apps/nebula (`src` type-only, + harness) | **HIGH** — crypto, incl. BLUE/GREEN key rotation (`verifyJwtWithRotation`) | **Extract** → `@lumenize/crypto`, reshaped — except `generateUuid`, which is **deleted** (Phase 1) |
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
  deletion (Phase 3) or the `/live` acceptance criteria in Phases 3, 5 and 6 cannot even boot. It is
  also the surface that actually proves `@lumenize/crypto` is Node-safe.

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
| **The `ActClaim` narrow/wide split survives extraction unchanged** | *Fold `nebula-auth`'s widening into `@lumenize/crypto` now that we own it.* ADR-016 / `nebula-pre-alpha.md` schema surgery deletes `projectActClaim` anyway, so widening now buys a shape about to change. ⚠️ Two JSDoc blocks assert the old home and sit adjacent to import lines this task already edits — `nebula-auth/src/types.ts:25-32` (which names *this file* as the reconciler) and `apps/nebula/src/resources.ts:11-17,71`. **Phase 3 owns both**, since it moves the imports they sit next to. |
| **Drop the ten crypto symbols from `@lumenize/auth`'s public API** | *Re-export them for backward compatibility.* No live users, so there is nothing to stay compatible with; a shim is a second reference to the code extraction exists to give one owner. Apply the same no-shim rule to the three JWT types. |
| **`@lumenize/auth` stays published and documented** | *Deprecate it.* Its low adoption is an argument about *investment*, not deletion, and not this file's question. What this file buys is that deprecating it later becomes possible. |
| **The package is `@lumenize/crypto`** | *`@lumenize/jwt`*, and *a compound name.* After the policy reshape above, every symbol is a `crypto`-global wrapper — `crypto.subtle` Ed25519, `getRandomValues`, `subtle.digest` — so the name is accurate. A compound name bakes today's contents into the identifier and rots on the next wrapper. |

## Phases

Numbering is executable order. Every phase must leave the tree green — `npm run type-check` *and*
`npm run test:code` — because a broken intermediate commit here spans four packages.

⚠️ **Phase 1 first for a reason:** it is pure subtraction and removes ~64 files from every later
sweep. Doing it after the extraction would mean repointing 50 imports and then deleting them.

### 1. `generateUuid` is gone; the repo calls `crypto.randomUUID()` directly

Its whole body is `return crypto.randomUUID()`, which `coding-style.md` § IDs says to call directly.
Delete the export and rewrite ~14 source sites (`auth/src` ×4, `nebula-auth/src` ×3 plus call sites,
`apps/nebula/harness` ×2) and ~64 test imports (`apps/nebula/test` ×50 — all of them `generateUuid` —
plus `nebula-auth/test`). `createJwtPayload`'s `jti` becomes a direct call.

- **Success criteria (capable of failing):** `grep -rn '\bgenerateUuid\b' packages apps` returns
  nothing outside `node_modules`; `npm run type-check` clean; all suites green.
- **Mutation note:** restore any single `generateUuid()` call — the grep returns it *and* the import
  fails to resolve, since the export no longer exists.

### 2. `JwtPayload` carries registered claims only; no consumer casts around it

Reshape **in place, inside `packages/auth`**, before anything moves — so Phase 3 is a pure relocation
and the new package is never born carrying auth's retired policy. `JwtPayload` becomes
`iss`/`aud`/`sub`/`exp`/`iat`/`jti`/`act?` plus a `claims` bag; `createJwtPayload` takes the bag;
`auth`'s two mint sites pass `{ emailVerified, adminApproved, isAdmin }` through it;
`mesh/src/create-test-refresh-function.ts` and `apps/nebula/harness/lib/harness.ts` follow.

- **Success criteria (capable of failing):** `JwtPayload` declares no `emailVerified`,
  `adminApproved` or `isAdmin`; `grep -rn 'as unknown as NebulaJwtPayload' packages/nebula-auth/src`
  returns nothing (the cast at `verify.ts:40` exists *because* of the policy fields, so it must
  disappear on its own, not be deleted by hand); `npm run type-check` clean; auth, nebula-auth and
  mesh suites green.
- **Mutation note:** delete the `...claims` spread in `createJwtPayload` — auth's minted tokens lose
  `emailVerified` and `packages/auth/test/auth.test.ts` reds.

### 3. `@lumenize/crypto` owns the core; every consumer points at it; `@lumenize/auth/client` is deleted

The new package (own `vitest` project **and a `test` script**), the crypto assertions lifted out of
`packages/auth/test/auth.test.ts`, `auth`'s import swaps and re-export-block deletions, `client.ts`
deleted with its `"./client"` exports-map entry, and every consumer repointed: `mesh/src` ×2,
`nebula-auth/src`, `apps/nebula/src` (`ActClaim`), plus the four JSDoc/prose sites that name the
doomed subpath as the canonical Node-safe pattern.

⚠️ **This is a TYPE SPLIT, not a file move — the seam most likely to be under-estimated.** `jwt.ts`
has one type-only import and it points at `packages/auth/src/types.ts`, which mixes `ActClaim` /
`JwtPayload` / `JwtHeader` in with `Subject` / `MagicLink` / `InviteToken` / `RefreshToken` /
`EmailMessage` / `AuthRoutesOptions` / `CorsOptions` / `LoginResponse` / `AuthError`. Three edits the
"two swaps and two deletions" shorthand hides: `types.ts` is cut (JWT types leave, the rest stays);
`index.ts:58-72` exports the three JWT types inside **one block alongside ten that stay**, so that is
a *split*, not a delete, and treating it as a delete over-deletes; and `hooks.ts:3` carries a second
`import type { JwtPayload }` beyond its value import. Confirm the seam is as clean as it looks before
moving any code.

⚠️ **`apps/nebula/harness/` moves in THIS phase — the constraint is hard.** It is the shared boot for
all six `/live` scenarios, so splitting it out leaves the acceptance instrument unable to start. It
also runs under plain Node/tsx, which makes it the only surface that actually proves the new package
is Node-safe (zero `cloudflare:workers` reachability) — the property `/client` existed to provide.

- **Success criteria (capable of failing):** `grep -rn "@lumenize/auth/client" packages apps` returns
  nothing and `packages/auth/package.json` has no `"./client"` key; `npm run test:code` output
  **names the crypto project** (not merely "green" — `test-code.sh` tests a workspace *iff* its
  `package.json` has a `test` script, so a script-less package passes by being skipped);
  `verifyJwtWithRotation` has at least one direct test, which it has zero of today; `/live`
  `impersonation-lifecycle` boots and passes; `npm run test:doc` green after repointing
  `website/docs/auth/index.mdx`'s `@check-example` on `JwtPayload` and
  `website/docs/mesh/lumenize-client.mdx`'s "auth defines the `JwtPayload` shape".
- **Mutation note:** remove the `test` script from `packages/crypto/package.json` — the `test:code`
  criterion reds. Today that same removal would pass silently, which is the failure this criterion
  is shaped to catch.
- **Standing guidance:** the two website repoints live here because Phase 3 is the last phase that
  changes what they describe. Same for `backlog.md` § Lumenize Mesh's `createTestRefreshFunction`
  row, whose prescribed remedy names the subpath this phase deletes — re-scope it to the residual
  `client-index.ts` export gap, or close it outright with the one-line export.

### 4. The WebSocket subprotocol token is defined once, in the package that produces it

`extractWebSocketToken` and the `lmz.access-token.` prefix move into `@lumenize/mesh`, whose
`lumenize-client.ts:797` writes that prefix. `nebula-auth/src/router.ts` and
`apps/nebula/src/entrypoint.ts` import from there; both already depend on mesh.
`packages/auth/src/hooks.ts` keeps its own copy — auth is going leaf and still serves its own users.

- **Success criteria (capable of failing):** the prefix is an exported constant appearing exactly once
  in `mesh/src`; neither consumer declares its own; a mesh test round-trips producer → consumer.
- **Mutation note:** change the prefix in `lumenize-client.ts`'s producer only — the round-trip test
  reds. **No test couples the two ends today**, which is precisely what made copying this dangerous.

### 5. The manifest drops `@lumenize/auth` — the objective lands

Copy the email sender, **collapsed into a single `NebulaEmailSender`** (one consumer, so the
base/subclass split abstracts nothing), and turnstile, both renamed on arrival. `ResolvedEmail` is
imported from `@lumenize/email`, never copied; `@lumenize/email` joins nebula-auth's manifest as
`@lumenize/auth` leaves it. `apps/nebula` and `mesh`'s `dependencies` drop it too — mesh keeps a
`devDependency` for its for-docs mini-apps, which are real consumers.

- **Success criteria (capable of failing):** `npm ls @lumenize/auth` resolves nothing from
  `packages/nebula-auth` or `apps/nebula`; `grep -rln "@lumenize/auth" --include="*.ts" packages apps`
  returns only `packages/auth/**` and `packages/mesh/test/**`; every copied file's header names its
  origin, the date, and that it is a deliberate divergence not to be re-synced; `/live`
  `impersonation-lifecycle` passes, driving a real invite email through the copied sender.
- **Mutation note:** restore `"@lumenize/auth"` to `packages/nebula-auth/package.json` — `npm ls`
  finds it. ⚠️ A grep-only criterion would **stay green** through that mutation, which is why the
  manifest and not the import is the criterion.
- **Standing guidance:** repoint `backlog.md`:41, which names this task as the home for the test-mode
  gating asymmetry under the dead title `auth-token-core-compose-not-fork`, and re-scope it (see
  *Non-goals*).

### 6. The sender is told the instance instead of inferring it

**Type the choke point first, or the rest of this phase is decorative:** `#sendEmail(message: EmailMessage)`
and a typed `AUTH_EMAIL_SENDER` binding, replacing `#sendEmail(message: any)` over `(this.env as any)`.
Only then add the required `instanceName` to every `EmailMessage` variant, stamp `headers()` from the
field, delete `parseInstanceName`, and rewrite `nebula-email-sender.test.ts`.

- **Success criteria (capable of failing):** `npm run type-check` clean — named explicitly because **CI
  does not run it**, so this phase's guarantee is a desk-time type error rather than a merge gate;
  `parseInstanceName` is gone from `nebula-email-sender.ts`; `nebula-email-sender.test.ts` asserts
  stamping-from-field rather than URL derivation (⚠️ if that file still passes *unchanged*, the phase
  did not land); `/live` invite mail carries `X-Lumenize-Auth-Instance`.
- **Mutation note:** delete `instanceName` from **each of the three** send sites in turn — every one
  must red `type-check`. Check all three rather than sampling: `#resumeClaimIfOwner` sits behind
  `if (this.#isTestMode) return`, so no vitest test reaches it and only the type-check can catch it.
- **Standing guidance — three sites expire with this phase and it owns all three:**
  `nebula-email-sender.ts`'s `headers()` JSDoc, which argues in bold for the derivation being deleted;
  `calibration.md` §2's dated 2026-07-30 worked example, which is **always loaded** and would otherwise
  present this change as a reversal to the enumeration that shipped the untagged-invite bug; and
  `INSTANCE_BEARING_ROUTES`'s *"the two ends fail apart silently"* rationale — **re-derive** whether the
  list still earns its keep on its remaining job (typing `instanceAuthUrl`'s `route`) rather than
  deleting it because its reason died (`calibration.md` §4).

## Non-goals

- **The orchestration-body de-fork.** No live task file; *Relationships* records the constraint any
  revival must honour.
- **Fixing the rotation drift.** A conformance fix inside `packages/auth` — [backlog.md](backlog.md)
  § `@lumenize/auth`. What this task buys is that it becomes safe to make independently.
- **Closing the test-mode gating asymmetry.** Threading an explicit flag through the RPC is separate
  work; Phase 5 only repoints and re-scopes the backlog row that names this file as its home.
- **Nebula-specific email templates.** Phase 5 unblocks them; writing them is later work.
- **Deleting `instanceAuthUrl` / `INSTANCE_BEARING_ROUTES`.** Phase 6 re-derives whether they still
  earn their keep; deletion is not assumed.
- **Deprecating `@lumenize/auth`.** It stays published and documented; this task only makes deprecating
  it possible later.

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
