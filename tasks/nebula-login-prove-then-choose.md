# Move active scope choice until after authentication

**Status:** Active child — the login re-order and the data-use consent notice, one task. Design settled 2026-08-31 through a fresh `-alt` restart (increment-by-increment with Larry; the superseded draft lives in git history at this path). Zero open questions; § *Decisions* holds the full set. Every pre-alpha user meets this flow first, which is what makes it invite-gated.

> 📐 **`/write-task` Pass 1 — design intent is below, phases are NOT written.** From here: `/review-task` **Stage 1** → resolve and edit → phases → **Stage 2**. § *Acceptance criteria* is Pass-2 input.

**Objective:** give users a way to select an active scope and be routed to it whenever they complete a login cycle — or whenever they pick "Scopes" from their avatar menu. Discovery stops answering anyone who has not proved they hold the address, and the data-use notice renders where a user commits.

## Relationships

- **Discharges** the merged ⚠️ GATE bullet in [nebula-pre-alpha.md](nebula-pre-alpha.md) § *Invite-gated* — the login re-order and the consent notice, which land before the first non-Larry invite.
- **Supersedes** the `discover(email)` enumeration-oracle row in [backlog.md](backlog.md) § *Nebula Auth* — that row filed this re-order as the proper fix; the row goes when this lands.
- **Answers a hand-off** from [backlog.md](backlog.md) § *Nebula Auth*'s self-narrowing row: working below one's membership is `activeScope` on the membership's session, never a dominion-justified session mint — see § *Decisions*.
- **Answers the Super-admin building-block gap** in [nebula-pre-alpha.md](nebula-pre-alpha.md) — the superuser arrives through the front door and their tree renders under the node budget; the impersonate half of that `/live` chain stays the master plan's.
- **Natural home for the create-app-flow coverage debt** ([backlog.md](backlog.md) § *Nebula*) — now firmer than "adjacent": the notice's create-Galaxy render touches that exact flow, and the ui-smoke case is a Pass-2 candidate criterion.
- **Touches** [archive/nebula-invite.md](archive/nebula-invite.md) only at the consume helper: invites keep their scoped arrival and never pass the Scopes screen; the consume joins mint-all, and the `.dev` co-mint rides along unchanged.
- **Documentation** — [docs/vision/auth.md](../docs/vision/auth.md) § *activeScope*'s Today-differs block describes this screen's absence and closes when it ships; the doc also gains § *Discovery*, and `website/docs/nebula/auth-flows.md` changes.
- **Backlog rows created with this design** (all in [backlog.md](backlog.md)): multi-email add-address + profile-merge; the Scopes-screen search box; the coming-soon durable-sink hand-off.

## Context and current state

**Built already** — verified against disk 2026-08-30/31; each entry states its fate:

- **`discover(email)`** returns one entry per membership for an address — unauthenticated, Turnstile-gated, and already marked TERMINAL in its own route-table comment, kept only because the login page cannot yet live without it. **Fate: retired** — the route goes; the harness `turnstile-canary`, its one non-production caller besides tests, re-points at another open endpoint.
- **The schema separates the two proofs.** `getAndVerifyIdentity` flips `Emails.emailVerified` — proof of the mailbox, per-address, set once — and separately sets `Memberships.acceptedAt`, per-membership. **Fate: carried — this pair is the design's spine.** Under mint-all, `acceptedAt` moves to a membership's first refresh (§ *Decisions*).
- **`requestMagicLink`** inserts a scope-bound `MagicLinks` row and sends, minting no identity — except the bootstrap superuser arm, where an unauthenticated request naming the reserved scope with a configured bootstrap address writes that platform membership. **Fate: adapted** — it gains the scope-less form, and the bootstrap mint moves to the consume, behind proof.
- **`consumeAndLogin`** hashes the token, generates the refresh token, calls the consume RPC, sets the cookie — two on the invite arm (`devSession`) — and 302s tier-split. Its JSDoc pins the scanner invariant: links are multi-use within TTL because corporate scanners fetch them, and the click first-touches no per-user DO. **Fate: adapted, not split** — one consume mints N cookies (the dual-cookie arm generalized), and the 302 target comes from per-link-purpose code.
- **`refreshCookie`** — `Path={prefix}/{scope}`, `HttpOnly`, `Secure`, `SameSite=Strict`, fixed TTL. **Fate: carried unchanged.**
- **`handleRefreshToken`** exchanges the path-matched cookie for a JWT — a KV read, with the registry fallback on a miss that `security.md` § *Refresh tokens* documents. **Fate: carried as the destination surfaces' path and the acceptance writer, plus a named sibling — `inspect-token` shares its implementation, minting the same token without the flip, and the Scopes page bootstraps there.** `NebulaClient` already writes a per-workspace localStorage hint on token acquisition; that hint carries as the authScope hand-off (§ *The Scopes screen*).
- **`my-scopes` → `myScopeTree`** — the authenticated scope-tree read: dominion-keyed so a member-less new galaxy still appears (its JSDoc defends exactly that), flat, unbounded on its platform arm; its two consumers are Studio's post-connect nudge and the manage panel, via `scopes.list()`. **Fate: absorbed** — the summary endpoint replaces it (its admin subtrees also read `Scopes`, preserving the member-less-galaxy property); `scopes.list()` re-backs onto the summary, and the route row + registry method retire.
- **The Studio login** lives inside `App.vue`: `discover` on the typed address, branch on the count, dead-end past one. **Fate: extracted** — the count branch dies and `App.vue` sheds its login code entirely; the login form moves to the auth SPA.
- **`claimUniverse`** writes the scope row and an unproved admin membership, reserves the slug, sends the link; the click proves and logs in, with three-way contested-slug resolution. **Fate: carried nearly intact** — it becomes the "Create a new workspace" affordance's engine, reached by user choice instead of by a pre-proof discovery result.
- **Scoped links** (invites, deep links) bypass discovery entirely. **Fate: carried.**

**Missing:**

1. **The Scopes screen does not exist.** A person with two memberships dead-ends in the UI.
2. **Discovery answers before anyone proves anything.** Any caller learns which scopes an address holds — and at Galaxy/Universe tiers membership *is* admin-ship, at the platform scope superuser-ship, so narrowing the response cannot close it.
3. **The newbie path is routed by the oracle.** The claim prompt appears only because `discover` answered zero — the exact pre-proof read this design deletes.
4. **The superuser cannot arrive through the front door.** Their membership is minted *by* the platform-link request, so first-login discovery returns nothing and the way in is a hand-typed URL.
5. **The flow forces a scope onto a scope-independent proof.** `emailVerified` belongs to the address, but the only path setting it demands a membership at a named scope.
6. **The data-use notice exists nowhere**, and its master-plan placement (the claim prompt) is a screen this task relocates.
7. **No auth SPA exists** — session-lifecycle UI lives inside Studio's product bundle.

## Design intent, constraints, and future state

### Getting to the Scopes screen

- System learns the email of a user that needs to sign in, by self-signup or invite. (Invite is the scoped arrival — its membership exists before the click, it lands directly in the workspace, and it never passes this screen. Self-signup is the zero-membership arrival — § *Decisions*, the newbie flow.)
- System sends them an email with a magic link.
- User clicks the link. The response sets their cookies — one per membership of that address, each at its own authScope path — in a 302 to `/auth/{authScope}/scopes`, the segment preferring an accepted membership's scope. **The screen they are taken to is what this task builds.** No other identifier rides the URL: the page bootstraps a JWT at the segment scope's `inspect-token` endpoint (§ *Decisions* — never `refresh-token`, which would flip acceptance), and the claims key everything after that.
- Alternatively, the user picks "Scopes" from their avatar menu; the app builds the URL's scope segment from its current claims.

