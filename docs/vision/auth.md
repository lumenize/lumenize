# Authentication and Access Control

## Lumenize Nebula mesh

Nebula is made up of a highly distributed mesh of nodes. Nearly all communication between them goes through `lmz.call()`, an RPC system that sits on top of Cloudflare's Workers RPC as the transport within Cloudflare and WebSockets as the transport to and from the outside world. The auth Registry is the notable exception; it has its own section below. We use Cloudflare's Durable Object instance name feature as the address of each durable node.

### High-level auth overview

We use **defense in depth** and **zero trust** to secure the mesh.

You enter by authenticating, which sets a long-lived refresh cookie. That cookie mints short-lived access tokens in the form of signed JWTs. You then open a connection by presenting one, and its contents ride along with everything you do inside the mesh — through long chains of `lmz.call()`s — and can be a factor in every permission decision below.

From there, calls pass the same layers in the same order, even if some of them are intentionally a no-op. None of them is sufficient on its own:

1. **Cloudflare's addressing.** A call can only arrive at the node it named, and that node's storage is reachable from nowhere else. This is real protection and we get it before any of our own code runs — but it decides *where* a call lands, never *who* may make it.
2. **The name stamp.** A durable node has two addresses: an instance name and a 64-character hex id. The first time a node is addressed we record the binding and instance name it was reached by, and any later mismatch throws. A node cannot change its name, nor be reached through the wrong binding.
3. **`onBeforeCall()`.** The scopes in your JWT say which part of the mesh you are a member of and where you are currently working. This is where we decide whether that lets you reach into this node at all.
4. **The `@mesh()` allowlist.** Only methods decorated with `@mesh` (TC39 stage 3 decorators) are callable over `lmz.call()`. Everything else on the node is unreachable from outside it.
5. **The guard function.** `@mesh()` can carry a guard that runs before the method. Read-only operations usually have none, because passing the boundary is enough. Almost anything that changes state carries one.
6. **Checks at the top of the method.** A guard is handed only the node instance, never the method's arguments — so any decision that depends on *which* record or *which* orgTree node you are touching cannot live in one. Those checks run just inside the method and throw an explanatory error that travels back over the `lmz.call()` response, so the caller learns why it was denied.
7. **The Data-plane DAG (ReBAC).** The commonest such error is `PermissionDeniedError`, thrown when an operation is attempted on a Resource the caller has no permission for. The data plane keeps its own `admin`, `write`, and `read` grants on an orgTree shaped as a directed acyclic graph, so it can model the real-world messiness of organizations — people on loan to another department, teams reporting into two business units. This is a specific form of the general relationship-based access control (ReBAC) approach.

The sections that follow expand on each.

## Scopes

A scope is the instanceName half of a node's address, and it is what the coarse-grained gate reads. In `https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, the `{u}.{g}.{s}` would be the scope.

Examples:

- `{universe}.{galaxy}.{star}`, often abbreviated as `u.g.s`. Indicates a Star.
- `u.g`. Indicates a Galaxy, which contains `u.g.s` and many other Stars.
- `u`. Indicates a Universe, which contains `u.g` and other Galaxies.

Notice how **scopes are hieararchical**. The `this-universe.milky-way.sol` Star is a part of the `this-universe.milky-way` Galaxy, etc. This is important for the **Coarse-grained access control** discussion below.

## `authScope` (Sessions)

A session has one `authScope`, represented by the refresh cookie set at login. It outlives any particular access token, tab, or client and has a long TTL. Reloading the page reuses it, and logging in at a different scope starts another one without removing the current one so more than one can be active at any given time, each with a different `Path` and expiration.

The refresh cookie is `HttpOnly` so no script can read it, `Secure` so it only travels over HTTPS, and `SameSite=Strict` so it is never sent cross-site. Its `Path` is `/auth/{authScope}`.

