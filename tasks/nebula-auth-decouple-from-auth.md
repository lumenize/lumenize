# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 🔨 **BUILDING (started 2026-07-31).** Hand-reviewed · `/review-task` **Stage 1** resolved
(20 findings) · phases written (`/write-task` pass 2) · **Stage 2** resolved (two passes, 40+ findings,
4 ADR-001 erosions). `/build-task` in progress on `pre-alpha`: **Phase 1 ✅ · Phase 2 ✅** · Phases 3–6
pending.

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
  ⚠️ **47 of the 50** test imports are `generateUuid` alone, which is **deleted rather than repointed**
  (Decisions). The other three — `test-helpers.ts` and both `scope-verification.test.ts` — also import
  `signJwt` / `importPrivateKey` / `parseJwtUnsafe` and so must be repointed in Phase 3, not deleted.
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

⚠️ **Standing guidance expires with this phase across more sites than anyone first counts**, always-loaded
`calibration.md` §2 among them — leave them and the next reader re-derives this change as a *reversal*
to the enumeration that shipped the untagged-invite bug. Phase 6 sweeps them **by instrument, not by
count**; the count is what an earlier draft got wrong.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Extract the crypto core as `@lumenize/crypto`; `auth`, `mesh`, `nebula-auth` and `apps/nebula` all consume it** | *Copy it into `nebula-auth` and skip the package.* `mesh/src` needs real Ed25519 signing for `createTestRefreshFunction` (public API, `index.ts:83`) and cannot depend on `nebula-*`, so it would grow a **third** copy — worse than the two being collapsed. Relocating that helper to `@lumenize/testing` does not escape it either: `testing` depends only on `routing` + `rpc`, so the same need reappears there. Two packages that cannot depend on each other both need Ed25519; that is what a shared primitive package is for. |
| **The bag is named `customClaims`, not `claims`** | *`claims`.* `mesh` already has two `claims`, both meaning **the whole verified payload** (`OriginAuth.claims`, `client.claims`) — and because the bag spreads flat at mint, the two sit at opposite ends of one data flow: same word, different extents, which is `calibration.md` §5's rename tell. `customClaims` is not a coinage but RFC 7519 §4.3's private-claims concept under the spelling the dominant JWT libraries use, and `NebulaJwtPayload`'s own JSDoc already says *"a bare, first-party CUSTOM claim (RFC 7519 §4.3)"*. It is also **falsifiable** where `claims` asserts nothing: "custom" means "not registered", which is precisely the precedence rule the implementation must honour. |
| **The bag is OPTIONAL, and that is what pays for the reshape** | *Make it required.* Optional is what makes `NebulaJwtPayload` (standalone, required `access`) structurally assignable to `JwtPayload` — which deletes `worker-token.ts:224`'s `signJwt(payload as any, …)`, Nebula's sole production signing call, and collapses `verify.ts:40`'s double cast to a single legal `as`. Required buys neither. |
| **`@lumenize/crypto` carries NO auth policy: `JwtPayload` is registered claims (`iss`/`aud`/`sub`/`exp`/`iat`/`jti`/`act`) plus an optional `customClaims` bag** | *Move `createJwtPayload` as-is.* It **requires** `emailVerified` + `adminApproved` — policy Nebula retired — so moving it verbatim would put auth's dead policy shape into the shared package and re-manufacture the false shared ownership this file exists to delete. Each layer declares its own typed claims interface instead (`packages/auth` gets `AuthClaims`), and the general form costs the same or less than the narrow one (`workflow.md` § YAGNI). ⚠️ **An earlier draft claimed those required fields are *why* `verify.ts:40` double-casts. That was false and unchecked** — `createJwtPayload` has **zero** callers in `nebula-auth/src` (Nebula mints via `buildNebulaJwtPayload`), and the cast's real cause is that `NebulaJwtPayload` is a standalone interface with a required `access`. The casts go away because the bag is *optional*, not because the flags left. |
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
Delete the export and rewrite **every reference** — enumerate with
`grep -rn '\bgenerateUuid\b' packages apps` (~360 lines / ~320 of them in `apps/nebula/test` at time
of writing). ⚠️ **This is the largest diff in the task, not a small one**: each site is a *call* to
rewrite, not just an import to drop, and the mechanical test sweep is interleaved with real source
edits in `packages/auth/src` and `packages/nebula-auth/src` (including `createJwtPayload`'s `jti`).
Land the mechanical sweep as its own commit so a regression in the source edits is not buried under
300 mechanical lines.

- **Success criteria (capable of failing):** `grep -rn '\bgenerateUuid\b' packages apps` returns
  nothing outside `node_modules`; `npm run type-check` clean; all suites green.
- **Mutation note:** restore any single `generateUuid()` call — the grep returns it *and* the import
  fails to resolve, since the export no longer exists.

### 2. Auth policy leaves the shared payload type, and every end that reads it stays typed

Reshape **in place, inside `packages/auth`**, before anything moves — so Phase 3 is a pure relocation
and the new package is never born carrying auth's retired policy.

⚠️ **This is a CONSUMER phase as much as a producer phase.** An earlier draft enumerated only mint
sites, which is what let four ADR-001 erosions hide in it: the flags stop being statically typed
exactly where they gate access. The contract below is the phase.

- **`JwtPayload`** becomes the six registered claims (`iss`/`aud`/`sub`/`exp`/`iat`/`jti`) plus `act?`
  and **`customClaims?`**. The bag is **optional** and gets **no index signature**.
- **The bag is spread FLAT at mint — the wire format does not change.** Load-bearing outside auth:
  `mesh/src/lumenize-client-gateway.ts:269` builds `originAuth.claims` as `{ ...jwtPayload, ... }`, so
  a nested bag would silently become `originAuth.claims.customClaims.isAdmin` and break the guards in
  `mesh/test/for-docs/security/`.
  - ⚠️ **CORRECTED DURING BUILD (2026-07-31): that guard existed but NOTHING EXERCISED IT.**
    `for-docs/security/index.test.ts:128` was a `TODO` ("Bob (no isAdmin) fails, Admin … succeeds"),
    and the only other end-to-end `originAuth.claims.isAdmin` assertion
    (`lumenize-client-gateway.test.ts:288`) mints via `createFakeJwt`, a hand-built token that never
    calls `createJwtPayload`. So **no existing test could fail on the nesting mutation** and this
    criterion had no instrument. The build implements the TODO over the real path (real client →
    Worker fetch → auth hooks → Gateway → DO, no test-mode infrastructure), which is the tier-1
    venue for this code — Nebula's `/live` cannot cover it, because Nebula mints via
    `buildNebulaJwtPayload` and never reaches `createJwtPayload`.
- **`packages/auth` declares its own `AuthClaims { emailVerified: boolean; adminApproved: boolean; isAdmin?: boolean }`
  and narrows BOTH ends through it** — the mint site passes `customClaims: AuthClaims`, and
  `hooks.ts`'s `verifyAndGate` narrows through it rather than reading the bag inline. This is what
  keeps the access gate type-checked; see the consumer list below.
- **Registered claims win.** Spread `customClaims` **first** in `createJwtPayload`, or reject the
  seven registered names outright. The name is the argument: a *custom* claim is by definition not a
  registered one. (Today every field is a named scalar parameter, so this footgun is structurally
  impossible; the bag creates it, and Phase 3 publishes it.)

**Consumers, not just producers** — the flags' only src-side token reader is `packages/auth/src/hooks.ts:129`,
`if (!payload.isAdmin && !(payload.emailVerified && payload.adminApproved))`, which is `@lumenize/auth`'s
**entire** access decision for `onBeforeRequest` *and* `onBeforeConnect`. (Every other
`emailVerified`/`adminApproved` hit in `auth/src` reads the `Subjects` SQL row — a different source.)
Also in scope: `mesh/src/lumenize-client-gateway.ts:269` + `originAuth.claims`, and the single mint
site `lumenize-auth.ts:1292` (**one**, not two — its two callers are `:374`/`:971`), preserving the
`Boolean()` conversion at `:1263`. Outside auth, `mesh/src/create-test-refresh-function.ts` and
`apps/nebula/harness/lib/harness.ts` are the only other `createJwtPayload` callers.

⚠️ **`nebula-auth` does not call `createJwtPayload` at all** — it mints via `access-claims.ts`
`buildNebulaJwtPayload`. What the optional bag buys there is **assignability**: `NebulaJwtPayload`
(standalone, with a required `access`) becomes structurally assignable to `JwtPayload`, which deletes
`worker-token.ts:224`'s `signJwt(payload as any, …)` — Nebula's **sole production signing call** — and
collapses `verify.ts:40`'s `as unknown as` to a single legal `as`. That is the real prize of the
reshape and it depends on the bag being optional.

- **Success criteria (capable of failing):**
  - `JwtPayload` declares no `emailVerified` / `adminApproved` / `isAdmin` and no index signature.
  - **Flat wire:** a token minted with `customClaims: { isAdmin: true }` decodes with `isAdmin` at the
    payload's **top level**, and `originAuth.claims.isAdmin` is `true` end to end through the Gateway.
  - **Precedence:** `createJwtPayload({ subject: 'a', …, customClaims: { sub: 'b', exp: 9e9 } })`
    yields `sub === 'a'` and the computed `exp`.
  - **The gate stays typed, symmetrically:** `grep -nE 'as any|as unknown as' packages/auth/src/hooks.ts`
    returns nothing, **and** `grep -n 'signJwt(payload as any' packages/nebula-auth/src/worker-token.ts`
    returns nothing. ⚠️ The earlier one-sided criterion (banning casts in `nebula-auth/src` while
    silent on `auth/src`) let the phase claim credit for deleting one cast while creating another.
  - `npm run type-check` clean; auth, nebula-auth and mesh suites green; `/live impersonation-lifecycle`
    passes (it is in CI, so it is free — `message-roundtrip` is not).
- **Mutation notes:** (a) rename the bag key at the mint site (`emailVerifed`) → `type-check` reds,
  because both ends narrow through `AuthClaims`; (b) move the `customClaims` spread to the end →
  the precedence test reds; (c) nest the bag instead of spreading → the Gateway end-to-end test reds.
- **Standing guidance — the SHAPE rewrites belong here, not in Phase 3.** Phase 3 changes only the
  annotation's *path*; this phase falsifies the content. Owns: `website/docs/auth/index.mdx:133`'s
  `@check-example` block (it mirrors `types.ts` field-for-field, including the flags) plus the flags
  in that file's prose and mermaid, which `@check-example` never guards; `website/docs/mesh/lumenize-client.mdx:104`
  (its "declare additional claims in a module augmentation" recipe is obsoleted by the bag);
  `website/docs/mesh/security.mdx` :66-81, :106, :123 and especially **:199**, whose member list
  (`emailVerified`, `adminApproved`, `isAdmin`, `act`) should be rewritten to describe the
  **derivation** — *"whatever claims the verified JWT carries become `originAuth.claims`"* — so the
  next claim added does not recreate this drift; `website/docs/mesh/testing.mdx:83-96` (⚠️ **no edit
  needed** — it documents `createTestRefreshFunction`'s *options*, whose public names are unchanged;
  only the internal wiring moved into `customClaims`); and
  `apps/nebula/harness/lib/harness.ts:339-348`'s `mintDegradedToken` JSDoc (an ADR-009 rung-4
  negative control that pins the flat-`isAdmin` shape). **Doc criterion:** `cd website && npm run check-examples`
  clean — ⚠️ *not* `npm run test:doc`, which opens `set +e`, ends in a literal `exit 0`, and never
  evaluates `@check-example` at all.

