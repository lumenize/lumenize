# Decouple `nebula-auth` from `@lumenize/auth` — extract the crypto core, copy the rest

**Status:** 📝 **DRAFTED 2026-07-31**, not yet reviewed. The design intent below came out of a
measured conversation (every number in it was checked against disk that day) but it has had **no
`/review-task` pass** — run one before `/build-task`, and settle *The gating decision* first.
**Deliberately has no phases yet:** `/write-task` writes them only after the design intent is
hand-reviewed, and an earlier draft's five were written against that unmade decision. What remains is
intent, open decisions, and what done looks like.

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
quietly diverging on policy ever since. The forcing example is a live `security.md` **conformance
gap**: `packages/auth/src/lumenize-auth.ts:358` still revokes-and-reissues on refresh — *"Revoke old
refresh token (rotation)"* — a month after that decision was recorded as **dropped, do not
re-introduce**. It landed in `nebula-auth` only, and nobody noticed, because sharing a package
manufactures an impression of shared ownership that is not true.

⚠️ **Reliability, not vulnerability.** The failure mode is a spurious logout when two refreshes race
a single-use token, and nobody consumes base `@lumenize/auth` but us. It is evidence that divergence
goes unnoticed — which is this file's argument — and not an incident. Stated here rather than
corrected later, so the alarming reading is never available in the first place.

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

## What this absorbs from `auth-token-core-compose-not-fork` (superseded 2026-07-31)

That file (now `icebox/`) addressed a **different layer** and pointed the **opposite way**, which is
why reconciling them mattered rather than just merging them. It observed that the *leaf* layer was
already composed — *"Crypto is **not** duplicated"* — and targeted the ~1,400-line **DO orchestration
body** (refresh handler, cookie construction, magic-link lifecycle, subject SQL), proposing to share
**more**. This file leaves that body untouched and changes the leaf, sharing **less** of it.

⚠️ **Its "Current state (verified 2026-07-03)" map is DEAD, and inheriting it would have sent a
builder to deleted code.** Every citation named `packages/nebula-auth/src/nebula-auth.ts` — the
founder logic at `:1283`, the claim shape at `:1361`, the "correct reference handler" at `:441`. That
file no longer exists; the body was restructured into `nebula-auth-registry.ts` (1210 lines),
`worker-token.ts` (584) and `router.ts` (393). The base is unchanged at `lumenize-auth.ts` (1381).
**Re-derive the seam against today's files; do not port those line numbers.**

**What survives, and is carried here:**

- **The substance of the drift claim holds.** Two refresh implementations still exist —
  `packages/auth/src/lumenize-auth.ts` (rotating) and `nebula-auth/src/worker-token.ts`
  `handleRefreshToken` (pure KV read, no rotation). Only the map rotted, not the finding.