### The Scopes screen

If the user's only authScope is a single **accepted** Star, the screen forwards to that Star with `activeScope == authScope`, showing a spinner while that round trip resolves. An arrival holding only unaccepted memberships renders the tree instead — its invited rows badged, their navigation gated by the consent modal (§ *Decisions*).

**Sections.** The **first section** shows the current email address — a dropdown once an address can be plural, with a small "use an unlisted email" link to the email-management screen (a coming-soon stub for now). The **main section** is the scope tree. **Bottom buttons:** "Logout all", with a quieter per-scope logout beside it.

**The main section.** The chosen email drives the tree; switching re-renders locally from data already fetched. The UI is scalable but friendly for folks with two Star scopes — it decides how to render from the quantity at each expanded level (say 20 or fewer, show them all). Jennifer, a Universe scopeAdmin with 5 Galaxies of 5–50 Stars each: her Universe row renders unclickable (no universe UI yet — eventually that is where she manages Galaxies), her 5 Galaxies beneath it unexpanded and clickable. Clicking a Galaxy takes her to its Studio; expanding one shows its Stars.

**The hand-off to the destination.** A clicked scope's surface must refresh at the *membership's* path (`/auth/acme/refresh-token`) while working at the clicked scope (`activeScope: acme.crm`) — and it cannot read cookies to find that path. The Scopes screen knows each subtree's owning membership, so it writes the per-workspace hint `NebulaClient` already reads (the shipped localStorage mechanism) before navigating. A destination that cannot mint — no hint, expired session — redirects to `/auth/login`, and the post-login landing is this screen again.

### Discovery reads a proven address, never a claimed one

One property is what this section exists to keep, stated so it does not decay into "discovery is Turnstile-gated" or "we dropped the admin bit" — neither is it. What must stay true: scope information is only ever returned to a caller holding a session — and every session is born from a click on mail delivered to the address.

### How the screen is served and bootstrapped

One assets bundle serves every page (`assets.directory` in `apps/nebula/wrangler.jsonc`). `/studio/*` is Workers-Assets-served by being unlisted in `run_worker_first`; `/auth/*` is worker-first, so the Scopes GET row in nebula-auth's table serves the built page in one line — `env.ASSETS.fetch` rewritten to the page's file — with caching/ETag headers passing through untouched, and the hashed `/assets/*` chunks bypassing the Worker entirely. The row is a **Worker-handled terminal, never a registry forward**: the singleton sits in one colo, and a page load never pays that RTT. The auth pages join the existing vite build as additional HTML entries, sharing one dist.

Bootstrap, in order: document GET (edge, static) → `POST /auth/{segment}/inspect-token` (path-matched cookie; a KV read with the registry fallback on a miss) → JWT held in memory → Bearer on the data calls, validated locally. A 401 at bootstrap degrades to the login form in the same SPA — a made-up scope produces a cookieless request, indistinguishable from a real scope with no session, so a typed URL learns nothing.

### The data contract

The summary returns the person's emails, each fully fleshed — memberships, and beneath admin memberships descendant levels breadth-first until a node budget (~50, configurable) is spent; a node past that frontier arrives as `childCount` only, and `expand(scope)` fetches one more level with its authz re-derived server-side. For Jennifer:

```jsonc
{
  "emails": [
    { "email": "jennifer@acme.com",   // marked current from the JWT's sub
      "current": true,
      "memberships": [
        { "scope": "acme", "tier": "universe", "scopeAdmin": true,
          "children": [               // first level under an admin root, eagerly
            { "scope": "acme.crm", "tier": "galaxy", "childCount": 12 },
            { "scope": "acme.hr",  "tier": "galaxy", "childCount": 5 }
          ] } ] },
    { "email": "jen@gmail.com",       // cross-email: no cookies in this browser, ever
      "memberships": [
        { "scope": "beta.tools.stars-r-us", "tier": "star", "scopeAdmin": false } ] }
  ]
}
```

