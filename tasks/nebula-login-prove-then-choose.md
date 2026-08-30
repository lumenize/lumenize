# Login proves the mailbox, then you choose — and that screen carries the data-use notice

**Status:** Active child — two ⚠️ GATE bullets in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Invite-gated* (the login re-order + the data-use consent notice), designed and built together as ONE screen because the notice's screen is the one the re-order rebuilds. The login flow is what every pre-alpha user meets first, and Larry wants it tested with them (2026-08-09). **Unblocked 2026-08-28:** the Galaxy collapse landed its half of the shared `consumeAndLogin` seam — `NEBULA_AUTH_REDIRECT` is `/studio` and `landingBase`'s tier split is live — so this file inherits that shipped state, and the old do-not-interleave caution is discharged.

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** From here: `/review-task` **Stage 1** on this phase-less file → resolve and edit → write phases → **Stage 2**. § *Acceptance criteria* is Pass-2 input.

**Objective — one email, then a picker, with the product's data-use notice on it.** You type your address and get a link. Clicking it proves the mailbox; *then* the server tells you which workspaces that address reaches, and you choose one — or, holding none, claim a fresh Universe on that same click's proof. Discovery stops answering anyone who has not proved they hold the address, and the choose screen renders the short informational data-use notice that must exist before anyone but Larry uses the product.

## Relationships

- **Discharges** the *data-use consent UI* and *login: prove the mailbox, then choose the workspace* bullets named in the Status line. Both flip ✅ when this lands; the consent bullet's requirements are pinned in § *One screen, two faces* below, which becomes their design home.
- **Supersedes** the `discover(email)` oracle row in [backlog.md](backlog.md) § *Nebula Auth* — that row filed this exact re-order as the proper fix and accepted the leak as a pre-alpha residual; the row goes when this lands.
- **Inherits the collapse's half of the shared seam** — [archive/nebula-galaxy-collapse-and-chat.md](archive/nebula-galaxy-collapse-and-chat.md) Phase 3 shipped `NEBULA_AUTH_REDIRECT` = `/studio`, so `landingBase`'s tier branch is visible for the first time: a star-tier scope lands under `/app/{scope}`, everything else under `/studio/{scope}`. What that value *means* once the scope is chosen after the click is open question 4, now this file's alone to answer.
- **Answers a Super-admin building-block gap** in [nebula-pre-alpha.md](nebula-pre-alpha.md) — its ⚠️ *Still owed* note on driving superuser → discover → select the platform scope → impersonate as one `/live` scenario. The discover half's shape is this file's open question 3 plus its superuser criterion; the impersonate half stays the master plan's.
- **Natural home for the create-app-flow coverage debt** — [backlog.md](backlog.md) § *Nebula* records that the UI create-app flow has zero automated coverage and names this build as the fix's natural home: the screens are adjacent and the ui-smoke plumbing is shared. Whether its case lands here is a Pass-2 phase decision, recorded so it is not lost.
- **Touches** [archive/nebula-invite.md](archive/nebula-invite.md) only at the boundary: invites keep scoped links, which never pass the picker — an arrival that already names where it is going does not choose. The scoped consume arm, including the `.dev` dual-cookie co-mint it gained 2026-08-30, carries over untouched.
- **Documentation** — `website/docs/nebula/auth-flows.md` describes the current flows and is the other surface that changes; [docs/vision/auth.md](../docs/vision/auth.md) gains § *Discovery* (see § *Constraints*).

## Context and current state

**Built already** — re-verified against disk 2026-08-30, after the collapse and the `createGalaxy`-bundles-`.dev` landings; each entry states its fate under this task:

