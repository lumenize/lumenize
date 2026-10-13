# A page knows which build it runs

**Status:** Pass 1, drafted 2026-10-12; phases not written. Larry answered its two open questions on 2026-10-12 and 2026-10-13. The `.dev` half of [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)'s build version. It absorbs fast-follow Item 8 and builds before personas, whose tab pacing runs on it.

## Objective

**After a build lands, every page on the app's `.dev` hosts moves onto it once: Studio reloads the preview frames it holds, and a page in a browser tab of its own reloads itself when it next comes into view, or at once if the build changed the data types. A reload keeps every write the page had not yet saved.** Each page carries the build version it was served, and that version never decides whether a data-op runs.

After Jennifer changes the Save button's label and the build lands:

| Page | Today | After |
|---|---|---|
| Jennifer's Studio, which asked for the build | Its preview reloads | Its preview reloads |
| Austen's Studio, open on the same app | Keeps the old label until Austen asks for something | Its preview reloads |
| `mary--dev.crm.acme.lumenize.dev`, a persona's host in a tab of its own | Keeps the old label until someone reloads it by hand | Moves onto the new build when Austen next switches to it |

If Jennifer's build also changes the data types, Austen's preview reloads at once, and today a value she has typed but not yet saved is lost with it. After this task the reloaded preview still shows it, then saves it, or shows it rejected if it no longer fits the new types.

## Context

**ADR-024 gave every page two versions, and only one of them works yet.** The ontology version works end to end: a build that changes the types reaches every page that holds a subscription, because the Star's install tells each of them ([nebula-star-ontology.md](archive/nebula-star-ontology.md)). The build version exists only as a digest the build job reports. So a build that changes only code reaches whoever asked for it, and a collaborator watching the same app, or a persona's page in another tab, keeps running code that no longer exists. The ADR's *Today's code differs* says exactly that.

**Personas is why now.** It puts several pages of one app on screen at once, a tab per persona in Studio and each persona also on its own host, and it paces their reloads after a build: the tab in view at once, each other loaded tab the next time it comes into view ([nebula-testing-with-personas.md](nebula-testing-with-personas.md) § *Decisions*). That pacing needs a signal that reaches every Studio on the app and names the build that landed. Fast-follow Item 8 already planned the first half, the fan-out to every Studio; this task takes it over.

**A reload drops whatever the page has not saved.** Resources keeps an unsaved write in memory until the Star answers it, so the reload an ontology change already causes loses a value typed just before it, and the reloads this task adds would lose more. A durable outbox for every call a Client makes was drafted to fix this, and set aside for a smaller fix inside Resources (§ *Decisions*).

The rest of this file says what each page needs, what exists, and the contract the phases build against.

## Goals

1. **Every Studio on an app hears every build that lands.** Today `announceBuildToRequester` tells only the client whose build it was, so Austen's preview keeps the old code until her own next request.
2. **The signal names the build.** Today Studio's `handlePreviewReady(scope)` carries only a scope, so nothing can tell a frame loaded before a build from one loaded after it, which is the difference personas' pacing turns on.
3. **A page in a tab of its own moves onto a newer build, once.** Today nothing reaches it: it reloads when its ontology version changes, or by hand.
4. **A reload keeps what the page had not saved.** Today Resources holds an unsaved write only in memory, and its write queue forgets one the Star refused for an old ontology version while leaving the value on screen, so a reload drops both.

## Relationships