### 3. `@lumenize/crypto` owns the core; every consumer points at it; `@lumenize/auth/client` is deleted

The new package, `auth`'s import swaps and re-export-block deletions, `client.ts` deleted with its
`"./client"` exports-map entry, and every consumer repointed: `mesh/src` ×2, `nebula-auth/src`,
`apps/nebula/src` (`ActClaim`), the four JSDoc/prose sites naming the doomed subpath, and — omitted
from an earlier draft — **both test trees**: `packages/nebula-auth/test/**` (11 importers of
`hashString` / `parseJwtUnsafe` / `signJwt` / `importPrivateKey` / `type EmailMessage` /
`type ResolvedEmail`) and `apps/nebula/test/**` ×3. ⚠️ Since the ten symbols leave `auth`'s public API
with **no shim**, those ~14 files break **here, not in Phase 5** — the phase cannot be green without
them. Two of the three (`scope-verification.test.ts` ×2) are crafted-JWT negative controls for
`matchAccess`: **change the import specifier only, never the token shape.**

**The new package must be publishable, and none of that is visible to `type-check` / `test:code` / `/live`.**
Use `packages/structured-clone/` as the template — **not** `email` or `sql-migrations`, which lack
`tsconfig.build.json`. It needs: `version` at the current Lerna version (a `0.0.0` package makes root
`npm install` fetch from the registry and 404, breaking this very commit, since `mesh` pins siblings
`^0.26.0`), `publishConfig.access: public`, `files`, `tsconfig.json` (absent ⇒ `type-check.sh`'s
`packages/*/tsconfig.json` glob **silently skips the package**, vacating this file's own green gate),
`tsconfig.build.json` (`build-packages.sh` runs `tsc -p` under `set -e`), LICENSE and README
(`packaging.md` § Standard package files).

⚠️ **Declare the dependency in all four consumers** — `auth`, `mesh`, `nebula-auth`, `apps/nebula`.
Root `node_modules/@lumenize/*` symlinks resolve an **undeclared** import, so `type-check`,
`test:code` and every `/live` boot pass without it and the failure surfaces only as two broken
*published* packages. This is the file's own *manifest is the guard* principle applied to itself.

⚠️ **Write the crypto suite FRESH — there is nothing to lift.** Every `signJwt` / `verifyJwt` /
`createJwtPayload` use in `packages/auth/test/auth.test.ts` is fixture construction inside route/hook/DO
integration tests; the two most crypto-shaped (`'returns 403 when access gate fails'`, `'supports key
rotation'`) assert on `createRouteDORequestAuthHooks(...).onBeforeRequest` and **belong to
`packages/auth`**. Moving them would silently delete auth's only coverage of the `hooks.ts:129` gate
and of BLUE/GREEN rotation, leaving the auth suite green and smaller. Pin the runtime as **plain-Node
vitest** with keys generated in-test via `crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify'])`
— no `.dev.vars`, no pool-workers, and it doubles as the Node-safety proof (PEM-wrap the keys so
`importPrivateKey`/`importPublicKey` are exercised).

⚠️ **This is a TYPE SPLIT, not a file move — the seam most likely to be under-estimated.** `jwt.ts`
has one type-only import and it points at `packages/auth/src/types.ts`, which mixes `ActClaim` /
`JwtPayload` / `JwtHeader` in with `Subject` / `MagicLink` / `InviteToken` / `RefreshToken` /
`EmailMessage` / `AuthRoutesOptions` / `CorsOptions` / `LoginResponse` / `AuthError`. Three edits the
"two swaps and two deletions" shorthand hides: `types.ts` is cut (JWT types leave, the rest stays);
`index.ts:58-72` exports the three JWT types inside **one block alongside ten that stay**, so that is
a *split*, not a delete, and treating it as a delete over-deletes; and `hooks.ts:3` carries a second
`import type { JwtPayload }` beyond its value import.

⚠️ **`apps/nebula/harness/` moves in THIS phase.** It is the shared boot for all six `/live`
scenarios, so splitting it out leaves the acceptance instrument unable to start. It also runs under
plain Node/tsx, which makes it the surface that proves the new package is Node-safe (zero
`cloudflare:workers` reachability) — the property `/client` existed to provide. *(The coupling is to
the subpath deletion specifically; the phase bundles the rest by choice, for one green commit.)*

- **Success criteria (capable of failing):**
  - `grep -rn "@lumenize/auth/client" packages apps` returns nothing, and `packages/auth/package.json`
    has no `"./client"` key.
  - `npm ls @lumenize/crypto -w @lumenize/auth -w @lumenize/mesh -w @lumenize/nebula-auth -w @lumenize/nebula`
    resolves in all four — the manifest test, mirroring Phase 5's.
  - `./scripts/test-code.sh --list` names `@lumenize/crypto`, and `type-check.sh` output names it too
    (a package with no `test` script or no `tsconfig.json` is **skipped**, not failed).
  - `npm pack --dry-run -w @lumenize/crypto` lists the sources; a Node-import smoke test modelled on
    `packages/mesh/test/node-import.test.mjs` passes.
  - `verifyJwtWithRotation` is tested **over its mechanism**: a token signed with the GREEN key
    verifies when GREEN is **second** in the array, and a token signed with neither returns `null`.
  - `packages/auth/test/auth.test.ts` still contains `'returns 403 when access gate fails'` and
    `'supports key rotation'`, both passing.
- **Mutation notes:** (a) replace `verifyJwtWithRotation`'s body with `return verifyJwt(token, publicKeys[0])`
  → the GREEN-second test reds; (b) remove `packages/crypto`'s `test` script → the `--list` criterion
  reds (today the same removal passes silently); (c) drop one of the four manifest entries →
  `npm ls` reds while every suite stays green.
- **Standing guidance:** the website **path** repoints (Phase 2 owns their content); `backlog.md`
  § Lumenize Mesh's `createTestRefreshFunction` row, whose prescribed remedy names the subpath this
  phase deletes — re-scope it to the residual `client-index.ts` export gap and record *why* the
  "close it outright" option is rejected: `create-test-refresh-function.ts:74` holds a static
  `'cloudflare:test'` literal, which a bundler resolves even inside `await import(...)`, so it cannot
  go on mesh's browser-safe entry. Add `packages/crypto/**/*.ts` to `.claude/rules/security.md`'s
  `paths:` — otherwise the repo's highest-security-weight code lives where the security rule does not
  load. Add `apps/nebula/src/client-index.ts:40`'s comment (which names `@lumenize/auth` next to the
  `ActClaim` re-export this phase repoints) to the owned prose sites.