Browsers decide which cookies to send by starts-with-style matching the request path against that `Path`, one whole segment at a time. So a cookie at `/auth/{u}` is sent to `/auth/{u}` and to anything deeper, like `/auth/{u}/refresh-token`, but not to `/auth/{u}.{g}/`, because `{u}.{g}` is a different URL segment rather than a deeper path. Sessions at different scopes are therefore fully separate.

## `activeScope`

An access token is a signed JWT. It has one `activeScope` — where you are working right now, carried as the `aud` claim.

The client asks for it. Each time it refreshes, it names the scope it wants to work in, and the server checks that against the session's own record rather than against anything the client sent. So you may ask for any scope your session reaches into, and for no other (more on in a later section).

One session can mint access tokens at different active scopes over its life. That is what a user-developer moving around their own Universe is doing: authenticated at `u`, working in `u.g` while editing an app, then in `u.g.s` while looking at one of its tenants. The two differing is the ordinary case, not an unusual one.

`activeScope` should also agree with what the URL says you are looking at. Today it can drift, which breaks sharing a link — the recipient lands on the right page pointed at the wrong scope. [ADR-017](../adr/017-the-url-is-the-view-state.md) is the not-fully-implemented commitment that closes that.

The contrast, at a glance:

| | `authScope` | `activeScope` |
|---|---|---|
| Belongs to | the session | each access token |
| What it is | where you authenticated | where you are working right now |
| Where it lives | the refresh cookie's path, and the JWT's `access` claim | the JWT `aud` |
| Who sets it | fixed at login | the client asks, on each refresh |

## The access token

An access token carries both scopes: the session's auth scope in its `access` claim, and the active scope as `aud`. The first is what lets a guard ask "may this caller reach in here?" without going back to the Registry. The second says where the client is looking, and carries no authority of its own.

A whole token, annotated — a Galaxy admin who is currently looking at one of their tenants:

```jsonc
{
  "sub": "8f3c…",              // the membership: one address in one scope
  "aud": "acme.crm.bigco",     // activeScope — where I am working
  "access": {
    "authScope": "acme.crm",   // where I am a member
    "admin": true              // see Coarse-grained access control
  },
  "profileId": "1a9d…",        // my public profile — see Profiles
  // "act": { "sub": "…" },    // present only when impersonating — see Impersonation
  // the standard JWT claims
  "iss": "…", "exp": 1754400000, "iat": 1754399100, "jti": "…"
}
```

Some decisions need nothing but the token. Whether you reach into a node comes from `access` alone, which is why a guard can answer it without leaving the node. Others need the token *and* a lookup — whether you may write someone's private profile fields depends on the `profileId` here plus an accepted membership that only the Registry knows about.

## Coarse-grained access control

> Today the JWT carries a wildcard pattern derived from the scope (`u.g.*`) instead of the scope itself, and a non-admin reaches downward. [nebula-reach-from-scope.md](../../tasks/nebula-reach-from-scope.md) replaces that with what is described here. That task has also not yet ratified deciding reach from `authScope` alone, which this section now describes.

**This layer exists to make lateral movement impossible.** If you are a member of one Star, there is nothing you can do with another. You cannot see it, read it, write it, or reach it at all — the call is refused at the boundary, before any method of that node exists to be called. That is the first row of the table below, and it is the case this whole layer is built around. Vertical movement is the part that is allowed, and only in the two specific forms described here.

The `onBeforeCall()` guard sits at the node's outer boundary and decides if the `lmz.call()` should proceed based upon scope information.

Three things decide it: where you are a member (`authScope`), whether you are an admin there (`admin`), and the scope of the node being called. Reach is a comparison among the three, never a property of the token on its own. The scope says where you sit; `admin` is what makes sitting there mean anything. And it is not the data-plane `admin` grant — that is a different thing on a different tree, covered under **The data plane**.

`activeScope` plays no part in this decision, though a reader arriving from its section above would reasonably expect it to. It is chosen by the client, and a value the caller picks can never be a boundary; the mint already confines it inside `authScope`, so it can only ever name somewhere you could already reach. It says which part of the mesh you are looking at, not which part you may touch.