- **`discover(email)`** on the registry returns one entry per `Memberships` row for an address, each carrying `scopeAdmin`. It is unauthenticated, `sub`-free by design, and Turnstile-gated (the CF rate limiter keys on a verified `sub`, so the connection limiter and Turnstile are its only bounds). Its route-table row is already marked TERMINAL: the comment says the row survives only because the login page cannot yet live without it, and that its limiter bounds the *volume* of the recorded enumeration oracle while retiring the leak belongs to this task. **Fate: retired** — the route goes; its two non-production callers are in § *Claims this rests on*.
- **The schema already separates the two proofs.** `getAndVerifyIdentity` flips `Emails.emailVerified` — whose own comment states it is proof of the **mailbox**, global to the address, set once and never re-proved per scope — and separately sets `Memberships.acceptedAt`, which is per-membership. Both are guarded on the value they change from, because this is the registry's highest-volume write path. **Fate: carried unchanged** — this pair is the design's spine.
- **`requestMagicLink`** inserts a scope-bound `MagicLinks` row (token hashed) and sends, **minting no identity**: a link for a scope the address holds no membership in is issued, delivered, and then rejected at consume. Its one exception is the bootstrap superuser mint — an **unauthenticated** request naming the reserved scope with a configured bootstrap address writes that platform membership. **Fate: adapted** — it gains the scope-less form, and the bootstrap mint moves behind proof.
- **`consumeAndLogin`** hashes the one-time token, generates the refresh token, calls the consume RPC, sets the cookie, and redirects — tier-split by `landingBase` (star → `/app/{scope}`, else → `/studio/{scope}`), with the scope carried as a path segment so the landing SPA auto-connects with no local state. The invite arm co-mints a second `.dev`-session cookie (2026-08-30), and its JSDoc pins the scanner placement invariant that § *Claims this rests on* transfers to the prove step. **Fate: split** — the scoped consume (invites, deep links) carries over; the bare magic-link consume divides into prove (scope-less) and choose (scoped login).
- **`refreshCookie`** is path-scoped — `Path={prefix}/{scope}`, `HttpOnly`, `Secure`, `SameSite=Strict`, fixed TTL. Sessions at different scopes are separated by that path and nothing else. **Fate: carried unchanged.**
- **The Studio login** (`App.vue`) calls `discover` on the typed address and branches on the count: one entry sends a link, zero opens the claim prompt with a suggested slug, and **more than one logs an error saying the picker is a later feature**. An explicit `/studio/{scope}` URL bypasses discovery. **Fate: rebuilt** — the count branch dies; the URL bypass carries over.
- **`claimUniverse`** writes the scope row and an admin membership with the mailbox unproved, then issues its own magic link; the click is what proves it. **Fate: adapted** — its own second link is deleted; § *What the re-order buys* carries the collapsed shape.
- **Scoped links are a separate, working path.** `InviteTokens` rows carry their scope, and an explicit deep link bypasses discovery entirely. **Fate: carried unchanged.**

**Missing:**

1. **The picker does not exist.** A person with two memberships reaches a dead end in the UI, so the multi-workspace case — the one the whole discovery step exists to serve — is unbuilt.
2. **Discovery answers before anyone proves anything.** Any caller learns which scopes an address belongs to and which it administers. Dropping `scopeAdmin` from the response does not close it: at Galaxy and Universe tiers membership *is* admin-ship, and at the reserved platform scope membership *is* superuser-ship, where there is no field left to drop.
3. **The new-user path costs two emails.** Discovery returns nothing, the claim prompt appears, the claim sends a second link, and only that click opens a session — on open self-signup, which is a pinned business decision and the highest-value funnel we have.
4. **The superuser cannot arrive through the front door.** Their membership is minted *by* the request for a platform-scoped link, so before their first login discovery returns nothing and the UI offers them a Universe claim. The way in is a hand-typed URL.
5. **The flow forces a scope onto a proof the schema says is scope-independent.** `emailVerified` is a property of the address, but the only path that sets it is a consume that requires a membership at a named scope — so proving your mailbox demands you first name somewhere you already belong.
6. **The data-use notice exists nowhere.** No surface tells a user that product usage is captured to improve the product — and the screen the master plan pins it to is the claim prompt this task relocates behind the click.

## Design intent, constraints, and future state

### The target

Three steps, and the scope is chosen in the last one:

1. **Request.** You type an address. A **scope-less** magic link is sent, and the response is identical whether or not the address is known to us.
2. **Prove.** You click. The consume flips `emailVerified` on that address and returns the scopes it holds memberships in, together with a short-lived **proof credential**.
3. **Choose.** You pick one. The proof is spent at the scoped login, which sets `acceptedAt` on that membership and the path-scoped refresh cookie, exactly as today.

**The two flags map onto the two steps, and that is the whole design.** `emailVerified` is proven at the click, `acceptedAt` at the choice. The schema already draws that line and already documents why; this flow stops fighting it.

### One screen, two faces, and the notice rides it

The choose step is one screen. An address holding memberships sees the **picker face** — one row per membership, unaccepted ones included. An address holding none sees the **claim face** — the suggested-slug Universe claim, today's prompt relocated behind the click. Both faces render the **data-use notice**, whose requirements were the master plan's consent-UI GATE bullet and are pinned here as that bullet's design home:

- **Short and informational.** A sentence or two of plain text on the screen — not a modal, not a step.
- **No functional gating.** Nothing waits on it: there is no accept control, and proceeding never consults it.
- **No stored value.** It gates nothing, so there is nothing to remember; it simply always renders there.
- **Generic "improve the product" framing.** Never Nebula- or Studio-specific, and never naming the underlying model — wording that survives surface changes without per-change review.

Building the notice inside this rebuild is what the pairing buys: shipped separately first, it would land on the pre-click claim prompt — a screen this same task deletes.

### Discovery reads a proven address, never a claimed one

This is the invariant, stated so it does not decay into "discovery is Turnstile-gated" or "we dropped the admin bit". Neither is the property. The property is that the response is derived from an address whose holder answered mail at it.

⚠️ **The proof credential is forced by the cookie, not chosen for convenience.** The refresh cookie's `Path` is `{prefix}/{scope}` and that path is the only thing separating one session from another, so at consume time — when no scope has been chosen — there is no path to set it at. Something has to carry proof from step 2 to step 3.

⚠️ **The obvious shortcut is a decision this repo has already rejected.** Widening the cookie to `Path={prefix}/` is scope-less global refresh, and `authScope` never comes from the cookie (`security.md`). The proof must therefore live elsewhere: a short-TTL bearer returned in the response, or a cookie at a fixed non-scope path that the choose-step spends and clears.

### What the re-order buys

- **The picker becomes buildable, and honest.** It lists memberships, which is exactly the set of scopes a session can be started at — a magic link consumes against a membership or it fails. Reach is the wrong answer here and always was: an admin reaches scopes they hold no membership in and cannot log in at.
- **The claim collapses to one email.** Proof precedes the slug choice, so the claim mints an already-proved address and opens the session directly. Proving the mailbox before knowing what will be claimed does not weaken the proof, because the claim is made *by* the proven address.
- **The superuser stops being a special case.** On a proven address in the bootstrap list, the platform membership is ensured and appears in the list like any other entry. This also tightens today's behaviour, where an unauthenticated request is what writes that row.
- **The unauthenticated surface shrinks by one endpoint and gains none.** `discover` leaves the open set. The request endpoint is already open, already Turnstile-gated, and already mails any address named at it, so scope-less sending introduces no mail-amplification vector that scope-bound sending did not already have.
- **Rate limiting can finally cover discovery**, keyed on the proof credential rather than on a `sub` that does not exist before login.

### Claims this rests on, stated so review can falsify them