### 4. The WebSocket subprotocol token is defined once on the Nebula path, in the package that produces it

`extractWebSocketToken` and the `lmz.access-token.` prefix move into **`packages/mesh/src/client-index.ts`**
(not the root barrel — `nebula-auth/src/router.ts` is re-exported from `nebula-auth`'s widely-imported
index, so a root-barrel import drags `cloudflare:workers` through it, the bare-`SyntaxError` failure
`packaging.md` documents; precedent is `nebula-auth/src/types.ts:14` already importing from
`@lumenize/mesh/client`). `nebula-auth/src/router.ts` and `apps/nebula/src/entrypoint.ts` import from
`@lumenize/mesh/client`; both packages already depend on mesh.

⚠️ **`packages/auth/src/hooks.ts:6` keeps a KNOWN second copy, deliberately** — auth must not depend
on mesh, and mesh routes its own e2e WebSocket upgrades through auth's hooks (`mesh/test/test-worker-and-dos.ts`,
`browser/worker/index.ts`, two for-docs workers), which is why Phase 5 keeps mesh's devDependency.
That end is already coupling-tested by `mesh/test/browser/ws-roundtrip-browser.test.ts`, which
round-trips the real `lumenize-client.ts:797` producer against auth's consumer in CI. Add reciprocal
comments at both sites naming the other end. The prefix is additionally a **published wire
convention** that `website/docs/mesh/security.mdx` teaches third parties to hand-implement, so
"defined once repo-wide" was never the property — "defined once on the Nebula path" is.