There are exactly two ways in, and both compare the same two things — where you are a member, and where the node sits:

- **The node is your own scope, or an ancestor of it.** Free; no `admin` needed.
- **The node is a descendant of your scope, and `admin` is set.** The only way to reach *downward*.

In one line: your scope and the node must be on the same vertical line, upward is free, and downward needs `admin`.

Getting past the boundary is only that. What you can then do is decided by the `@mesh()` guards on the methods the node exposes, by the checks at the top of those methods, and — for anything touching Resources — by the Data-plane's own grants. So the last column below is what a caller of that shape *usually* ends up able to do. It characterizes the common case; it is not a rule.

Seven example calls, all in the same Universe:

| Case | `authScope` | `admin` | Node called | Usually can |
|---|---|---|---|---|
| **Lateral** | `u.g.s1` | no | `u.g.s2` | **nothing** — lateral movement, refused; the case this layer exists for |
| Ordinary | `u.g.s` | no | `u.g.s` | most of the app's methods, and the Resources their orgTree grants reach |
| Upward | `u.g` | no | `u` | read the organizational-level agentic coding standing guidance |
| Upward, `admin` below the node | `u.g` | **yes** | `u` | the same as the row above — the admin bit sits beneath `u`, so it buys nothing |
| Upward, `admin` at the node | `u` | **yes** | `u` | everything at the Universe, including editing the standing guidance |
| Downward | `u.g` | **yes** | `u.g.s` | everything in that Star, via the bypass |
| Downward, no `admin` | `u.g` | no | `u.g.s` | **nothing** — no method ever runs |

**Lateral** is refused by both rules at once, which is why sideways movement needs no rule of its own: `u.g.s2` is neither an ancestor of `u.g.s1` nor a descendant of it, so there is nothing for either comparison to match. A sibling Galaxy or a whole other Universe fails the same way, less interestingly.

**Ordinary** through **Upward, `admin` at the node** are one rule, not four: the node is your own scope or an ancestor of it. Calling into your own Star, reaching up into its Galaxy, and reaching further up into the Universe are the same comparison against different nodes, and none of them needs `admin`. What the bit changes is what you can do *once inside* — and that turns entirely on where it sits relative to the node it is read in. The two **Upward, `admin`** rows carry the same bit and mean opposite things.

The last two rows are a minimal pair: same member, same node, differing only in the bit. That is the whole of the second rule — descending into your own subtree is the one movement `admin` exists to authorize. The last row is the invited collaborator on one app. They reach into no Star at all, not even the `.dev` one, so testing there is a second membership and a second session.

Neither rule ever crosses to a sibling, and neither crosses between Universes. There are two exceptions. Platform is one: `nebula-platform` is a single reserved scope rather than a place in the hierarchy, so `admin` there means everywhere. The Profile is the other, and it is deliberate — see **Profiles**.

### Why upward exists

So a node can read something the scope above it offers. There is one app definition and many tenant Stars, so anything belonging to the app rather than to a tenant has to be readable from below. Stars once fetched the app's UI code this way; that now goes to the Galaxy directly, since Galaxies are lightly loaded and the responses cache well.

What upward reach is really for is the **guidance hierarchy**. Standing guidance — `AGENTS.md`, skills, rules — lives at three levels, each owned by different people and serving a different purpose: we own the platform layer, a Universe's admins own what holds across that organization's apps, a Galaxy's admins own what holds for one app. Anyone designing an app reads the whole stack upward.

What they may *change* is a separate question, and the answer is where their `admin` sits. A Galaxy member evolves that Galaxy's guidance and nothing above it. A Universe admin who notices — in the retro at the end of a piece of work — that something would help every app in the organization can edit the Universe layer, which is row four. The product improves itself recursively, the same loop we run on this repo.