Session state derives client-side from the mint-together clock: the bootstrap session being live means every same-address cookie in this browser is live too, so the current email's whole tree is "click goes straight in" and a non-session email's section carries one banner — "signing in here emails jen@gmail.com". Each membership row also carries its acceptance state and, when invite-minted, the `invitedByName` stamp — the invitation badge and the consent modal render from this response alone, with no further calls. The single-Star fast-forward decides itself from this response; the ≤20 thresholds live client-side. The summary serves the in-Studio flows too — `scopes.list()` re-backs onto it, and the manage panel rides the same budget + `expand` contract.

### Claims this rests on, stated so review can falsify them

- **Multiple `Set-Cookie` headers ride one 302** — the shipped invite `devSession` arm is this exact code path with N=2, so mint-all is a generalization, not a new capability.
- **Sending to an unknown address is already the standing behavior**, established by `requestMagicLink`'s no-mint invariant — the uniform response changes what a caller *learns*, not what we *send*.
- **Nothing here gates the wipe.** `MagicLinks` rows are ephemeral, the signup ticket is a cookie, mint-all writes existing row types, the acceptance flip updates an existing column — and the one schema addition, the `invitedBy*` stamp columns on `Memberships`, is created free in the greenfield wipe everything already rides.
- **The invite mint runs where the inviter's Profile is reachable** — invites initiate mesh-side and reach the Registry through the facade (`auth.md` § *Grants in both planes*), so the `invitedByName` stamp costs no new plumbing and this page needs no mesh access to display it.
- **`discover`'s only production consumer is the Studio login.** The shared `email-login.ts` helpers never call it; `turnstile-canary` uses it as a side-effect-free probe and re-points when the route dies.
- **The scanner invariant transfers.** Links stay multi-use within TTL and the click still first-touches no per-user DO; a scanner's extra fetches strand N orphan sessions per fetch instead of one, swept like any others.
- **`activeScope` confinement already supports working below a membership** — the refresh endpoint confines the requested `activeScope` to what the session reaches, and "authenticate at the universe, name the galaxy in `activeScope`" is how prod already works.
- **The per-workspace localStorage hint exists** — `NebulaClient` writes it on every token acquisition; the hand-off rides a shipped mechanism.

### Constraints

- **[ADR-009](../docs/adr/009-real-auth-path.md)** — real email login stays rung 1. The click now lands on the Scopes screen (or in the claimed universe), so `provisionAndLogin` / `loginViaEmail` and the vitest helpers change shape.
- **`security.md`** — no scope-less global refresh and no slide: cookies stay path-scoped per scope, the signup ticket refreshes nothing, and minting happens only at the click. The derived-session rule is untouched by "Logout all".
- **`router.ts`'s Turnstile set** — every unauthenticated registry endpoint stays listed there; the scope-less request form and the claim affordance's request both join it, and removing `discover` must leave the invariant true.
- **[ADR-012](../docs/adr/012-global-profile-visibility.md)** — the tree lists memberships regardless of `acceptedAt`, and the scoped-admin profile branch keeps gating on ACCEPTED. The acceptance-at-first-refresh decision preserves that manufacture defense — minting a cookie never flips acceptance, and entering an invited membership passes the consent modal — and the ADR's "only writer is the login verify path" sentence updates at build to name `refresh-token`'s first success instead.
- **[ADR-013](../docs/adr/013-identity-profileid-resolution.md)** — the `invitedByName`/`invitedBySub` stamp is the licensed write-time-pinned attribution denormalization: display-only, never keyed, never re-derived.
- **[ADR-017](../docs/adr/017-the-url-is-the-view-state.md)** — the URL carries the bootstrap scope and nothing else: no email, no credential; authz is re-evaluated on arrival, and a shared Scopes URL shows the recipient their own worlds.
- **[ADR-018](../docs/adr/018-singleton-is-the-scarce-resource.md)** — the summary and expand reads land on the registry singleton at human frequency (per visit, per click), the `my-scopes` cadence; the node budget is what keeps the superuser's response bounded.
- **`ui-theming.md`** — color through the daisyUI theme on every face; the theme decisions in the table are Larry's palette calls, placeholder-tier by the design-deferral stance.
- **Pre-alpha** — no users, no compatibility problem, no migration.

