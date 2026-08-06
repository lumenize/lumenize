# Authentication and Access Control

## Lumenize Nebula mesh

Nebula is made up of a highly distributed mesh of nodes. Nearly all communication between them goes through `lmz.call()`, an RPC system that sits on top of Cloudflare's Workers RPC as the transport within Cloudflare and WebSockets as the transport to and from the outside world. The auth Registry is the notable exception; it has its own section below. We use Cloudflare's Durable Object instance name feature as the address of each durable node.

### High-level auth overview

We use **defense in depth** and **zero trust** to secure the mesh.

You enter by authenticating, which sets a long-lived refresh cookie. That cookie mints short-lived access tokens in the form of signed JWTs. You then open a connection by presenting one, and its contents ride along with everything you do inside the mesh — through long chains of `lmz.call()`s — and can be a factor in every permission decision below.

From there, calls pass the same layers in the same order, even if some of them are intentionally a no-op. None of them is sufficient on its own:

1. **Cloudflare's addressing.** A call can only arrive at the node it named, and that node's storage is reachable from nowhere else. This is real protection and we get it before any of our own code runs — but it decides *where* a call lands, never *who* may make it.
2. **The name stamp.** A durable node has two addresses: an instance name and a 64-character hex id. The first time a node is addressed we record the binding and instance name it was reached by, and any later mismatch throws. A node cannot change its name, nor be reached through the wrong binding.
3. **`onBeforeCall()`.** The scopes in your JWT say which part of the mesh you are a member of and where you are currently acting. This is where we decide whether that lets you reach into this node at all.
4. **The `@mesh()` allowlist.** Only methods decorated with `@mesh` (TC39 stage 3 decorators) are callable over `lmz.call()`. Everything else on the node is unreachable from outside it.
5. **The guard function.** `@mesh()` can carry a guard that runs before the method. Read-only operations usually have none, because passing the boundary is enough. Almost anything that changes state carries one.
6. **Checks at the top of the method.** A guard is handed only the node instance, never the method's arguments — so any decision that depends on *which* record or *which* orgTree node you are touching cannot live in one. Those checks run just inside the method and throw an explanatory error that travels back over the `lmz.call()` response, so the caller learns why it was denied.
7. **The Data-plane DAG (ReBAC).** The commonest such error is `PermissionDeniedError`, thrown when an operation is attempted on a Resource the caller has no permission for. The data plane keeps its own `admin`, `write`, and `read` grants on an orgTree shaped as a directed acyclic graph, so it can model the real-world messiness of organizations — people on loan to another department, teams reporting into two business units. This is a specific form of the general relationship-based access control (ReBAC) approach.

The sections that follow expand on each.

## Scopes

A scope is the instanceName half of a node's address, and it is what the coarse-grained gate reads. In `https://nebula.lumenize.com/{bindingName}/{u}.{g}.{s}/`, the `{u}.{g}.{s}` would be the scope.

Examples:

- `{universe}.{galaxy}.{star}`, often abbreviated as `{u}.{g}.{s}`. Indicates a Star.
- `{u}.{g}`. Indicates a Galaxy, which contains `{u}.{g}.{s}` and many other Stars.
- `{u}`. Indicates a Universe, which contains `{u}.{g}` and other Galaxies.

Notice how **scopes are hieararchical**. The `this-universe.milky-way.sol` Star is a part of the `this-universe.milky-way` Galaxy, etc. This is important for the **Coarse-grained access control** discussion below.

## `authScope` (Sessions)

A session has one `authScope`, represented by the refresh cookie set at login. It outlives any particular access token, tab, or client and has a long TTL. Reloading the page reuses it, and logging in at a different scope starts another one without removing the current one so more than one can be active at any given time, each with a different `Path` and expiration.

The refresh cookie is `HttpOnly` so no script can read it, `Secure` so it only travels over HTTPS, and `SameSite=Strict` so it is never sent cross-site. Its `Path` is `/auth/{authScope}`.

Browsers decide which cookies to send by starts-with-style matching the request path against that `Path`, one whole segment at a time. So a cookie at `/auth/{u}` is sent to `/auth/{u}` and to anything deeper, like `/auth/{u}/refresh-token`, but not to `/auth/{u}.{g}/`, because `{u}.{g}` is a different URL segment rather than a deeper path. Sessions at different scopes are therefore fully separate.

## `activeScope`