That getting in buys nothing by itself is the point, not a limitation. A tenant admitted into their Galaxy can call it; every method still runs its own `@mesh()` guard against a caller who is not an admin there. Reaching in starts the conversation. The guard on each method decides whether it continues.

### Why downward is generous for admins

An admin whose scope is at or above a node gets a bypass in that node's Data-plane: full read, write and admin over its whole orgTree, with no grant ever written. That is what makes a Universe admin an admin of every Star beneath them, including ones created later, and it is deliberate — an owner should not have to grant themselves access to their own work.

The bypass is evaluated against the node it is running in, never against the bare `admin` bit, and that distinction has teeth. A guard that once read the bit alone admitted a `u.g.dev` admin — legitimately reaching up into its Galaxy, row three's shape one level down — and then handed them admin over the Galaxy's entire tree. Every admin check is now confined to the node it runs in, which is what keeps reaching up into a node from making you an admin of it.

## Inside the node

Getting past a node's outer boundary means a call will be accepted. Three things still stand between it and any state.

Only methods decorated with `@mesh` are callable over `lmz.call()` at all. Everything else on the node — its storage, its helpers, its private methods — is unreachable from outside, so the node's callable surface is exactly what it chose to publish and nothing more.

A decorated method may also carry a guard, which runs before the method body. Read-only operations usually carry none, because passing the boundary was already enough. Almost anything that changes state carries one — a check that the caller is an admin of this node, say.

A guard is handed only the node instance, never the method's arguments. So any decision that depends on *which* record, or *which* orgTree node, you are touching cannot live in a guard — it has no way to see which one you named. Those checks run at the top of the method instead, and throw an explanatory error that travels back over the `lmz.call()` response, so the caller learns why rather than getting a bare refusal. `PermissionDeniedError` from the data plane is the one you will meet most.

## Identity and membership

Access is anchored to the mailbox. Identity is anchored to the person.

A membership is one address in one scope. It is what a token's `sub` names, and it is what "member" means everywhere in this document. Someone who belongs to three scopes holds three memberships.

A Profile is the person. Name, nickname and picture follow them across every scope, Star and Universe, and one Profile can span several of their addresses — the model allows that today, though the flow for adding a second address is not built yet. A Profile survives its last membership, so work stays attributed to a real person long after they have left.

That split is a deliberate bet against how GitHub does it. There, your account determines access, so email is a contact detail and organization membership outlives your leaving. Removing you takes an admin action, and if nobody takes it, access persists indefinitely. We keep the half worth keeping, which is the portable identity, and reject the half that leaks. Here, deactivating a company mailbox offboards the person automatically. There is no admin action to forget and no revocation feature to remember to build.

Two consequences we accept.

A live session outlives the mailbox by up to the refresh token's lifetime. Losing the mailbox stops new logins immediately, but a session already issued keeps working until its refresh token expires. That is bounded where GitHub's is indefinite, and in practice a company wiping a laptop takes the cookie with it — but that is their capability, not our guarantee.

The same mechanism can lock out an owner. A user-developer who claims a Universe with an employer address and later loses it is locked out of work they own, and none of the rules above bend to help. The answer is a warning at signup: use an address you will keep, and invite the work address afterwards. If it happens anyway and they can establish the work is theirs, a superuser re-invites them. That is a new invitation, not a re-pointing of the old address.

Changing an address is possible and takes proof of both. Proof of the new one, and fresh proof of the old one at the time of the change — a live session is not proof, because sessions outlive mailbox control. That one rule separates every case with no special handling:

| Case | Old address still reachable | Outcome |
|---|---|---|
| Name change | yes — the new one is provisioned while the old still delivers | allowed, memberships preserved |
| Moving providers | yes | allowed |
| Departing employee | no — the company killed it | refused; access dies with the mailbox |

The last row is the point, not a gap.

## The Registry

The Registry is the single source of truth for who exists, what scopes exist, and who is a member where. It is reached over HTTP rather than `lmz.call()`, which is why it sits outside the mesh even though everything in the mesh depends on it.