### Future state

- ⚠️ **Design consideration:** the email strip and plural data contract are the ready seam for multi-email profiles (add-address and merge are backlogged); nothing here forecloses them.
- ⚠️ **Design consideration:** Jennifer's unclickable Universe row is the placeholder for universe-level management UI — the row exists so universe management has a door when it earns one.
- ⚠️ **Design consideration:** the Scopes screen is the natural home for multi-session visibility later; sessions already coexist by cookie path, and this is the first surface that could show them.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The consume mints cookies for ALL the address's memberships, on one 302** — the invite dual-cookie arm generalized. The click stays the only minting moment: the screen is read-only, so the fixed 30-day clock runs from mailbox proof and nothing on the avatar-menu path extends it. One clock per address: one login renews the set; a dead mailbox takes every scope within 30 days of the last click. | **(a)** scoped links — resurrects the pre-proof oracle and the dead end. **(c)** one designated membership, others need another email — the original disease, milder. **(d)** lazy minting from the screen — a second minting site with a new authz rule for identical exposure, and exactly the capability that would let a monthly visit keep sessions alive without fresh proof. |
| **Working below a membership rides `activeScope` on that membership's session** — Jennifer enters `acme.crm` on her `acme` session; the refresh endpoint already confines `activeScope` to reach. Closes the hand-off in backlog § *Nebula Auth*'s self-narrowing row. | A dominion-justified refresh minted at a scope with no membership — a third minting site; sessions stay membership-anchored, and narrowing is `activeScope`'s job (token-level self-narrowing stays that backlog row's own question). |
| **`acceptedAt` has ONE writer — the first successful `refresh-token` call for that membership. The consume-time flip is removed, and the Scopes page bootstraps on `inspect-token`: a named sibling route sharing the refresh implementation, minting the same full-strength token and never flipping, by construction.** Entering the scope is what acceptance means (ADR-012's intent), and the per-endpoint contract is what a test pins — the mutation is "swapped the endpoint". The 302 segment prefers an accepted membership and the single-Star fast-forward fires only for one, so an unaccepted-only arrival renders the tree instead of auto-navigating. On a KV miss, the fallback reconstruction DERIVES the boolean from `Memberships.acceptedAt` — it never writes, keeping the writer single on both arms; on a hit with it false, `refresh-token` fires a `waitUntil` registry flip + KV rewrite, once per membership, off the response path. Scanner rationale: prefetching scanners consume links and follow redirects but run no JS — today that forges acceptance for any scanner-protected address; under this rule nothing flips without a real browser entering the scope. The manufacture test re-pins so restoring a consume-time flip (or a flipping bootstrap) reds, and the column's other reader — the unfinished-claim test in the contested-slug resolution — keeps its meaning: a scanner-consumed claim link now correctly stays unfinished. Residue: a full detonation sandbox that keeps cookies and renders the landing page could still flip the one invited membership; the named escalation — NOT built now — is the interstitial POST-on-click from `consumeAndLogin`'s JSDoc. | **(A)** keep the scoped-consume flip — mint-all makes "usable but never accepted" a permanent state, and the scanner hole stays open. **(C)** flip everything the bare consume mints — a victim's unrelated login would accept an attacker's invite, dissolving the defense. **(D)** an explicit accept endpoint on the tree — a new cross-membership authz rule for what a navigation already proves. **A no-flip body marker on `refresh-token`** — identical round trips, but a behavioral fork hidden in a param where the route table cannot show it; the named sibling gives each behavior its own row and a per-endpoint testable contract. |
| **Entering an invited membership passes an informed-consent modal, and the inviter's identity is a write-time stamp.** Tree navigation into a membership that is unaccepted AND invite-minted pops: *"You've been invited by {inviter} to collaborate in {scope}. Only accept if you know who this is and why."* — checkbox, Accept, Decline. Accept navigates, and the destination's `refresh-token` does the flip; Decline stays on the tree with the row badged, nothing written. No accept endpoint exists — the modal is UI in front of a navigation. `invitedByName`/`invitedBySub` are stamped on the membership row at invite mint — mesh-side, where the inviter's Profile is in hand — under ADR-013's write-time-pinned-attribution carve-out: display-only, never keyed, columns free in the greenfield wipe. The stamp doubles as the discriminator: stamped → invited → modal; unstamped → your own claim → no ceremony. The invite templates (`invite-new`/`invite-existing`, already distinct from login mail) gain the same warning sentence — the email is the click path's consent surface, since an invite link lands directly in the workspace and never passes the tree. | **Email-warning only** — powerless on the tree path, where the victim may never have seen the invite mail at all (scanner-consumed, filtered, ignored); the modal is the only consent surface standing there. **Modal without the stamp** — this page cannot reach Profiles (mesh-side; the surface is deliberately HTTP-only), so a render-time name lookup would drag NebulaClient back in. **Click = accept with no modal** — a curiosity-click on an unfamiliar badged row would hand a stranger private-profile access; the modal makes the grant informed. |
| **This file owns the self-signup (claim) screen** — the zero-membership face of the same arrival. | A sibling task — it would take this file's consume contract as its central input mid-design. |
| **Newbie: a self-declared fast path plus a fallback slug screen.** "Create a new workspace" expands the login form to email + name; today's `claimUniverse` engine carries, and the click lands in the new universe — one form, one email, one click. The undeclared newbie's zero-membership consume lands on a post-click slug screen authorized by a **signup-ticket cookie** at a fixed non-scope path — spendable only at claim, short TTL, the proof credential's one surviving remnant — which also recovers a contested slug. | Forwarding the one-time token into the signup URL — a live credential in a browser-visible URL one hop past the email. Fallback-only — matches today's interaction count where the affordance beats it for nearly free. |
| **`NEBULA_AUTH_REDIRECT` is deleted; destinations live in code** — per-link-purpose routing: bare → Scopes, zero-membership → slug screen, claim/invite → what the link names, tier-split star vs above. | Keeping the knob — a fossil of the `@lumenize/auth` fork; one deployment, never a second value, and `landingBase` already hardcodes the star arm. |
| **nebula-auth owns the feature; the page lives at `/auth/{authScope}/scopes`** — a GET row in nebula-auth's table serving the built page via the host's ASSETS binding; § *How the screen is served and bootstrapped* carries the mechanics. | **NebulaClient / the facade** — session lifecycle is HTTP (`auth.md`), and mesh entry needs the very bootstrap this page performs. **JWT embedded in the HTML** — per-user, uncacheable, a credential in the document. **An apex intercept row** — splits `/auth/*` across two tables. **Bare `/scopes?s=`** — loses the segment idiom and the namespace. **Passed over, not disproven: a router-shell `index.html`** with lazy route chunks — zero server code, but URL ownership moves into frontend router config; revisit if the page family grows. |
| **The auth screens are their own small SPA** — login, Scopes, signup fallback; source owned auth-side; `App.vue` sheds its login code. Folder mechanics are a phases decision. | Staying in the studio bundle — a session-lifecycle surface embedded in a product surface, today's mislocation preserved. |
| **Tree data: a summary with a node budget plus `expand`, built now** — § *The data contract*. | One-shot now, budget backlogged — the same shape minus counts saves ~a phase, and the row comes due exactly when the first big tenant arrives. An unbounded superuser response — every universe in one singleton read. |
| **`my-scopes`/`myScopeTree` is absorbed and retired.** The summary is a superset — its admin subtrees read the `Scopes` table, preserving the member-less-new-galaxy property the old method's JSDoc defends — and the in-Studio consumers (the post-connect nudge, the manage panel) hold Bearer JWTs, so `scopes.list()` re-backs mechanically and rides the same budget + `expand` contract. The unbounded platform arm dies with it. | Carried in parallel — two tree reads whose results must agree forever, the rejected unbounded platform arm surviving on one of them, in consumers this task already edits. |
| **All emails fully fleshed; the UI keeps the two-section layout.** Today `profileId`→email is 1:1, so the plural shape costs nothing, and dropdown switches re-render locally. | Emails as tree roots — one dead level for every single-email user, worst for the two-Star person we prioritized. Thin single-email data — the same bytes today, a refetch tomorrow. |
| **Session state per-SECTION, derived client-side** from the mint-together clock (§ *The data contract*). | Serving refresh records — they prove a session on SOME device, mis-badging every new laptop. |
| **The notice leaves the login page; it renders where a user commits** — the claim affordance, the fallback slug screen, and Studio's create-Galaxy flow. One component, three renders, all owned here; informational, no gate, no stored value; generic improve-the-product wording, never naming Studio or the model. | Every login page — Universe/Galaxy owners own their tenants' data relationship; a per-tenant notice is the user-dev's call, and we only want data to improve Nebula. An accept-gate or stored flag — friction on the funnel, schema for a decoration. Splitting the create-Galaxy render out — a gate sliver with a deadline and no file. |
| **Logout: "Logout all" plus a quieter per-scope logout** — all revokes every refresh record for the address and expires all its cookies on one response, the mint-all's symmetric twin; both actions also land in avatar menus. | Per-scope only — not what "log out" means on a shared machine once cookies mint together. |
| **The invite consume joins mint-all** — same helper; an invitee's whole session set renews at the click; the `.dev` co-mint rides along. | A bespoke dual-cookie-only invite arm — per-path reasoning to maintain forever. |
| **Coming-soon component logs to `@lumenize/debug` now; durable later via the observability pipeline** — a distinctive event tag, and the hand-off is a backlog row, not a bespoke store. | A registry table — product telemetry in the identity domain, for a component that will render on non-auth surfaces. AE / R2 / a platform data plane — too much now, or does not exist. |
| **UI tech: Vue + Tailwind + daisyUI.** | — |
| **Theme: one shared neutral base — greyish beige — that Studio sub-classes with brand color.** A warm neutral receives the orange sub-class cleanly; the accent stays neutral in the base; user-dev apps extend colors and leave spacing/corners/shadows alone. Placeholder-tier: one OKLCH variable, revisited when design gets real attention. | Brown — heavy and dated as a full surface. Cool grey — warm/cool tension under Studio's accents. Per-surface bespoke themes — the restyle cost theming exists to avoid. |
| **Small dispositions:** the email-management stub gets its own auth-SPA route rendering coming-soon; `/auth/login` is the fresh-visitor entry once `App.vue` sheds its form; the screen and menu item are named "Scopes". | — |

## Acceptance criteria — input to Pass 2, not yet decomposed into phases

- 🔒 **An unproven address learns nothing.** Requests naming a member address and a stranger address produce identical responses, and no unauthenticated route returns scope names for an address. *Reds against keeping any pre-proof discovery route, including a narrowed one.*
- **One click, all sessions.** An address with two memberships clicks one link and receives both cookies on one 302; each scope on the Scopes screen opens without further email. *Reds against single-cookie minting.*
- **The Jennifer tree renders by the rules.** An admin membership shows its first level clickable; a galaxy click lands in that Studio via the authScope hand-off; expansion past the frontier fetches one level. *Reds against reach-less rendering and against a broken hand-off.*
- **One email claims a Universe** via the affordance, landing directly in the claimed universe with the mailbox recorded proven. *Reds against a second link.*
- 🔒 **The signup ticket is spendable only at claim.** It starts no session and reads no data; the fallback slug screen is its only consumer. *Reds against the ticket acting as a general credential.*
- 🔒 **The refresh cookie stays path-scoped per scope.** A session at one scope produces a cookie never sent to another scope's auth routes. *Reds against the global-refresh shortcut — the failure that would look like success everywhere else.*
- **A superuser arrives through the front door.** A configured bootstrap address that has never logged in types it, clicks, and sees the platform root in their tree. *Reds against leaving the mint on the unauthenticated request.*
- **Unaccepted memberships are offered, and acceptance flips only on genuine entry.** The tree shows an invited-but-unaccepted scope badged with its inviter's name; a bare consume leaves `acceptedAt` NULL even while minting its cookie; `inspect-token` never flips; navigation into the invited row passes the consent modal; and only the destination's first `refresh-token` success flips. *Reds against restoring the consume-time flip, against a flipping bootstrap, against modal-less navigation, and against filtering the tree on acceptance — the manufacture test pins the writer per endpoint.*
- **Scoped links still work end to end** — an invite lands in its workspace with the `.dev` cookie and the invitee's other sessions renewed. *Reds against replacing the scoped consume.*
- **The notice renders at all three placements** — claim affordance, fallback slug screen, create-Galaxy — and gates nothing, stores nothing. *Reds against a missed render, an accept control, or a has-seen flag.*
- **Logout all revokes everything for the address** — every refresh record dead, every cookie expired, in one response; per-scope logout still works. *Reds against a logout that leaves a sibling session alive.*
- **Nothing replaced survives in parallel.** Every surface this design supersedes is deleted in the same build, never left beside its successor — the known set: `discover` (route row, registry method, Turnstile entry), `my-scopes`/`myScopeTree` and the old `scopes.list()` backing, `NEBULA_AUTH_REDIRECT` at every config site, `App.vue`'s login block, and the consume-time `acceptedAt` flip. The set is a floor, not a cap: any build step that replaces a surface acquires the obligation to delete what it replaced. *Reds against any retired symbol surviving a scoped grep of the source tree after the build.*
- 🌐 **The same, driven as `/live` scenarios.** Real logins, real mail: a two-membership address enters both scopes off one email; a fresh address claims via the affordance; a superuser walks the front door. ⚠️ Fidelity, not capability — only a real run proves the mail carries a link the scope-less consume accepts.
- **No unauthenticated route answers a question about an address** — stated structurally over `router.ts`'s open and Turnstile sets, never as an endpoint list.
- **`docs/vision/auth.md` closes and gains** — § *activeScope*'s Today-differs block about the missing picker closes; § *Discovery* is added; `grep -n '^> \*\*Today' docs/vision/auth.md` gains no new entry.
- *(Candidate — Pass 2 decides the phase.)* **The ui-smoke create-app case** from the backlog's zero-coverage row lands here, driving the same screens the notice and login rebuild touch.

## Non-goals

- **Universe-level management UI** — Jennifer's Universe row renders unclickable; what sits behind it is future work with no task yet.
- **Multi-email add-address and profile-merge** → backlog § *Nebula Auth*; the email strip and plural contract are the ready seam.
- **The Scopes-screen search box** → backlog § *Nebula Auth*.
- **Email management** — a coming-soon stub only.
- **Turnstile policy** — unchanged; this changes which endpoints sit behind it, not how it works.
- **The invite mechanism** → [archive/nebula-invite.md](archive/nebula-invite.md); invites keep scoped links.
- **Anything about reach or the claims shape** → [archive/nebula-passage-dominion-from-scope.md](archive/nebula-passage-dominion-from-scope.md).
- **Consent machinery beyond the notice** — no records, no accept flow, no policy page, no per-user data controls.

## Open questions

None — the last one (`acceptedAt` timing under mint-all) resolved 2026-08-31; see § *Decisions*.