- **Success criteria (capable of failing):** the prefix is an exported constant in
  `mesh/src/client-index.ts`; neither Nebula consumer declares its own;
  `grep -n "@lumenize/mesh'" packages/nebula-auth/src/router.ts` returns nothing (it must use
  `/client`); a test pins the **literal** — `expect(WS_TOKEN_PREFIX).toBe('lmz.access-token.')` — and
  the four `extractWebSocketToken` tests at `auth/test/auth.test.ts:1182-1227` are ported, since they
  feed a hand-written header and so do not derive from the constant.
- **Mutation note:** change the exported constant → the pinned-literal test reds. ⚠️ A
  producer→consumer round-trip alone is **true by construction** once both ends share one constant,
  so it cannot fail on the real hazard (the constant changing under deployed clients).
- **Standing guidance:** amend `.claude/rules/mesh.md` § Package dependency direction, whose
  "auth/identity → `auth`/`nebula-auth`" clause now says the opposite of this phase. State the
  carve-out: **mesh owns the wire protocol** (producing and parsing the `lmz.access-token.`
  subprotocol); verification, gating and key handling stay in `auth`/`nebula-auth`. Without this a
  future session helpfully moves it back.

### 5. The manifest drops `@lumenize/auth` — the objective lands

Copy the email sender, **collapsed into a single `NebulaEmailSender`** (one consumer, so the
base/subclass split abstracts nothing), and turnstile, both renamed on arrival. `ResolvedEmail` is
imported from `@lumenize/email`, never copied; `@lumenize/email` joins nebula-auth's manifest as
`@lumenize/auth` leaves it. `apps/nebula` and `mesh`'s `dependencies` drop it too — mesh keeps a
`devDependency` for its for-docs mini-apps and browser worker, which are real consumers.

