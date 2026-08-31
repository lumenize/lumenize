# Move active scope choice until after authentication (alt)

**Status:** Experiment per `/write-task` § *When to start OVER* — the sibling [nebula-login-prove-then-choose.md](nebula-login-prove-then-choose.md) is untouched while this file is written increment by increment from Larry's vision (2026-08-30); its arguments stay out of here until the mining pass at the end. The prove-then-choose re-order spine is unchanged — one scope-less link, the click proves the mailbox, then you choose. What is being redesigned from scratch is the choose screen: what it shows, where it is hosted, and where it forwards.

**Objective**: give the users a way to select an active scope and route them to it whenever they complete a login cycle, or whenever they select a menu item, say "Scopes" from thier avatar menu.

## Getting to the Scopes screen

- System learns the email of a user that needs to sign in either by self-signup or invite. (Invite is the scoped arrival — its membership exists before the click, it lands directly in the workspace, and it never passes this screen. Self-signup is the zero-membership arrival — see § *Decisions*, the newbie flow.)
- System sends them an email with a magic link
- User clicks on magic link. The response sets their cookies — one per membership of that address, each at its own authScope path (see § *Decisions*) — in a 302 to `/auth/{authScope}/scopes`, the scope segment filled with one of the scopes just minted (destination decided in code — the env var is gone; see § *Decisions*). **The screen they are taken to is what we are building in this task file.** No other identifier rides the URL: the page bootstraps a JWT at the segment scope's refresh endpoint, and the claims key everything after that.
- Alternatively, the user can select say, "Scopes" from their avatar menu and be taken to this same screen. For this, the app builds the URL's scope segment from its current claims.

## The Scopes screen

If the user's only authScope is a single Star, the screen will forward to the screen for that Star where activeScope == authScope. A spinner should be shown while that round trip and determination is made.

### Scope screen sections

- When it renders, the screen has several sections:
  - The **first section will show and allow them to change the current active email address** via a dropdown.
    - It will use the profileId to populate that list so it can find all associated email addresses.
    - There will be a small link for "use an unlisted email". When clicked the user will be taken to the endpoint (also probably off the apex router) for managing emails that they could also get to from their avatar menu. That screen will just show "coming soon" for now. 
    - We should create a standard component for "coming soon" that requires fields that allow us to log a description of what took them to this component. We'll later use the log entries to determine what to build next. 
    - When we later implement it, merging profiles will also be an option on that screen either to do right on the screen or taking them to another screen to do that. [Should we write this into the backlog or fast-follow?]
  - The **main section** is fairly complicated and allows them to select the active scope they want to work in.
  - There may be some **buttons at the bottom**. The only one I can think of right now though is "Logout".

### The main section of the Scopes screen

Elements, thoughts, constraints:

- The chosen email in the first section will drive the data for this section. When that changes, this section will rerender.
- The UI has to be highly scalable but still friendly for folks with two Star scopes. 
  - It figures out how to render based on the quantity of nodes at the expanded level(s) — say 20 or fewer, show them all. 
  - It needs to allow scopeAdmins to select an active scope in their domain but we don't want to render all Stars and maybe not even all Galaxies at first. 
  - Imagine Jennifer, a Universe scopeAdmin with 5 Galaxies of 5–50 Stars each. 
    - The discovery screen shows only her Universe scope — not clickable for now, since we have no UI there, but eventually that's where she'll manage her Galaxies. 
    - Beneath her Universe, a tree control shows her 5 Galaxies unexpanded and clickable. 
    - Clicking on one of the Galaxies takes her to the Studio for that Galaxy. 
    - She can also expand a Galaxy and see all the Stars beneath it.
    - Eventually, we may need a search box for the expanded Star list but that's out of scope for this task file. [file this as a backlog item]

## Open questions

None — the last one (the base theme color) resolved 2026-08-31; see § *Decisions*.

## Decisions