Scope existence is independent of membership. Creating a Galaxy or a Star writes a scope row and nothing else, so a real, working scope routinely has zero members — the creator's own scope already reaches down to it. Only the claim paths mint an identity, because until one exists nobody holds a token that reaches the new scope.

Everything else it owns has its own section: sessions and their cookies, memberships and the addresses they hang off, and the scope and admin bit that the coarse-grained gate reads out of every token.

## The data plane

The data plane lives in a Star and holds all user-generated data. Access to it is fine-grained, decided against an orgTree — think of an access control list in a file system, right down to the folder structure being a DAG, because file systems have links.

Resources, which store all user-generated data except Profiles and some internal data, are always attached to a node in that orgTree. Permissions are granted on those nodes, in three tiers, each including the one below it:

| Tier | Includes | Adds |
|---|---|---|
| `read` | — | read |
| `write` | `read` | create and modify |
| `admin` | `write` | widening access |

Widening access covers granting permissions to others, and it also covers the structural edits that grant access implicitly. Adding a parent edge, or re-parenting a node, hands everyone above the new parent access to that node's subtree, so both require `admin` on the child rather than just `write`.

Permissions trickle down the orgTree. To alter a Resource's value, or create one, a user needs `write` or `admin` on the node it is attached to, or on any one of that node's ancestors. Because the orgTree is a DAG, a node can have several parents and therefore several ancestor paths. A grant on any one path is enough, and where paths disagree the highest permission wins.

It matters which kind of admin you mean, because the word is doing two jobs. A data-plane `admin` is a grant on an orgTree node. A Registry `admin` is a bit on a membership, carried on the token. They are different things, and the second one reaches into the first: an admin of the scope a data-plane entity lives in gets a bypass over that entity's whole orgTree, so a Galaxy admin can read, write and administer inside that Galaxy and every Star beneath it without ever being granted a node.

The bypass is evaluated against the node it is running in, never against the bare admin bit, so it reaches down and never up. A Star's own admin does not depend on it — founding a Star writes a real `admin` grant on that Star's root node.

## Profiles

**It is best not to think of a Profile as a full mesh node.** It participates in the mesh and uses its code and conventions, but its coarse-grained access control is intentionally different: it is the one place where lateral movement is the *point*. The same person works in several applications in one Universe; coaches and contract workers are invited into different organizations entirely. Some will want a distinct persona in each, but most do not want to re-type their name and upload their picture again for every one. So a Profile is reachable sideways, by design, and the rules above do not apply to it.

A Profile holds two categories of data, public and private, and nothing in between. There is no orgTree inside a Profile and no acl structure of its own.

Public data includes name, nickname, and picture. It is open to every Nebula client. Reading it takes an authenticated connection and the `profileId`, and nothing else — no scope, no membership, no reach, and no relationship between reader and subject is consulted, and the read touches no Registry data. The connection is authenticated once, when the Gateway accepts it and verifies the JWT. Nothing re-checks it per read.

A Profile is not a web resource. There is no HTTPS endpoint for one — no route and no `fetch()` handler — so it cannot be curled, crawled, or linked to from outside. The only way in is a mesh call on an already-authenticated connection.

The `profileId` being random and unguessable stops enumeration, not access. Anyone who obtains an id, by whatever means, can read that profile's public fields. There will never be more gating than that. If a user doesn't want their real name or picture reachable that way, they are free to obfuscate themselves.

Private data can be read and written only by the owner of the profile, a superuser, or a Registry admin over a scope where that person holds an **accepted** membership.

Accepted is load-bearing, not bookkeeping. An invitation creates a membership before the invitee has done anything, so counting unaccepted ones would let anyone claim a Universe, invite an address they guessed, and become an admin over a scope that stranger's profile touches. A membership is only marked accepted by consuming a link delivered to the mailbox, which no attacker can do for someone else's address.