⚠️ **The copied `verifyTurnstileToken` lands somewhere that structurally cannot execute it.**
`packages/nebula-auth`'s vitest sets `NEBULA_AUTH_TEST_MODE: 'true'`, and `router.ts` `checkTurnstile`
short-circuits on that binding **before** reaching the secret or the siteverify call; the real
coverage (`auth.test.ts:2661`/`:2685`) stays with the original. A forked bot-defense primitive with no
executed coverage in its new home is worse than the shared one it replaced — so this phase owns
proving it, using an instrument that already exists.

- **Success criteria (capable of failing):**
  - `npm ls @lumenize/auth` resolves nothing from `packages/nebula-auth` or `apps/nebula`.
  - `grep -rln "@lumenize/auth" --include="*.ts" --exclude-dir=dist --exclude-dir=node_modules packages apps`
    returns only `packages/auth/**` and `packages/mesh/test/**`. ⚠️ This matches **prose as well as
    imports**, and `packages/email/src/types.ts` is allowed residue — triage every other hit rather
    than explaining it away; it is the only source-side detector of a missed import, since npm
    hoisting keeps `import '@lumenize/auth'` resolving after the manifest entry is gone.
  - Every copied file's header names its origin, the date, and that it is a deliberate divergence not
    to be re-synced.
  - **The copied turnstile actually runs:**
    `HARNESS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA npx tsx apps/nebula/harness/drive.ts turnstile-canary`
    passes (probe 4 makes a real siteverify call through the nebula-auth router).
  - `/live impersonation-lifecycle` passes, driving a real invite email through the copied sender.