An access token is a signed JWT. It has one `activeScope` — where you are acting right now, carried as the `aud` claim.

The client asks for it. Each time it refreshes, it names the scope it wants to act in, and the server checks that against the session's own record rather than against anything the client sent. So you may ask for any scope your session reaches into, and for no other (more on in a later section).

One session can mint access tokens at different active scopes over its life. That is what a user-developer moving around their own Universe is doing: authenticated at `{u}`, acting at `{u}.{g}` while editing an app, then at `{u}.{g}.{s}` while looking at one of its tenants. The two differing is the ordinary case, not an unusual one.

`activeScope` should also agree with what the URL says you are looking at. Today it can drift, which breaks sharing a link — the recipient lands on the right page pointed at the wrong scope. [ADR-017](../adr/017-the-url-is-the-view-state.md) is the not-fully-implemented commitment that closes that.

The contrast, at a glance:

| | `authScope` | `activeScope` |
|---|---|---|
| Belongs to | the session | each access token |
| What it is | where you authenticated | where you are acting right now |
| Where it lives | the refresh cookie's path, and the JWT's `access` claim | the JWT `aud` |
| Who sets it | fixed at login | the client asks, on each refresh |

## The access token

An access token carries both scopes: the session's auth scope in its `access` claim, and the active scope as `aud`. That is what lets a guard ask "may this caller act here?" without going back to the Registry.

A whole token, annotated — a Galaxy admin who is currently looking at one of their tenants:

```jsonc
{
  "sub": "8f3c…",              // the membership: one address in one scope
  "aud": "acme.crm.bigco",     // activeScope — where I am acting
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

Some decisions need nothing but the token. Whether you reach into a node comes from `access` and `aud`, which is why a guard can answer it without leaving the node. Others need the token *and* a lookup — whether you may write someone's private profile fields depends on the `profileId` here plus an accepted membership that only the Registry knows about.

## Coarse-grained access control

> Today the JWT carries a wildcard pattern derived from the scope (`{u}.{g}.*`) instead of the scope itself, and a non-admin reaches downward. [nebula-reach-from-scope.md](../../tasks/nebula-reach-from-scope.md) replaces that with what is described here.

The `onBeforeCall()` guard sits at the node's outer boundary and decides if the `lmz.call()` should proceed based upon scope information.

Two things on the token decide it: `authScope`, where you are a member, and `admin`. The scope says where you sit in the hierarchy; `admin` is what makes that position mean anything. It is not the data-plane `admin` grant, though — that is a different thing on a different tree, covered under **The data plane**.

A call reaches into a node in one of two ways:

- **Downward.** If `admin` is set, the token reaches into its own scope and everything beneath it, including scopes that do not exist yet, and has admin authority at each. A Universe admin is an admin of every Galaxy and Star in that Universe.
- **Upward.** A token always reaches into its own ancestors, so a Star member reaches into the Galaxy and Universe above it. It gets no authority there. This is what lets a tenant read something their Galaxy offers them.

Without `admin` a token reaches into its own scope and nothing beneath it.

Reaching past that outer boundary is only that. What you can do inside is a separate question, answered by the `@mesh()` guards on the methods that node exposes and, for anything touching Resources, by the fine-grained access control of the Data-plane.

### Reaching upward

Upward exists so a Star can read something the app above it offers. There is one app definition and many tenant Stars, so anything that belongs to the app rather than to a tenant has to be readable from below. Nothing exercises this yet — the mechanism is in place and waiting for its first consumer.

Two things bound it, and neither depends on who you are.

A token reaching up gets no authority there. A tenant admitted into their Galaxy can call it, and every method they call still runs its own `@mesh()` guard against a caller who is not an admin of that Galaxy. Reaching in is what lets the conversation start; the guard on each method is what decides whether it continues.

And an admin of a child is nobody at the parent. Being admin of `{u}.{g}.dev` says nothing about `{u}.{g}`, because authority is always the admin bit *and* a scope at or above the node being touched — and `.dev` sits beneath the Galaxy, not above it.

### Reaching downward

Downward is where the convention is deliberately generous. An admin whose scope is at or above a node gets a bypass in that node's Data-plane: full read, write and admin over its whole orgTree, with no grant ever written. That is what makes a Universe admin an admin of every Star beneath them, including ones created later.

The bypass is evaluated against the node it is running in, never against the bare admin bit, and that distinction has teeth. A guard that once read the bit alone admitted a `{u}.{g}.dev` admin — legitimately reaching up into its Galaxy — and then handed them admin over the Galaxy's entire tree. Every admin check is now confined to the node it runs in, which is what keeps upward admission from becoming upward authority.

Neither rule ever crosses to a sibling, and neither crosses between Universes. The scope is the bound in both directions, so `admin` alone is never authority — always `admin` and a scope at-or-above the thing being touched.

Platform is the exception. `nebula-platform` is a single reserved scope rather than a place in the hierarchy, so `admin` there means everywhere.

Three identities in the same Universe:

| Scope | `admin` | Reaches | Can do there |
|---|---|---|---|
| `{u}` | yes | the Universe and every Galaxy and Star beneath, including ones that do not exist yet | everything, via the bypass |
| `{u}.{g}` | no | that Galaxy, and upward with no authority | nothing without a Data-plane grant |
| `{u}.{g}.{s}` | yes | that Star, and upward with no authority | everything in that Star |

The middle row is the invited collaborator on one app. They reach into no Star at all, not even the `.dev` one — testing there is a second session.

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

A Profile holds two categories of data, public and private, and nothing in between. There is no orgTree inside a Profile and no acl structure of its own.

Public data includes name, nickname, and picture. It is open to every Nebula client. Reading it takes an authenticated connection and the `profileId`, and nothing else — no scope, no membership, no reach, and no relationship between reader and subject is consulted, and the read touches no Registry data. The connection is authenticated once, when the Gateway accepts it and verifies the JWT. Nothing re-checks it per read.

A Profile is not a web resource. There is no HTTPS endpoint for one — no route and no `fetch()` handler — so it cannot be curled, crawled, or linked to from outside. The only way in is a mesh call on an already-authenticated connection.

The `profileId` being random and unguessable stops enumeration, not access. Anyone who obtains an id, by whatever means, can read that profile's public fields. There will never be more gating than that. If a user doesn't want their real name or picture reachable that way, they are free to obfuscate themselves.

Private data can be read and written only by the owner of the profile, a superuser, or a Registry admin over a scope where that person holds an **accepted** membership.

Accepted is load-bearing, not bookkeeping. An invitation creates a membership before the invitee has done anything, so counting unaccepted ones would let anyone claim a Universe, invite an address they guessed, and become an admin over a scope that stranger's profile touches. A membership is only marked accepted by consuming a link delivered to the mailbox, which no attacker can do for someone else's address.

The owner is whoever's `profileId` is on the token, and only when that token carries no impersonation chain. An admin impersonating someone is not that person here. They may still reach the private fields through the admin rule above, under their own authority, if they administer a scope where the profile holds an accepted membership.

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

One test governs when a check may look at `act` at all: only where impersonation would otherwise grant the actor something their own authority does not already include. Everywhere else it buys nothing, since an admin already has authority over everyone beneath them. The one case today is profile ownership, which sits outside the scope tree. Such a check may look at whether `act` is present, never at who the actor is.

There is no consent step, deliberately. An admin can already read and write anything in their scope under their own name, so impersonation grants them nothing new. It only changes attribution, and it improves it by naming both parties — gating it would push an admin toward the less traceable path. This changes if a customer requires consent during a security review and the deal is worth it.

### Reading the history

Every action that moves authority or removes state records the acting token: the subject, the whole actor chain, and the authority asserted. Today that goes to the debug log and nowhere durable.

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

The result is full Data-plane authority in that Star and no Registry authority whatsoever. They can grant and revoke permissions anywhere in the orgTree, and they cannot invite anyone into the scope, create a sibling scope, or delete anything at the Registry level.

#### Member of a Star with write permission over a non-root orgTree node

The same two steps, and only the grant differs: `write` on one node instead of `admin` on the root.

They can read and write that node and everything beneath it, since permissions trickle down. They cannot grant permissions to anyone, which is what `admin` adds. They also cannot re-parent the node, because that would widen access to everyone above the new parent, and widening access needs `admin` on the child.

#### An admin corrects a member's display name

No Data-plane grant is involved, because Profiles have no orgTree.

What the admin needs is Registry admin over a scope where that person holds an accepted membership. Accepted is what makes it safe: an invitation the person never took up confers nothing, so nobody can manufacture authority over a stranger's profile by inviting an address they guessed.

Impersonating the person does not help here, because impersonation never makes you the owner. The admin does not need it — they qualify in their own name, and the record names them rather than the person whose profile changed.