The owner is whoever's `profileId` is on the token, and only when that token carries no impersonation chain. An admin impersonating someone is not that person here. They may still reach the private fields through the admin rule above, as themselves, if they administer a scope where the profile holds an accepted membership.

Access to a Profile is therefore decided by the token, plus Registry data for the admin case. The owner case reads nothing from the Registry, because the token already carries the `profileId`.

## Superuser seed

There is an array of superusers determined by an environment variable that has superuser permission over everything, which is the equivalent of having Registry admin over every Universe — essentially God.

## Impersonation

An admin can act as someone they administer. The token names both people: the top-level `sub` is the person being acted as, and `act.sub` is the admin doing it. The token format allows nesting, but impersonation does not chain — to act as someone else you go back to your original session.

It produces a token but not a session. There is no refresh cookie behind it, which is why ending it means tearing down the client and never calling the logout endpoint — that would spend the cookie of the session that minted it, ending the admin's own.

Two rules, pointing opposite ways:

- Authorization reads the subject and never the actor. Otherwise the admin carries their own power into the user's seat and never sees what that user sees.
- The record names both. A record carrying only the subject names the person acted upon as the person who acted, which is worse than no record because it will be believed.

It is never an escalation. You can only act as someone whose scope you already fully administer, and the token mirrors that person's access rather than your own.

Here is that mirroring, in the same shape as the token in **The access token** above. The admin from that example — `8f3c…`, with profile `1a9d…` — is now acting as one of their tenants:

```jsonc
{
  "sub": "7b2e…",              // the TENANT — authz reads this, always
  "aud": "acme.crm.bigco",     // where the admin chose to act
  "access": {
    "authScope": "acme.crm.bigco"  // the tenant's scope, not the admin's
  },
  "profileId": "4c8a…",        // the TENANT's profile
  "act": {
    "sub": "8f3c…",            // the ADMIN — recorded, never read for authz
    "profileId": "1a9d…"       // display only
  },
  "iss": "…", "exp": 1754400000, "iat": 1754399100, "jti": "…"
}
```

Every identity claim names the tenant. `admin` is gone entirely, because it is the intersection of the two: the admin has it, the tenant does not, so the token does not. The only trace of who is really driving is `act`, and nothing that decides access is allowed to look at it.

One test governs when a check may look at `act` at all: only where impersonation would otherwise grant the actor something they could not already do themselves. Everywhere else it buys nothing, since an admin can already do anything to anyone beneath them. The one case today is profile ownership, which sits outside the scope tree. Such a check may look at whether `act` is present, never at who the actor is.

There is no consent step, deliberately. An admin can already read and write anything in their scope under their own name, so impersonation grants them nothing new. It only changes attribution, and it improves it by naming both parties — gating it would push an admin toward the less traceable path. This changes if a customer requires consent during a security review and the deal is worth it.

### Reading the history

Every action that changes who can do what, or removes state, records the acting token: the subject, the whole actor chain, and the `access` it asserted. Today that goes to the debug log and nowhere durable.

The future is a sink behind that log — one destination collecting those records, and an interface over it that shows each person only what their scope entitles them to see. It is not built and nothing depends on it yet. The records already carry what such a view needs, so the work is the sink and the viewer, not a change to what gets written.

## Grants

**Registry grants** — memberships and the admin bit — are all done inside the Registry.

**Data-plane grants** have to take both into account. Other than a Registry admin arriving through the bypass, they are initiated by endpoints and `@mesh()` methods inside the application, which make whatever Registry calls they need to add the person as a member of a scope. Those may be the same endpoints used directly.

One ordering falls out of that and is worth stating once, because every scenario below obeys it. A data-plane grant names a `sub`, and a `sub` only exists once a membership does. So the Registry step always comes first. You cannot grant a permission to an email address.

### Scenarios

#### Founder of a Star

The trickiest, because a Star — like any Durable Object — has no dedicated create operation on Cloudflare's platform. It comes into being the first time it is accessed.

Anyone can claim an unclaimed Star. There is no invitation and no approval step, only Turnstile. That openness is the product, not an oversight.

