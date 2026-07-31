# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 📝 **DRAFTED 2026-07-31**, design intent under hand review. Every number below was checked
against disk. **Deliberately has no phases yet** — write them with `/write-task` after `/review-task`
Stage 1, before Stage 2.

## Objective

**`packages/nebula-auth` stops depending on `@lumenize/auth` — no entry in its `package.json` at
all.** Two moves get there, and the split between them is the whole design:

1. **Extract** the JWT/crypto core into `@lumenize/crypto`. Shared, one owner, security fixes land once.
2. **Copy** the email-sender base and two small utilities into `nebula-auth`. Deliberately forked,
   free to diverge, never re-synced.

**The consequence that makes it worth doing: `packages/auth` ends with zero `src` consumers anywhere
in the repo.** `mesh` and `apps/nebula` both drop it too (see *What is actually coupled*), so it
becomes a leaf — still published, still documented, but no longer load-bearing in Nebula's production
graph and therefore free to go dormant whenever that is the right call.

## Why this exists

`nebula-auth` was **forked** from `@lumenize/auth`, not composed with it, and the two have been
quietly diverging on policy ever since. The forcing example is a live `security.md` **conformance
gap**: `packages/auth/src/lumenize-auth.ts:359` still revokes-and-reissues on refresh — *"Revoke old
refresh token (rotation)"* — a month after that decision was recorded as **dropped, do not
re-introduce**. It landed in `nebula-auth` only, and nobody noticed, because sharing a package
manufactures an impression of shared ownership that is not true.

⚠️ **Reliability, not vulnerability.** The failure mode is a spurious logout when two refreshes race
a single-use token, and nobody consumes base `@lumenize/auth` but us.

The day-to-day cost is ceremony disproportionate to the change. A 2026-07-30 refactor of the email
sender's header hook — code with **exactly one real consumer** — required a `BREAKING` commit, a
repo-wide override sweep, and a release-notes flag against a package with 25 npm downloads a month.

⚠️ **This does NOT deprecate `@lumenize/auth`.** It stays published and stays documented at
`website/docs/auth`. The question this file answers is only *what should depend on it*.

## What is actually coupled — measured 2026-07-30/31

`nebula-auth/src` imports **13** symbols from `@lumenize/auth`. They split cleanly by security weight,
and that split is the design:

| Piece | Lines | Consumers outside `packages/auth` | Security weight | Verdict |
|---|---|---|---|---|
| `jwt.ts` — sign/verify/importKeys + `parseJwtUnsafe`, `createJwtPayload`, and the `JwtPayload` / `JwtHeader` / `ActClaim` types | 281 | mesh (`src`), nebula-auth (`src` + tests), apps/nebula (`src`, `ActClaim` type-only) | **HIGH** — crypto, incl. BLUE/GREEN key rotation (`verifyJwtWithRotation`) | **Extract** → `@lumenize/crypto` |
| `auth-email-sender-base.ts` + `EmailMessage` / `ResolvedEmail` | 217 | **nebula-auth only** — mesh touches it in `test/browser/` + `test/for-docs/`, never `src` | none | **Copy** |
| `turnstile.ts` (`verifyTurnstileToken`) | 47 | nebula-auth | low — a thin API call | **Copy** |
| `extractWebSocketToken` (of `hooks.ts`'s 416) | 13 | nebula-auth, apps/nebula | low | **Copy**, re-exported for apps/nebula |

Copied total ≈ 280 lines, well under CLAUDE.md's *"favor copy-paste-with-attribution over a dependency
for <1000 SLOC"* threshold.

**The other two consumers**, both of which also lose their `@lumenize/auth` manifest entry:

- **`mesh/src`** — four crypto symbols across two files: `parseJwtUnsafe` (`lumenize-client.ts:3`,
  already via the `/client` subpath) and `signJwt` / `importPrivateKey` / `createJwtPayload`
  (`create-test-refresh-function.ts:1`, via the barrel). All four move to `@lumenize/crypto`.
- **`apps/nebula/src`** — `type ActClaim` (`resources.ts:17`) → `@lumenize/crypto`;
  `extractWebSocketToken` (`entrypoint.ts:24`) → `@lumenize/nebula-auth`, which it already depends on.

**Why crypto is the exception rather than more of the same.** "Only we call it, so divergence is safe"
is true of *policy* and false of *crypto*: a verification or key-handling bug would have to land twice,
and the second landing is the one that gets forgotten.

## Design intent

### The manifest is the guard, not a comment

Leaving `"@lumenize/auth": "*"` in `nebula-auth`'s `dependencies` while merely *preferring* the local
copies would not hold. A future session writing `import { AuthEmailSenderBase } from '@lumenize/auth'`
would be **adding one line to a file** — no manifest change, no review signal, and it reads as tidying
away a duplicate. Removing the entry makes re-coupling require a deliberate dependency addition,
which is visible in review. Same reasoning as `instanceAuthUrl`'s compile-time guard beating a
warning comment: a structural guard cannot rot.

⇒ **Success is measured on the manifest**, not on import counts.

### What extraction buys that a subpath does not

⚠️ **Module-graph reachability is NOT the reason — it is already solved.** `@lumenize/auth/client`
(`packages/auth/src/client.ts`) exports exactly these ten symbols, and its whole import chain is
`./jwt` → `./types`, type-only, with no `cloudflare:workers` anywhere. Its own JSDoc says the split is
*"by intent, not by runtime"*: it is designed public API, not a workaround. `mesh/src/lumenize-client.ts`
uses it as intended, and the one `src` file still reaching the barrel is a one-line fix. Anyone
arguing for extraction on reachability grounds is arguing for something the subpath already delivers.

**What the subpath cannot deliver is a single owner, and that is the whole case.** Under
copy-everything, `mesh/src` still needs four crypto symbols and `mesh.md` § dependency direction
forbids `mesh → nebula-*` — so `packages/auth` stays permanently load-bearing as `mesh`'s crypto
supplier, and `mesh` is Nebula's substrate. The package would then be one we cannot stop investing in,
because production imports it. **Extraction is what makes walking away possible**; copying forecloses
it. The one-owner security property (a verify or key-handling fix lands once) rides along on the same
move.

Cost is small: the sweep inside `packages/auth` is **4 import lines** (`client.ts`, `index.ts`,
`hooks.ts`, `lumenize-auth.ts`). `@lumenize/crypto` would depend on nothing, so there is no cycle and
no Lerna publish-order problem.

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

## What "done" looks like

⚠️ **Deliberately NOT phases** — write them with `/write-task` after `/review-task` Stage 1. What
follows is what done *means*, plus the hazards a plan must respect.

- **The decoupling criterion is the MANIFEST, and the instrument is `npm ls`.** `@lumenize/auth` in
  neither `dependencies` nor `devDependencies` of `packages/nebula-auth/package.json`, verified by
  `npm ls @lumenize/auth` resolving nothing from that package. ⚠️ **A grep for the import string is
  the weaker form and must not be the criterion** — it passes while the affordance remains, which is
  the whole thing *The manifest is the guard* argues against.
- **The manifest change is one entry out and one entry IN.** `auth-email-sender-base.ts:2` imports
  `createEmailTransport` from `@lumenize/email`, which `nebula-auth` gets *transitively* today and
  does not declare. Copying the base means **adding `@lumenize/email`** to `nebula-auth`'s manifest.
- **`mesh` and `apps/nebula` also lose their `@lumenize/auth` entry**, per *What is actually coupled*.
  `packages/auth` then has zero `src` consumers repo-wide — the checkable form of the objective.
  ⚠️ **`mesh` may legitimately keep a `devDependency`, and that is not a failure.**
  `AuthEmailSenderBase` appears in `mesh/test/browser/worker/` and `mesh/test/for-docs/getting-started/`.
  A for-docs mini-app is a **real consumer**, not a stray to be swept — `testing.md` records that
  those tests historically found more bugs than all other tiers combined.
- ⚠️ **Extraction is a TYPE SPLIT, not a file move — the seam most likely to be under-estimated.**
  `jwt.ts` has one type-only import, but it points at `packages/auth/src/types.ts` (164 lines), which
  mixes `ActClaim` / `JwtPayload` / `JwtHeader` in with `Subject` / `MagicLink` / `InviteToken` /
  `RefreshToken` / `EmailMessage` / `AuthRoutesOptions` / `CorsOptions` / `LoginResponse` / `AuthError`.
  That file gets cut three ways: JWT types → `@lumenize/crypto`; `EmailMessage` / `ResolvedEmail` →
  copied into `nebula-auth` (and kept in `auth`); the rest stays. Confirm the seam is as clean as it
  looks before any code moves.
- **11 `nebula-auth` test files import `@lumenize/auth`, and all of them move.** The manifest criterion
  admits no `devDependency`, so the code move is not `src`-only. Mechanical, and per `calibration.md`
  §3(c) test churn is ≈zero-weight — named here only so it is not discovered mid-build.
- **Nothing regresses:** `packages/auth` (160 tests) and `packages/nebula-auth` (255 passed / 1
  skipped, as of 2026-07-31) stay green, and the `/live` `impersonation-lifecycle` scenario — which
  drives a real invite email end to end through the copied sender — still passes.
- **Every copied file carries a do-not-re-sync header** naming its origin, the date, and the reason.
  Per *A copy that is not marked as deliberate will be "cleaned up"*, this is the deliverable of the
  copy work; the code move itself is mechanical.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Extract the JWT/crypto core as `@lumenize/crypto`; `auth`, `mesh`, `nebula-auth` and `apps/nebula` all consume it** | *Copy it into `nebula-auth` too and leave `auth`'s copy in place — no new package.* `mesh/src` needs four crypto symbols and cannot depend on `nebula-*`, so `packages/auth` would stay permanently load-bearing in Nebula's production graph and could never go dormant. Two copies also means a verify or key-handling fix lands twice, and the rotation drift is proof the second landing gets missed. |
| **Extract the crypto core; copy the rest** | *Share everything (status quo).* Keeps manufacturing false shared ownership over code that is already forked in policy, and taxes every email-template change with breaking-change ceremony. |
| **Extract only if `packages/auth` consumes the result** | *Extract while `auth` keeps its own copy.* Pays the full price of a new package and still leaves two copies, so the one-owner property it was bought for is gone. Incoherent; do not propose it. |
| **A subpath is not a substitute for extraction** | *Point `mesh/src` at `@lumenize/auth/client` and stop there.* Fixes module-graph reachability for one line, but leaves two crypto copies and leaves `mesh` depending on the auth product. The near-miss most likely to be re-proposed in review. |
| **Remove `@lumenize/auth` from `nebula-auth`'s `package.json`** | *Keep the dependency and merely prefer local copies.* The manifest entry is the affordance — re-coupling would cost one import line and show no review signal. |
| **Drop the ten crypto symbols from `@lumenize/auth`'s public API** | *Re-export them from `auth` for backward compatibility.* No live users, so there is nothing to stay compatible with; a shim would be a second reference to the code that extraction exists to give one owner. |
| **`@lumenize/auth` stays published and documented** | *Deprecate it.* Its low adoption is an argument about *investment*, not deletion, and not this file's question. What this file buys is that deprecating it later becomes possible. |
| **The package is `@lumenize/crypto`** | *`@lumenize/jwt`*, and *a compound name such as `jwt-plus-utils`.* All ten symbols wrap the same `crypto` global — `crypto.subtle` for Ed25519 sign/verify, plus `getRandomValues`, `randomUUID`, `subtle.digest` — so `crypto` is accurate rather than a compromise, and there is no "plus" to name. A compound name bakes today's contents into the identifier and rots on the eleventh wrapper. |
| **`mesh` depends on the extracted package, never on `nebula-auth`** | *Inline `auth` into `nebula-auth` wholesale.* `mesh/src` needs the crypto core, and `mesh.md` § dependency direction forbids `mesh → nebula-*`. |

## Relationships

- **Supersedes** [icebox/auth-token-core-compose-not-fork.md](icebox/auth-token-core-compose-not-fork.md)
  (moved 2026-07-31), which targeted the ~1,400-line DO orchestration body rather than the leaf.
  ⚠️ **Its file:line map is dead** — every citation names `packages/nebula-auth/src/nebula-auth.ts`,
  which no longer exists (the body is now `nebula-auth-registry.ts` / `worker-token.ts` / `router.ts`).
  Do not port those line numbers, and do not treat it as a live plan.
- **The orchestration-body de-fork stays out of scope and has no live task file.** ⚠️ If it is ever
  revived its mechanism must change: this file removes `@lumenize/auth` from `nebula-auth`'s manifest,
  so a shared session core can no longer be *"nebula-auth composes @lumenize/auth"* — it must be a
  third extracted package that both consume. **Share via extraction, never by depending on the auth
  product.**
- **Does NOT fix the rotation drift, deliberately.** Closing it is a conformance fix inside
  `packages/auth`, not decoupling work. What decoupling buys is that the fix becomes **safe to make
  independently**. Tracked in [backlog.md](backlog.md) § `@lumenize/auth`.
- **Unblocks nothing that is currently blocked** — it is cleanup, and its value is preventing future
  drift rather than enabling a feature. Sequence it accordingly.
- **Follows** [archive/nebula-impersonation-client.md](archive/nebula-impersonation-client.md), whose
  `headers(message)` breaking change surfaced the ceremony cost.