- **The four policy differences**, still the right list to test any seam against: first-user-is-founder;
  `access: AccessEntry` claims vs the base's `authorizedActors`; the two-scope model + `{u}.{g}.{s}`
  parsing; cookie path (base `Path=/` vs nebula's path-scoped `/auth/{authScope}`).
- ⚠️ **Its stated risk, which applies verbatim to any future de-fork:** *"The fork headers claim the
  diffs are localized; a de-fork can discover they're more entangled than advertised."* Confirm the
  clean-seam assumption before any code moves.
- **Its lean toward a targeted rather than full de-fork** — a ~2,800-line unification is high churn
  for the parts that are not drift-prone.
- **Its urgency calibration**, which an earlier draft of this file got wrong by calling the drift a
  "live security drift": it is **reliability, not vulnerability**. Now stated correctly in *Why this
  exists* rather than asserted-then-corrected.
- **The ADR-007 precision:** de-forking *rhymes* with ADR-007 ("share one narrow core by composition")
  but does **not** bind here — ADR-007 governs mesh nodes, and these are raw `extends DurableObject`
  DOs. Cite it as motivation, never as a gate.

**What is deliberately NOT carried, and stays open:** the orchestration-body de-fork itself. It is out
of scope here and no longer has a live task file. ⚠️ **If it is ever revived, its mechanism must
change:** this file removes `@lumenize/auth` from `nebula-auth`'s manifest, so a shared session core can
no longer be *"nebula-auth composes @lumenize/auth"*. It must be a third extracted package that both
consume — the same shape as the crypto extraction under option A. That constraint is the real reconciliation
between the two files: **share via extraction, never by depending on the auth product.** Its open
latent question is worth keeping too — *are two parallel auth DOs the right end state at all?*

## The gating decision — extract, or copy everything?

⚠️ **Settle this FIRST. It decides whether a new package exists at all**, so nothing downstream can
be planned around it. Raised by Larry 2026-07-31, sharpening what had been filed as a minor open
question.

The whole security case for extracting is **one owner** — a crypto fix lands once. That case holds
only if `packages/auth` *consumes* the extracted package. If `auth` keeps its own copy, two copies
exist regardless, the one-owner property is gone, and the package is paying for a benefit it no
longer delivers. So the real choice is binary:

| | Copies of the crypto core | One owner? | `mesh` still drags the DO barrel? | Cost |
|---|---|---|---|---|
| **A — extract; `auth`, `mesh`, `nebula-auth` all consume it** | 1 | ✅ | no | a new package |
| **C — no new package; `nebula-auth` copies, `auth` keeps its own, `mesh` keeps depending on `auth`** | 2 | ❌ | yes | near zero |

⚠️ **The middle option is incoherent and should not be proposed:** extracting while `auth` keeps a
copy pays the full price of a new package and still leaves two copies. If `auth` will not consume it,
choose C.

**Recommendation: A.** No obstacle has been found — `crypto` would depend on nothing, so there is no
cycle and no Lerna publish-order problem, and `auth`'s 46 `src` references are a mechanical
`./jwt` → `@lumenize/crypto` sweep. And A is the only branch where the argument in *Why crypto is the
exception* survives: under C, a verification or key-handling fix has to land twice, which is the exact
failure the rotation drift already demonstrated. **A's mesh benefit is independent** and survives even
if the security argument were discounted — under C, the MIT foundation goes on depending on a full
auth product with a Durable Object in it to obtain six pure functions.

⚠️ **If C is chosen, most of this file still applies** — the email seam, turnstile and
`extractWebSocketToken` copies are unaffected, and so is the manifest criterion. Only the crypto
half changes: `nebula-auth` gains a local copy instead of a dependency, and `mesh` is left as-is.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Extract the JWT core; copy the rest** | *Copy everything, including `jwt.ts`.* Duplicated crypto means a security fix lands twice, and the live rotation drift is proof the second landing gets missed. |
| **Extract the JWT core; copy the rest** | *Share everything (status quo).* Keeps manufacturing false shared ownership over code that is already forked in policy, and taxes every email-template change with breaking-change ceremony. |
| **Remove `@lumenize/auth` from `nebula-auth`'s `package.json`** | *Keep the dependency and merely prefer local copies.* The manifest entry is the affordance — re-coupling would cost one import line and show no review signal. |
| **`@lumenize/auth` stays published and documented** | *Deprecate it.* It serves `mesh` and external users, and CLAUDE.md's mission #1 is the MIT package suite. Its low adoption (25 downloads/month) is an argument about *investment*, not about deletion — and not this file's question. |
| **If extracted, the package is `@lumenize/crypto` — not `@lumenize/jwt`, not a compound name** | *`@lumenize/jwt` carrying all ten exports*, and *`@lumenize/jwt-plus-utils`*. ⚠️ **Both rest on a premise this file originally asserted and that is FALSE.** It called `generateRandomString` / `generateUuid` / `hashString` *"not JWT concerns"* — true — and everyone read the implied conclusion *"therefore a grab bag riding along."* The question that decides the name is whether they are **crypto** concerns, and all three are thin wrappers over the `crypto` global: `crypto.getRandomValues`, `crypto.randomUUID()`, `crypto.subtle.digest('SHA-256')`. The JWT functions are `crypto.subtle` Ed25519 wrappers. **All ten symbols wrap the same global**, so there is no "plus" — `crypto` is the accurate name, not a compromise. Also rejected: a compound name generally — it bakes today's contents into the identifier, so it rots the moment an eleventh wrapper lands, and "utils" is unsearchable for the symbol anyone is actually hunting. ⚠️ **The finding survives even under option C**: the file `nebula-auth` copies should be `crypto.ts`, not `jwt.ts`. |
| **`mesh` keeps depending on an extracted package, never on `nebula-auth`** | *Inline `auth` into `nebula-auth` wholesale.* `mesh/src` needs the JWT core, and `mesh.md` § dependency direction forbids `mesh → nebula-*`. |

## What "done" looks like

⚠️ **Deliberately NOT phases.** This file has not had its design-intent hand review, and `/write-task`
writes phases *after* that gate for a reason: phases written first present as the plan and anchor the
reviewer on a shape that is about to move. An earlier draft had five, written against a decision (the
gating question above) that had not been made — so the extraction and the copy were both built on
ground nobody had stood on. They are cut. Write them with `/write-task` once the intent is settled.

What survives here is the part that is genuinely *intent* — what done means, and the hazards a plan
must respect:

- **The decoupling criterion is the MANIFEST, and the instrument is `npm ls`.** `@lumenize/auth` in
  neither `dependencies` nor `devDependencies` of `packages/nebula-auth/package.json`, verified by
  `npm ls @lumenize/auth` resolving nothing from that package. ⚠️ **A grep for the import string is
  the weaker form and must not be the criterion** — it passes while the affordance remains, which is
  the whole thing *The manifest is the guard* argues against.
- ⚠️ **`mesh` may legitimately keep a devDependency on `@lumenize/auth`, and that is not a failure.**
  `AuthEmailSenderBase` appears in `mesh/test/browser/worker/` and `mesh/test/for-docs/getting-started/`.
  A for-docs mini-app is a **real consumer**, not a stray to be swept — `testing.md` records that
  those tests historically found more bugs than all other tiers combined. Check what `mesh/src`
  actually needs rather than assuming the dependency can go entirely.
- **Nothing regresses:** `packages/auth` (160 tests) and `packages/nebula-auth` (255 passed / 1
  skipped, as of 2026-07-31) stay green, and the `/live` `impersonation-lifecycle` scenario — which
  drives a real invite email end to end through the copied sender — still passes.
- **Every copied file carries a do-not-re-sync header** naming its origin, the date, and the reason.
  Per *A copy that is not marked as deliberate will be "cleaned up"*, this is the deliverable of the
  copy work; the code move itself is mechanical.

## Relationships

- **Supersedes** [icebox/auth-token-core-compose-not-fork.md](icebox/auth-token-core-compose-not-fork.md)
  (moved 2026-07-31). Everything still true in it is absorbed above, including the parts that
  *correct* this file rather than agree with it. It is iceboxed rather than deleted because its
  seam-finding framing for the orchestration body is reusable if that work is ever revived — but its
  file:line map is dead and must not be ported. Do not treat it as a live plan.
- **Does NOT fix the rotation drift, deliberately.** Closing it is a conformance fix inside
  `packages/auth`, not decoupling work, and an earlier draft carried it as a phase here only because
  this file cites it as evidence. What decoupling actually buys is that the fix becomes **safe to
  make independently** — which is the point. Tracked in [backlog.md](backlog.md) § `@lumenize/auth`.
- **Unblocks nothing that is currently blocked** — it is cleanup, and its value is preventing future
  drift rather than enabling a feature. Sequence it accordingly.
- **Follows** [archive/nebula-impersonation-client.md](archive/nebula-impersonation-client.md), whose
  `headers(message)` breaking change surfaced the ceremony cost, and whose `RECOMMENDED_MIN_TTL_SECONDS`
  problem is the third instance of the barrel/DO reachability issue the extraction addresses.