- **Gated by nothing open.** ADR-024 is committed, and [nebula-star-ontology.md](archive/nebula-star-ontology.md) is built.
- **Gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md).** Its strip reloads frames on the push Goal 2 names.
- **Absorbs [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 8: Tell the OTHER collaborators a new build landed*.** Its roster and its two warnings carry over, into § *Current state* and § *Design intent*.
- **Sits beside [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md).** Neither gates the other, and whichever clears review first builds first.
- **Hands the published half to fast-follow Items 4 and 5,** as a paragraph in each.
- **Answers ADR-024 § *Deliberately open*'s write in flight.** A late phase rewrites that bullet into the decision.
- **Leaves a durable outbox in Mesh on hold.** Its findings went into [on-hold/mesh-call-durable.md](on-hold/mesh-call-durable.md) § *Findings from the reload detour*, which lands before Mesh 1.0 ([mesh-1-alpha.md](mesh-1-alpha.md) § *Item 11: Durable calls*).

## Current state

Built already, each with its fate:

- **The digest a build reports.** The job hashes `dist/index.html` into `bundle.indexSha256`, and `Galaxy.#distArrived` checks the arrived file against it before a build lands. *Carried over:* it is the build version, and the `index.html` the Galaxy serves after a landing hashes to it.
- **The `nebula-scope` meta.** The Galaxy's serve path writes `dev`, `parentOrigin` and `ontologyVersion` into every HTML page it serves, and `createNebulaClient` reads it. *Adapted:* it gains the build version.
- **The requester's push.** `announceBuildToRequester` hands the requester's address to `deliverPreviewReady`, a one-way call to `StudioClient.handlePreviewReady(scope)` whose `onErrorOnly` handler logs a lost delivery. Studio's `onPreviewReady` then reloads the preview frame (`App.vue`'s `reloadPreview`) by pointing it at the Star's root with a `?t=` cache-buster, so the frame loses the path it was on. *Adapted,* as § *Design intent* says.
- **The roster.** `Resources.streamProgress` already sends to the chat query's subscribers who may read the chat node, one entry per open tab, and Studio subscribes to that query whenever it opens an app (`openChatThread`). *Carried over* as the list of who has the app open, as Larry settled for Item 8 on 2026-08-28. Item 8 asks that the time to drop a closed tab be measured before relying on it: about 5 s by design, perhaps 30 s from a bug.
- **The ontology version's reload guard.** `decideStale` and the `lmz.ontology-reloaded-for` key in `sessionStorage` reload a tab once per ontology version, through the app's `onShouldRefreshUI`. *Unchanged,* and the model for the build's guard.
- **The write queue** (`frontend/debounce.ts`). It holds each unsaved write in memory: values waiting out the 500 ms quiet window, writes held while disconnected, and the one transaction in flight per resource, which it sends again under its same `newETag` after a reconnect. A write the Star refuses for an old ontology version is finished as far as the queue is concerned (`conflict-outcome.ts` calls `api.fail()`), though its value stays on screen. *Adapted:* it hands over what it holds, refused writes included, so a reload can carry them.
- **`newETag` replay** (`snapshots.ts` Steps 4.5a and 6.5). A transaction is answered committed when a resource it names already carries its `newETag`. *Carried over:* it is why a write in flight at the reload can be sent again.
- **The platform docs' line that a reload drops held writes** (`website/docs/nebula/api-reference.md` § *`TransactionOutcome`*, which Studio's model reads), closing its paragraph on how a disconnect holds writes. *Left behind:* it comes to say a reload carries them, and a crash still loses them.
- **`announceBuildToRequester`'s JSDoc,** which argues a fan-out would need a registry someone has to enrol in, maintain and reap. *Left behind:* the chat query's subscribers are that registry, and nobody enrols in it.

## Design intent

- **A page's build version is the digest of the `index.html` it was served, and the Galaxy writes it into that page.** It goes in the `nebula-scope` meta beside `ontologyVersion`, computed from the file the Galaxy is about to serve rather than stored, so it names exactly what the page received, even while a build's output is still arriving.
- **A landing tells every Studio on the app, and names the build.** The push that reaches the requester today goes to every subscriber of the chat query who may read the chat node, through the same targets `streamProgress` uses. Studio reloads its preview frame on it, and personas later paces its strip by it. A Studio is on the list because it shows the chat, so none can forget to join.
- **Studio decides when the frames it holds reload.** A page Studio frames leaves its reloads to Studio, so pacing has one home.
- **Studio reloads a frame by asking it to reload itself.** Studio cannot read a frame's address across origins, so setting the address, as `reloadPreview` does, sends the frame to the Star's root and loses its view ([ADR-017](../docs/adr/017-the-url-is-the-view-state.md)). Asked, the frame reloads itself and keeps its view. Studio sets the address only when the frame does not answer, as one the build broke may not.
- **A page in a tab of its own checks its build at the moments it could have missed one.** When it comes back into view, and when its connection comes back, it asks its own host which build it would serve now, and moves if that differs. A data-op refused for an old ontology version moves it too, by the reload that refusal already causes, because a new ontology version lands only with a new build.
- **It moves once per build version.** The reload goes through the app's `onShouldRefreshUI` with a reason naming the build, so an app can show a banner instead, behind a guard that records in `sessionStorage` the build version it reloaded for, as the ontology reload's does.
- **The build version never rides a data-op.** The Star never sees it, so a code-only build refuses nobody's write and the Star installs nothing for it (ADR-024).
- **An ontology change still reaches every subscribed page at once,** through the Star's install notice, because a page on the old types cannot run a data-op on the new ones. Only a build that changes code alone waits for Studio's pacing or the page's own move.
- **A reload carries the writes the page had not saved.** On `pagehide`, which fires for every reload whichever code or person started it, Resources writes each unsaved write to `sessionStorage` under the page's Client address, `alice.9f2c41aa`: its kind and value, the eTag it was written against, and for one already sent, its `newETag`. A transaction of several resources is kept as one. The write is synchronous, so it lands before the page goes. A duplicated tab gets a copy of `sessionStorage` but a fresh address, so it never reads another tab's writes.
- **The next load sends them again through the ordinary write path.** Once the store is bound and the socket is up, Resources reads the entry and deletes it, then paints and queues each write, which goes at the new page's ontology version. The Star checks it against the types it runs: a write that still fits is saved, and one that no longer fits ends `rejected` and is rolled back, as any invalid write is.
- **A write that was in flight goes again under its same `newETag`.** If it landed, the replay check answers it committed. If someone else wrote that resource in between, it comes back as a conflict, which the conflict path resolves like any other.