- **The magic-link consume mints cookies for ALL of the address's memberships, on one 302.**
  Multiple `Set-Cookie` headers ride a single response — the shipped invite dual-cookie co-mint is
  this with N=2. The mailbox click stays the ONLY session-minting moment: the Scopes screen is
  read-only and mints nothing, so the fixed 30-day TTL runs from the click and nothing on the
  avatar-menu path can extend it — renewal always takes fresh mailbox proof. An address's cookies
  are minted together and expire together: one login renews the whole set, and a dead mailbox takes
  every scope with it within 30 days of the last click. A missing cookie — a weeks-later
  avatar-menu visit, jar eviction, any cross-email membership — falls back to "click sends a fresh
  link," a path needed anyway since mailbox proof is per-address. Cost: one refresh record + one KV
  entry per membership in the one consume call (rows are cheap; a few dozen memberships max). The
  sibling file's separate proof credential is dead — the cookies are the proof carrier. Alts rejected:
  - **(a) Keep scoped links** (the request names a scope before any proof) — resurrects the
    pre-proof discovery oracle and the multi-membership dead end.
  - **(c) Mint one session at a designated membership**, every other scope needs another email —
    the original two-email disease in milder form.
  - **(d) Mint one cookie at consume, plus on-demand minting from the Scopes screen** for
    same-address siblings — a second minting site with a new authz rule ("a live session may adopt
    a sibling membership of its own emailId") for identical exposure, and it is exactly the
    mechanism that would let a monthly Scopes visit keep sessions alive without fresh mailbox
    proof. Rejecting it is what forecloses that workaround.
- **This task file owns the self-signup (claim) screen.** It is the zero-membership face of the
  same arrival — same consume, same redirect decision, same page shell — and it needs upgrading
  for pre-alpha regardless. A sibling task would take this file's consume contract as its central
  input mid-design, which is the coupling that argues for one file.
- **Newbie flow — self-declared fast path, plus a fallback slug screen.** The login form gains a
  "Create a new workspace" affordance expanding it to email + workspace name; submitting does what
  `claimUniverse` already does (scope row, unproved membership, slug reserved, link sent), and the
  click proves the mailbox, logs in, and lands directly in the new universe — like an invite, the
  link's purpose names its destination. One form, one email, one click, no screens between. A
  newbie who ignores the affordance and bare-logs-in must not dead-end: their zero-membership
  consume lands on a post-click slug screen instead of `/scopes`, authorized by a **signup-ticket
  cookie** that consume mints at a fixed non-scope path — spendable only at claim, short TTL, the
  only place the old proof credential survives. The same screen is the recovery surface for a
  contested slug (the three-way resolution rules carry over). Nothing leaks: both request forms
  answer "check your email" uniformly, and a slug conflict reveals slug-namespace facts only. The
  discover oracle's real job was routing login-vs-claim; the affordance lets the user route
  themselves. Alts rejected:
  - **Forwarding the one-time token into the signup URL** instead of the ticket cookie — a live
    credential in a browser-visible URL one hop past the email (history, accidental shares); the
    ticket never appears in a URL and dies at claim.
  - **Fallback-only** (every newbie picks the slug post-click) — matches today's screen count but
    loses to the affordance path, which costs little since the `claimUniverse` machinery exists.
- **`NEBULA_AUTH_REDIRECT` is deleted; landing destinations live in code.** The env var is a
  fossil of the `@lumenize/auth` fork — a standalone package let any host app configure where
  login lands, but nebula-auth serves one app, and the asymmetry already showed: `landingBase`'s
  star arm reads a hardcoded `/app` constant while the other arm reads config. Under this design
  the 302 target is per-link-purpose routing — bare link → `/scopes`, zero-membership →
  the fallback slug screen, claim/invite → the destination the link's purpose names, tier-split
  star vs above — pure code, one deployment, no knob that ever holds a second value. (Mining
  note: this dissolves the sibling file's open question 4, what the var MEANS after the re-order.)
- **Hosting + client stack: nebula-auth owns the feature; no NebulaClient.** The Scopes page
  lives at **`/auth/{authScope}/scopes`** — the mandatory bootstrap scope rides as a path segment
  (repo idiom: scope-as-segment), the consume's 302 fills it with one of the scopes it just
  minted, and the avatar menu builds it from claims. The GET row lives in nebula-auth's route
  table, keeping "the table IS the registration" true for all of `/auth/*`; its handler serves
  the built page through the host's ASSETS binding — a binding is infrastructure the host
  provides, like `EMAIL`. Bootstrap: `POST /auth/{authScope}/refresh-token` (path-scoped cookie,
  one KV read) → JWT held in memory → Bearer on data calls, validated locally. The data read is
  person-wide (profileId-keyed), so its endpoint is scope-less like `my-scopes` — the URL segment
  is bootstrap, never a `targetScope` — and NOTHING else rides the URL: the JWT's claims key
  everything (`profileId` for the read, `sub` → email for the dropdown default).
  - **The auth screens become their own small SPA** — the login form (today embedded in Studio's
    `App.vue`), Scopes, and the signup fallback — source owned auth-side; the deployed worker's
    build/assets pipeline is the one nebula-side mechanical fact, and folder mechanics (a `ui/`
    dir in the package vs a sibling workspace) are a phases decision. `App.vue` sheds its login
    code entirely.
  - **Serving mechanics, grounded in `apps/nebula/wrangler.jsonc`:** one assets bundle serves
    every page (`assets.directory`, today `../nebula-studio-ui/dist`). `/studio/*` is served by
    Workers Assets directly because it is UNLISTED in `run_worker_first`, with non-file paths
    falling back to `index.html` (`not_found_handling: "single-page-application"`). Any FILE in
    the bundle is likewise Assets-served with no worker involvement — a built `scopes.html`
    answers `/scopes` via `html_handling` — so worker-serving is only ever about segment-carrying
    URLs, whose paths match no file. (Contrast user-dev apps: Galaxy-served because they are
    runtime tenant content, absent from the deploy bundle.) `/auth/*` is already worker-first, so
    the Scopes GET row's handler is one line — `env.ASSETS.fetch` rewritten to `scopes.html`,
    zero wrangler changes — and the page's hashed `/assets/*` chunks bypass the Worker. The auth
    pages join the existing vite build as additional HTML entries (multi-page is native vite),
    sharing one dist.
  - **The Scopes GET row is a Worker-handled terminal, never a registry forward.**
    `env.ASSETS.fetch` runs in the edge isolate beside the user, and the asset's caching/ETag
    headers pass through untouched, so browser revalidation matches Assets-direct serving. The
    registry singleton sits in one colo — the `forwardRaw` rows rightly pay that RTT for data,
    but a page load never should.
  - **Passed over, not disproven: a router-shell `index.html`** — client-side routing serving
    Studio, Scopes, and future pages off the SPA fallback, with lazy route chunks so a
    non-Studio visitor fetches only their route's code. Mechanically sound (an earlier
    "segment URLs cannot fall through" claim here was a fact about today's studio-only
    `index.html`, not the platform), and it would serve `/scopes/{authScope}` with zero server
    code. Passed over because it moves URL ownership into frontend router config and out of
    nebula-auth's route table, and gives up the `/auth` namespace. Revisit if the page family
    grows or client-side transitions between surfaces become wanted.
  - **Rejected: NebulaClient / the facade** — `auth.md`: HTTP carries the session lifecycle; the
    mesh carries what a session does. This screen is lifecycle, pre-session, all reads, none of
    its data mesh-side — and mesh entry needs the very JWT+scope bootstrap the page exists to
    perform, plus a Gateway DO wake for a page whose job is to route away. The facade stays the
    door for mesh-originated session mutations.
  - **Rejected: JWT embedded in the served HTML** — makes a static page per-user and uncacheable,
    and puts a credential in the document; the refresh round trip is the clean bootstrap.
  - **Rejected: an apex-router intercept row serving the page** (an earlier sub-call here) —
    splits `/auth/*`'s registration across two tables, breaking the property nebula-auth's router
    is built on: a path with no table row reaches no handler.
  - **Rejected: bare `/scopes` + `?s={authScope}` query param** — same mechanics; loses the
    scope-as-segment idiom and puts the page outside the namespace its owner controls.
- **Scope-tree data: a summary with a node budget, plus expand — built now, no interim one-shot.**
  The summary returns the person's emails, each fully fleshed: memberships, and beneath admin
  memberships descendant levels breadth-first until a node budget (~50, configurable) is spent; a
  node past that frontier arrives as `childCount` only. `expand(scope)` returns one more level,
  authz re-derived server-side (the caller holds an admin membership at-or-above the expanded
  scope). No pre-alpha user exhausts the budget, so the summary IS one-shot in practice; the
  frontier semantics exist from day one so no consumer anchors on an unbounded response — the
  superuser's platform arm reaches every universe in the system, which must never be one singleton
  response. Singleton bound, stated for ADR-018 review: one summary read per screen visit, one
  expand per human click on a frontier node — human-frequency, the `my-scopes` cadence, never
  per-request. The ≤20 show-all-vs-collapsed thresholds live client-side. Rejected: one-shot now,
  budget/expand backlogged — the same shape minus counts, so it saves ~a phase and the row comes
  due exactly when the first big tenant arrives.
- **All emails fully fleshed in one response; the UI keeps the two-section layout.** Today
  `profileId`→email is 1:1 (adding a second address is unbuilt), so "flesh only the session's
  email" and "flesh all" are byte-identical responses until multi-email ships — shape it plural
  (`emails[]`) at zero present cost, and dropdown switches re-render locally with no refetch. The
  UI does NOT mimic the data shape: the email strip stays the first-section identity context
  (address + "use an unlisted email" today, a dropdown once plural), the tree stays the main
  section. Rejected: emails as tree roots — deepens every single-email user's tree by one dead
  level, and the two-Star person we prioritized pays it worst.
- **Session state is conveyed per-SECTION, derived client-side — no server session data in the
  contract.** Refresh records prove a session exists on SOME device, not in this browser, so
  serving them would mis-badge every new laptop. What is exact is the uniform clock from the
  all-cookies-at-consume decision: the bootstrap session being live means every same-address
  cookie in this browser is live too (minted by one click, expiring together) — so the selected
  email's whole tree is "click goes straight in", and a non-session email's section carries one
  banner: "signing in here emails {address}". Graceful residue, not a broken guarantee: a
  same-email membership minted after the last click (an invite accepted on another device) lacks
  a cookie here, and its click falls back to the fresh-link path.
- **Odds and ends, settled in one pass (2026-08-31):**
  - **Coming-soon sink: `@lumenize/debug` now; durable later via the observability pipeline.**
    Entries carry a distinctive event tag so any harvester finds them; the durable home is the
    on-hold observability-tail-worker task (console → Tail Worker → R2/AE), recorded as a backlog
    hand-off rather than a bespoke store. Not the registry — product telemetry is the wrong
    domain for nebula-auth, and the component will render on non-auth surfaces too. Not a
    platform-level data plane (none exists).
  - **Logout: two actions.** "Logout all" revokes every refresh record for the current address
    and expires all its cookies on one response — the mint-all's symmetric twin. Beside it, a
    quieter per-scope logout (the existing endpoint). Both also land in the avatar menu on
    Studio and future surfaces. `security.md`'s derived-session rule is untouched: an
    impersonation session's "log out" stays teardown-only, never the originator's cookie.
  - **Email-management stub:** own route in the auth SPA, reached from the avatar menu and the
    "use an unlisted email" link; renders the coming-soon component.
  - **Profile-merge:** one backlog row together with multi-email add-address — merge is
    meaningless before a second address can exist.
  - **Star-list search box:** backlog row.
  - **Fresh-visitor entry:** a login route in the auth SPA (`/auth/login`); logged-out surfaces
    redirect there once `App.vue` sheds its login form.
  - **The invite consume joins mint-all** — same helper, so an invitee's whole session set
    renews on accept and the `.dev` co-mint rides along unchanged.
  - **Screen and menu name: "Scopes".**
  - Backlog rows are created at the consolidation pass, so they cite the final file rather than
    this experiment.
- UI tech: Vue, Tailwind, DaisyUI.
- Theming - DaisyUI theme template where the minimum you need to specify is a base and accent color.
  - **Base color resolved (2026-08-31): greyish beige — a warm neutral.** Still grey-family (the
    modern look), and it receives Studio's warm orange sub-class cleanly where a cool grey would
    fight it; the coding-agent association fits the product rather than fighting it. The accent
    stays neutral in the base theme — the Studio sub-class owns brand color. Placeholder-tier by
    the design-deferral stance: one OKLCH variable, revisited when design gets real attention.
  - DaisyUI theme that also serves as the base theme for user-dev apps and every other UI... although we'll "sub-class" it for Studio to match Lumenize color scheme.
  - Only neutral colors (gray, beige, or brown) colors so as not to clash with any color scheme any user-dev app uses. That should be the base DaisyUI theme for user-dev apps also. User-dev apps will be enouraged to tailor the colors using theme extension but not actively encouraged (nor discouraged) to adjust other variables like spacing, corners, shadows, etc.. In most cases, the user-dev apps will leave those alone and the end user shouldn't notice that the screen is not in the theme of the app they meant to sign into, especially if there is only one scope, where the Scopes screen only gets to show a spinner.
- Remove the "Usage is captured to improve Lumenize" notice/permission from Nebula. We'll add it back when approriate. Right now, we believe it should go in the screens for self-signup as well as the screen for creating a new Galaxy. Alts rejected:
  - Putting it on every login page. Not every user needs to see/provide. The Universe/Galaxy owners need to agree/decide. They own the data of their tenants/users unless they decide to let their tenants/users own it or regulation requires that. If they want a notice/permission, they can provide that in their app. That's a decision for user-devs. We only want data to improve Nebula. Of course we have access to all of the data, just like Cloudlfare does, but we will only use it to improve Nebula.
- **Notice placements: one component, three renders, all owned here.** The data-use notice is
  built once and rendered where a user commits: the login form's expanded claim state, the
  fallback slug screen, and Studio's create-Galaxy flow. The create-Galaxy render is the
  load-bearing one for F&F day-1 — invitees never see self-signup, and they do create apps — so
  the master plan's before-first-invite consent GATE discharges entirely in this task; its bullet
  re-homes at the mining/Pass-2 step. Rejected: splitting the create-Galaxy render into its own
  item — a gate sliver with a deadline and no task file gets rediscovered late, one component
  render is minimal surface creep, and the create-app ui-smoke candidate drives the same screen.