The claim is a single unauthenticated call that validates and then writes atomically: the scope row, an admin membership at the full three-segment id, and a magic link. The validation order is deliberate and each step is a different kind of check — the address must be well formed, the id must be three segments, the slug must not be a reserved environment name like `dev`, the parent Galaxy must already exist, and the slug must be free. Parent-exists is an integrity check rather than an admin gate; nobody is authenticated at this point in the flow.

Nothing is granted until the person proves the mailbox. The claim writes the membership unaccepted, and clicking the emailed link is what marks it accepted and logs them in. If that link is lost or expires, re-claiming the same slug from the same address re-sends it. A different address gets a conflict.

The Data-plane grant comes last and comes from the Star itself. The first time an admin whose scope is exactly that Star touches it, the Star writes them an `admin` grant on its root node. An admin from further up reaches everything through the bypass and deliberately does not take that grant by arriving first — otherwise a support visit would leave a durable grant behind that nobody asked for.

#### Adding a Galaxy to your Universe

The one that surprises people: creating a scope mints no identity at all.

A Universe admin creates a Galaxy, and that writes a scope row and nothing else. No membership, no identity, no grant. Nobody needs one, because the creator's own scope already reaches down to it.

So a real, working scope routinely has zero members, and membership is never how existence is determined. The same holds for a Star created by an admin rather than claimed by a founder. Only the claim paths mint an identity, and they have to — until one exists, nobody holds a token that reaches the new scope.

#### Additional root admin of a Star who is not a Registry admin

Two steps, in the order the rule above forces.

First, in the Registry: invite the person into that Star as a plain member. They accept, which is what creates their `sub`.

Then, in the Data-plane: an existing root admin grants `admin` on the root node to that `sub`.

The result is full Data-plane admin in that Star and none at all at the Registry. They can grant and revoke permissions anywhere in the orgTree, and they cannot invite anyone into the scope, create a sibling scope, or delete anything at the Registry level.

#### Member of a Star with write permission over a non-root orgTree node

The same two steps, and only the grant differs: `write` on one node instead of `admin` on the root.

They can read and write that node and everything beneath it, since permissions trickle down. They cannot grant permissions to anyone, which is what `admin` adds. They also cannot re-parent the node, because that would widen access to everyone above the new parent, and widening access needs `admin` on the child.

#### An admin corrects a member's display name

No Data-plane grant is involved, because Profiles have no orgTree.

What the admin needs is Registry admin over a scope where that person holds an accepted membership. Accepted is what makes it safe: an invitation the person never took up confers nothing, so nobody can manufacture admin rights over a stranger's profile by inviting an address they guessed.

Impersonating the person does not help here, because impersonation never makes you the owner. The admin does not need it — they qualify in their own name, and the record names them rather than the person whose profile changed.


## Working notes — delete this section when this doc gets its home

Edits this document has caused elsewhere, to process once its own wording settles. **Only items triggered by "this doc stopped changing" belong here.** Anything a *build* makes true belongs as a phase criterion in the task file doing that build — two owners for one edit means it fires twice or not at all.

- **Sweep "authority" out of ADR-015 and ADR-016.** Judged unclear on 2026-08-06 and removed from this doc; both ADRs still use it as core vocabulary. Each site needs its own rewording rather than a mechanical replace, which is exactly why it waits for the phrasing here to settle. Class (c) per `docs/adr/README.md` — wording, decision unmoved, no supersession needed even for an Accepted one.
- **Pick a home for this document, and decide whether to split it.** `CLAUDE.md` scopes `docs/vision/*.md` to product strategy plus the `/review-task` product lens. The overview fits that; the rest has become a system explainer synthesizing ADR-008, 012, 013, 015 and 016 into one narrative — a job no surface in the repo currently has. Candidate split: overview stays in vision, remainder moves to an internal `docs/` home. Whatever it gets, it needs a discovery path — an unindexed explainer is one nobody loads.