- **Mutation notes:** (a) restore `"@lumenize/auth"` to `packages/nebula-auth/package.json` → `npm ls`
  reds, while a grep-only criterion would **stay green** — which is why the manifest is the criterion;
  (b) make the copied `verifyTurnstileToken` return `{ success: false }` unconditionally →
  `turnstile-canary` probe 4 reds. *(Not `{ success: true }`, which blocks at `turnstile_required`
  before the call.)*
- **Standing guidance:** repoint `backlog.md`:41 (it names this task as the home for the test-mode
  gating asymmetry under the dead title `auth-token-core-compose-not-fork`) and re-scope it per
  *Non-goals*; fix `.claude/rules/security.md:15`, whose closing clause still tracks that asymmetry
  "alongside the token-core de-fork"; and correct `.claude/rules/mesh.md:143`'s parenthetical, which
  describes `nebula-auth` and `auth` as "sharing code" — the dependency this phase deletes. ⚠️ Both
  rules are `paths:`-scoped to the files this task edits, so they are loaded by **every session doing
  this work**.

### 6. The sender is told the instance instead of inferring it

**Type the choke point first, or the rest of this phase is decorative:** `#sendEmail(message: EmailMessage)`
and a typed `AUTH_EMAIL_SENDER` binding, replacing `#sendEmail(message: any)` over `(this.env as any)`.
Only then add the required `instanceName` to every `EmailMessage` variant, stamp `headers()` from the
field, delete `parseInstanceName`, and rewrite `nebula-email-sender.test.ts`.