## Constraints

- [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md): two versions compared by equality, a reload once per build, and the build version never decides whether an op runs.
- [ADR-017](../docs/adr/017-the-url-is-the-view-state.md): a reload lands on the same view, because the view rides the URL.
- [ADR-005](../docs/adr/005-optimistic-concurrency-etags.md): the `newETag` replay is the one guard against a carried write landing twice; nothing adds a ledger.
- A reload keeps the page's browsing context. `sessionStorage` belongs to the tab or frame, so Studio reloads a frame and never replaces it with a new one. Personas' strip inherits this.
- `calibration.md` §1: a tab keeping its own person's unsaved writes is not a privacy risk to design around.
- [ADR-003](../docs/adr/003-continuation-messaging.md) and `mesh.md`: the push stays a one-way call whose handler hears only a failed delivery.
- `live.md`: a `/live` scenario first. The change is to what Clients hear, so the close-out runs a deployed pass of the scenarios it writes or touches.
- `studio-guidance.md`: `preview` stays the build tool's word, and nothing in the model's tool path changes.
- Milestone: pre-alpha, before personas. It changes no stored shape, so it rides the deploy.

## Future state

- **The published half.** A published Star's pages carry the build version the same way, from the copy a publish promotes, and fast-follow Item 5 keeps a publish free of any reload push, so a published page moves only by its own check. ⚠️ Design consideration: a check that reaches the Galaxy grows with end users' activity on one Durable Object per app, so it wants a cache in front before alpha has users.
- **Personas' strip** paces its frames on the build the push names: the frame in view reloads at once, each other loaded frame when it next comes into view, and a frame loaded after the landing is already current. ⚠️ Design consideration: a framed page could tell Studio its build version over the channel it already posts its auth state on, so Studio never reloads a frame that is already current.
- **An environment Star that follows the build as `.dev` does** (ADR-024 leaves it open) gets the build version for free, since the Galaxy writes it on every serve.
- ⚠️ Design consideration: a Star with real users will migrate a carried write forward before it runs, as it does stored data (fast-follow Item 4), so the carry records the ontology version each write was made at.
- ⚠️ Design consideration: a crash fires no `pagehide`, so what a crashed page held is lost. [on-hold/mesh-call-durable.md](on-hold/mesh-call-durable.md) keeps the design that stores a call before sending it.

## Open questions

None open. Both are answered in § *Decisions*.

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **A page in a tab of its own checks its build when it comes back into view and when its connection comes back, and an ontology reload moves it too** (Larry, 2026-10-12). A persona's tab is usually out of view while the person asks Studio for the build, so it moves the moment they switch to it, the pacing personas wants for Studio's own tabs. The check is lazy, so the published half can share it with no reload push, as fast-follow Item 5 requires. A tab in view during a build keeps the old code until it is next hidden and shown, which test data tolerates. | **The landing telling the `.dev` Star, which tells every Client it hosts:** a tab in view would move at once, but Mesh would need a way for a node to reach every Client it hosts, which today only `ClientGateway.closeAll` does, and the published half would need a second mechanism. **Both:** two mechanisms to build and test for one property. |
| **A reload carries the page's unsaved writes across in `sessionStorage`, written at `pagehide` and sent again by the next load** (Larry, 2026-10-13). The reloads at issue are ones our own code causes, on `.dev` Stars, whose data is test data, and a write the Star refused for an old ontology version never landed. So a carry inside Resources covers the problem with no change to Mesh, to what `await transaction()` resolves with, or to an ADR beyond answering ADR-024's open bullet. | **A durable outbox in Mesh for every call a Client makes** (drafted 2026-10-12): each step, from a queue of data-ops to an outbox in Mesh to one for Durable Objects as well, followed from a cause outside this problem, and the result left six questions open and about a week of work. Its findings are kept in [on-hold/mesh-call-durable.md](on-hold/mesh-call-durable.md). **Waiting until no write is pending, then reloading:** the queue has already finished with a write refused for an old ontology version, so the reload would still drop it. **Widening the replay check to the resource's history,** so a resent write that landed never reads as a conflict: it still misses the same person's second write within the coalesce window, which overwrites the first in place, and the case it covers is rare on test data. |