- **The cookie path and the redirect are `consumeAndLogin`'s only two uses of the resolved scope, and both belong after the choice.** The redirect is `landingBase`'s tier split — visible since the collapse shipped `/studio`, so the choose flow decides between real, different destinations rather than two arms that happen to agree.
- **Sending to an unknown address is already the posture**, established by `requestMagicLink`'s no-mint invariant — so the uniform response in step 1 changes what a caller *learns*, not what we *send*.
- **`MagicLinks` rows are ephemeral** (minutes), so nothing durable changes shape and this is **not wipe-gated**.
- **`discover`'s only production consumer is the Studio login.** The shared `email-login.ts` helpers never call it — they go straight to the scoped request — and the one other live caller is the harness `turnstile-canary`, which uses it as a side-effect-free Turnstile probe and re-points when the route dies.
- **The scanner invariant transfers to the prove step, and it forces repeatability.** Links are multi-use within TTL because corporate scanners fetch them and follow the redirect, and the click first-touches no per-user DO (`consumeAndLogin`'s JSDoc carries the placement argument — a DO is permanently placed near its first request). The prove step inherits both properties: a scanner consuming the link before the human must leave the human able to click through, so every click within TTL must be able to yield a fresh proof. This is open question 1's strongest input.
- **The invite dual-cookie co-mint sits outside this change.** The `devSession` second cookie rides only the `consumeInvite` arm, which the bare login flow never takes.

### Constraints

- **[ADR-009](../docs/adr/009-real-auth-path.md)** — real email login is the default path and stays rung 1. The flow gains a step, so `provisionAndLogin` / `loginViaEmail` in the shared `email-login.ts` and the vitest test-helpers both change shape: the click lands on the picker rather than on an open session.
- **`security.md`** — scope-less global refresh is on the never-reintroduce list, which is what makes the proof credential a separate artifact rather than a wider cookie.
- **`router.ts`'s Turnstile set** carries a standing invariant that every unauthenticated registry endpoint is listed there, because the set is the only bound on them. Removing `discover` from the open set must leave that invariant true rather than quietly narrowing what it covers.
- **[ADR-012](../docs/adr/012-global-profile-visibility.md)** — per-membership acceptance is its manufacture defense, so the picker lists memberships **regardless of `acceptedAt`**. Listing an unaccepted membership is correct: consuming a link is how one becomes accepted.
- **[`docs/vision/auth.md`](../docs/vision/auth.md) — `status: accepted`, and it has no § on discovery at all.** This task fills a gap rather than contradicting the doc, and the section it adds must describe the target flow. ⚠️ **The two pickers must be named apart in that section**: this one lists **memberships of the proven address** (candidate `authScope`s, pre-session), while the in-app switcher lists the **person's** scopes (`profileId`-keyed, from `myScopeTree`). Conflating them is what makes "show the discovered scopes" ambiguous in the first place.
- **`ui-theming.md`** — every face of this screen uses daisyUI semantic classes, and per the design-deferral stance the components are stock on the placeholder theme: this task authors no design.
- **Pre-alpha** — no users, so there is no compatibility problem and no migration. Larry wants pre-alpha users to meet this flow, which is what makes it invite-gated rather than a residual.

### Future state

- ⚠️ **Design consideration:** the picker is the natural home for switching between simultaneous sessions later — `authScope` sessions already coexist by cookie path, and nothing in the UI surfaces that today.
- ⚠️ **Design consideration:** `myScopeTree`'s platform arm selects every scope in the system, so the **in-app** switcher has an unbounded-list problem for a superuser (search rather than a rendered tree). That is the other picker and not this task's; it is named here only so the two are not merged while this one is being built.
- ⚠️ **Design consideration:** scoped-link arrivals — invitees and deep links — never pass the choose screen, so they never see the notice. The requirement of record names only this screen, and pre-invite Larry is the only subject; if the notice must ever reach the invite path, that is a different surface earning its own task.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **Discovery runs after the click, on a proven address** | Narrowing what `discover` returns — dropping `scopeAdmin`, or filtering the reserved platform row. At Galaxy and Universe tiers membership *is* admin-ship and at `nebula-platform` it *is* superuser-ship, so the scope name alone carries the sensitive bit; each filter is a guard on one symptom of a mechanism that should not answer strangers at all. |
| **A separate short-lived proof credential carries step 2 → step 3** | Widening the refresh cookie's `Path` to cover every scope — that is scope-less global refresh, already rejected, and it would make `authScope` a property of the cookie. |
| **The picker lists memberships** | Listing reach — an admin reaches scopes they hold no membership in, and a magic link cannot be consumed at one, so the picker would offer places you cannot log in. |
| **The claim path collapses to one email** | Keeping the second link — it exists only because the claim happens before any proof, which this re-order reverses. |
| **The bootstrap mint moves behind proof** | Keeping it on the unauthenticated request — it is the one place an unauthenticated call writes a membership, and after the re-order it has no reason to. |
| **Scoped links stay first-class** | Making every link scope-less — invites carry their scope by design, and a scoped deep link already knows where it is going; forcing those through a picker would add a step to the paths that need it least. |
| **The notice is informational: no gate, no stored value** | An accept control or a persisted has-seen flag — a gate adds friction on the highest-value funnel against `calibration.md` § 1's wedge argument, and a stored flag is schema for something that changes no behavior. Pre-invite, Larry is the only subject and owns the responsibility. |
| **Generic "improve the product" wording** | Naming Studio, the capture mechanism, or the model — specific wording goes stale with every surface change, and the model name never surfaces anywhere in the product. |
| **The notice ships inside this rebuild, as part of one screen** | Shipping it first on today's claim prompt — that prompt moves behind the click in this same build, so the notice would land on a screen this file deletes. The master plan carried this exact warning. |

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

- 🔒 **An unproven address learns nothing.** A request naming an address with memberships and one naming an address with none produce identical responses, and no unauthenticated route returns scope names for an address. *Reds against keeping any pre-proof discovery route, including a narrowed one.*
- **The picker works for more than one membership.** An address with two memberships clicks one link and is offered both, and choosing either opens a session at that scope. *Reds against the current count-branching dead end.*
- **One email claims a Universe.** A brand-new address types it once, clicks once, and lands in a claimed Universe with the mailbox recorded proven. *Reds against retaining the claim's own second link.*
- 🔒 **The proof credential cannot start a session outside the proven address's memberships.** Spending it at a scope the address holds no membership in is refused. *Reds against treating the credential as an authorization rather than as proof of identity.*
- 🔒 **The refresh cookie is still path-scoped per chosen scope.** A session started at one scope produces a cookie that is not sent to another scope's auth routes. *Reds against the scope-less global refresh shortcut — the one failure here that would look like success at every other criterion.*
- **A superuser arrives through the front door.** A configured bootstrap address that has never logged in types it, clicks, and is offered the platform entry. *Reds against leaving the mint on the unauthenticated request path.*
- **Unaccepted memberships are offered.** An invited-but-unaccepted address sees that scope in the picker and accepting it sets `acceptedAt`. *Reds against filtering the picker on acceptance, which would make an invitation unusable.*
- **Scoped links still work end to end.** An invite link and a scoped deep link both reach a session without passing through the picker — and the invite consume still sets its second `.dev` cookie. *Reds against replacing the scoped consume rather than adding beside it.*
- **The notice renders on both faces of the choose screen.** The picker and the claim prompt each carry the generic data-use notice. *Reds against pre-fix code, where no surface renders one, and against a build that covers only one face.*
- **The notice gates nothing and stores nothing.** Completing either face requires no interaction with it, and the diff adds no storage — client or server — for its display state. *Reds against an accept control or a has-seen flag.*
- 🌐 **The same, driven as a `/live` scenario.** Real logins, real mail: one address with two memberships picks each in turn, and a fresh address claims a Universe on a single email. ⚠️ **Fidelity, not capability** — the thing only a real run proves is that the mail actually sent in step 1 carries a link the consume accepts without a scope in it.
- **No unauthenticated route answers a question about an address.** ⚠️ State it structurally over `router.ts`'s open and Turnstile sets rather than as a list of endpoint names, which goes stale as the diff grows.
- **`docs/vision/auth.md` gains a § *Discovery*** naming the two pickers apart, and `grep -n '^> \*\*Today' docs/vision/auth.md` gains no entry for it — the section describes the shipped flow, not a target.
- *(Candidate — Pass 2 decides the phase.)* **The ui-smoke create-app case** from the backlog's zero-coverage row lands in this build, since the login rebuild already drives the adjacent screens through rendered ui-smoke.

## Non-goals

- **The in-app scope switcher** (`myScopeTree`, `activeScope`) — a different picker with a different source, named in § *Future state* only so the two stay apart.
- **Multi-session switching UI** — the picker makes it possible; building it is later.
- **Turnstile policy.** It stays exactly where it is; this changes which endpoints need to be behind it, not how it works.
- **The invite mechanism** → [archive/nebula-invite.md](archive/nebula-invite.md). Invites keep their scoped links.
- **Anything about reach or the claims shape** → [nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md).
- **Consent machinery beyond the notice** — no consent records, no accept flow, no policy page, no per-user data controls. The notice is informational by pinned decision; anything more is post-pre-alpha product surface with no current home.

## Open questions

1. **Is the proof credential single-use, or reusable within its TTL?** `docs/vision/auth.md` § *`authScope` (sessions)* says logging in at a second scope starts another session without ending the first. Single-use makes that cost a second email; reusable within a few minutes lets one click open sessions at two scopes. **Lean: reusable within a short TTL** — it is already gated on proven mailbox control, the TTL is the bound, and the scanner claim above forces the prove step to be repeatable within the link's TTL anyway, so single-use would be strictness the mechanism cannot deliver.

2. **Where does the proof live — a bearer in the response, or a cookie at a fixed non-scope path?** This decides whether the picker survives a reload or a tab close, and whether the credential is reachable by script. The two are not equivalent on either axis, and the cookie variant needs a path that cannot collide with a scope segment.

3. **How is the platform entry presented, and what happens when it is chosen?** It is a membership like any other, so it appears in the picker — but no node is named `nebula-platform`, the mesh boundary refuses every call to one, and `activeScope` defaults to `authScope` for every other entry. So choosing it cannot land in Studio the way a workspace does. **Lean: present it as a mode rather than a workspace, and have it land on the in-app scope switcher.** This is the question that started the thread, it gates the picker's shape, and the master plan's superuser `/live` scenario waits on its answer.

4. **What does `NEBULA_AUTH_REDIRECT` MEAN once the scope is chosen after the click?** Today it is "where a
   user-developer lands" — since the collapse it reads `/studio`, and `landingBase` tier-splits against it, so the
   sequencing half of this question is settled and this file inherits the shipped value. What remains is the meaning:
   either **(a)** the value becomes "where *everyone* lands to choose" and the tier branch moves **after** the pick,
   or **(b)** the picker gets its own route and the value keeps its current meaning for the post-pick hop.