- **Success criteria (capable of failing):**
  - `npm run type-check` clean — named explicitly because **CI does not run it**, so this phase's
    guarantee is a desk-time type error rather than a merge gate.
  - `parseInstanceName` is gone; `nebula-email-sender.test.ts` asserts stamping-from-field rather than
    URL derivation (⚠️ if that file still passes *unchanged*, the phase did not land).
  - `/live impersonation-lifecycle` asserts the tag's **value**, not merely that mail arrived:
    in `inviteAndLogin`, keep the `to` filter and add `assert.equal((await waiter.emailPromise).instance, scope)`.
    ⚠️ Without this the criterion is true **before and after** the phase — invite mail is already
    tagged today, because `accept-invite` is an instance-bearing route. *(Do not add the same for
    magic-link: `apps/nebula/test/lib/email-login.ts` already passes `instance`, so a wrong tag there
    already times out every `/live` boot.)*
- **Mutation notes:** (a) delete `instanceName` from **each of the three** send sites in turn — every
  one must red `type-check`; check all three rather than sampling, since `#resumeClaimIfOwner` sits
  behind `if (this.#isTestMode) return` and no vitest test reaches it; (b) stamp a *wrong*
  `instanceName` at the invite send site → the new `/live` value assertion reds. This second class is
  newly possible: URL derivation could not disagree with the URL, a caller-supplied field can.
- **Standing guidance — sweep by INSTRUMENT, not by count.** ⚠️ An earlier draft said "three sites,
  and it owns all three"; that enumeration was short by at least two, in a phase whose whole point is
  *derive, don't enumerate*. The criterion is that
  `grep -rn 'parseInstanceName\|derived from the URL\|per message type' --include='*.ts' --include='*.md' packages apps tooling .claude`
  returns nothing still describing URL-derived tagging. Known floor: `nebula-email-sender.ts`'s
  `headers()` JSDoc; `calibration.md` §2's dated 2026-07-30 worked example (**always loaded**, and
  would otherwise present this change as a reversal to the enumeration that shipped the untagged-invite
  bug); `INSTANCE_BEARING_ROUTES`'s *"the two ends fail apart silently"* rationale — **re-derive**
  whether the list still earns its keep on its remaining job (typing `instanceAuthUrl`'s `route`)
  rather than deleting it because its reason died (`calibration.md` §4);
  `apps/nebula/harness/scenarios/impersonation-lifecycle.ts:63-64`'s comment; `nebula-email-sender.test.ts`'s
  file JSDoc and `describe` title; and `tooling/email-test/src/client.ts:33-45`'s `WaitForEmailOptions.instance`
  JSDoc — ⚠️ that last one is *instructional*, sits in `tooling/` outside both this file's
  package-scoped sweep and CI's `--scope "packages apps"`, and needs **re-deriving** rather than
  patching: its conclusion survives on a different reason once every Nebula auth mail is tagged.

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
- **Closing the residual `createTestRefreshFunction` gap** (not exported from `mesh/src/client-index.ts`).
  Phase 3 re-scopes the backlog row and records why the one-line fix is rejected; doing it needs a
  separate `./testing` subpath, because `create-test-refresh-function.ts:74`'s static
  `'cloudflare:test'` literal cannot sit on mesh's browser-safe entry.

⚠️ **One obligation with no phase, deliberately named here so it is not lost:** this task removes ten
functions, three types and a whole subpath from published `@lumenize/auth@0.26.0` and reshapes
`JwtPayload` — a larger break than the `headers(message)` change this file cites as its own
motivation. `workflow.md` § Releases requires the next release be flagged. Add a row under
[backlog.md](backlog.md) § `@lumenize/auth` enumerating the dropped exports, beside the existing one
whose sub-bullet records that such flags have "fallen through" before for want of a named home.

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
