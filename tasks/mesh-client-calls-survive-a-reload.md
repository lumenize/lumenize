# A Client's calls survive a reload

**Status:** Pass 1, drafted 2026-10-12 for Larry's read; phases not written. Mesh gains a durable outbox for a Client's calls, and Resources' writes are its first consumer. It answers [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md)'s open question about a write in flight, and builds before [nebula-page-knows-its-build.md](nebula-page-knows-its-build.md), which reloads pages far more often.

## Objective

**A call a Client makes durable is stored in its tab before it is sent, sent in order to each node it calls, and kept until that node answers; its result handler then runs on whichever load of the page is alive. A reload loses neither the call nor what was meant to follow it.**

| Moment | Today | After |
|---|---|---|
| Jennifer's build lands while Austen's preview holds a write not yet answered | The reload drops it | The reloaded preview shows it, sends it, and runs its handler when it lands |
| Austen saves an order and the page means to open it once saved, but a reload comes between | The save may land; the page never opens it | The save lands, and the reloaded page opens the order |
| A page offline for a minute is reloaded by its person | The writes held while offline are dropped | They are sent, in order |
| The Star refuses Austen's write because her page's ontology version is old | Lost with the reload that follows | Sent again at the new version: saved if it fits the new types, shown rejected if not |
| A page writes a `Pipeline`, then a `Deal`, during a version change | Either can land first | They land in the order made |

## Context

**A Client is a node of the mesh, and nodes talk the way actors do: by one-way messages, each owning its own state** ([ADR-003](../docs/adr/003-continuation-messaging.md); `docs/vision/auth.md` calls a Client a full peer node). Erlang, the language most associated with actors, keeps a message from one process to another in order behind every earlier one between that pair, but does not promise it arrives, and a mailbox lives in memory and dies with its process. Reliability is left to the application, through acknowledgements, retries and operations safe to repeat. Akka's reliable delivery packages that work as a durable outbox: the sender stores each message before sending it, records its confirmation, and on restart sends again whatever was never confirmed ([`EventSourcedProducerQueue`](https://doc.akka.io/api/akka-core/current/akka/persistence/typed/delivery/EventSourcedProducerQueue$.html)).

**Mesh already carries most of that.** A Client's address, `alice.9f2c41aa` on its host node, survives a reload, because its tab id is kept in `sessionStorage`. Its host node delivers an answer to whatever socket that address is on now, and holds it for up to 5 s while the address has none. A result handler is a continuation, data naming a method on the Client, not a closure. Two things stop a reload from carrying a call across. The Client keeps its outgoing calls in memory, so one not yet sent dies with the page. And each page load mints a `loadId`, and a Client drops an answer stamped with another, so a new page never runs a handler meant for the old one.

**[nebula-page-knows-its-build.md](nebula-page-knows-its-build.md) is why now.** It reloads every collaborator's preview on every build that lands, so a write Austen is typing when Jennifer's build lands would be lost routinely. Deleting the Client's version gate (`1e2e3da`) also let a page's writes to different resources land out of order during a version change.

**The outbox belongs in Mesh, because durability is a property of a node's outgoing mail rather than of data.** A chat post, a node invite and an org-tree change are lost on a reload the same way a write is. And only in Mesh is a result handler stored as data, so what a page meant to do after a call survives with it. Resources keeps what only it knows: the ontology version a write was built at, and the `newETag` that makes a write safe to send twice ([ADR-005](../docs/adr/005-optimistic-concurrency-etags.md)).

The rest of this file says what the outbox must guarantee, what exists to build it from, and the questions it leaves for Larry.

## Goals

1. **A durable call survives a reload.** Today the Client's `#messageQueue` lives in memory, so a reload drops every call not yet sent, and Resources' write queue drops every write it holds.
2. **Its result handler runs when the answer comes, on whichever load is alive.** Today the reloaded page drops an answer meant for the load before it, and a `callAsync` Promise dies with its page.
3. **A Client's calls to one node land in the order made.** Today Resources orders writes to one resource only, and since the gate went, a version change can reorder writes to two.
4. **What the person typed stays on screen, and a write made against older types still gets its chance.** Today the reloaded page shows only what the Star holds, and a write the Star refused for an old ontology version is gone.

## Relationships

- **Gated by nothing open.**
- **Gates [nebula-page-knows-its-build.md](nebula-page-knows-its-build.md),** whose open question about a pending write this answers.
- **Answers ADR-024 § *Deliberately open*'s write in flight.** The last phase rewrites that bullet into the decision.
- **Extends what ADR-003 says a Client's continuation survives** from a reconnect to a reload.
- **Hands [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 4: The prod ontology install path* the published step:** a stored write made at an older version is migrated forward, as stored data is, before a Star with real users sees it.

## Current state

Built already, each with its fate. In Mesh:

- **The tab id** (`tab-id.ts`'s `getOrCreateTabId`), kept in `sessionStorage` and checked over a `BroadcastChannel` against a duplicated tab. *Carried over:* it is why a reloaded page has the same address.
- **The Client's `#messageQueue`** (`mesh-client.ts`), which holds calls made while no socket is open and sends them on connect. *Adapted:* it becomes the outbox, stored in the tab, for calls made durable.
- **The `loadId` rule** (`mesh-client.ts`'s `#loadId`): an answer stamped with another load's id is dropped. *Adapted:* the answer to a durable call is matched by its `callId` in the outbox instead, so the reloaded page runs it.
- **The host node's grace period** (`client-gateway.ts`'s `receiveFireBack`, 5 s in production): an answer for an address with no socket waits that long for one. *Carried over;* whether 5 s covers a real reload is a claim to measure.
- **Continuations** (`ctn()`): a result handler is a chain naming a method, serialized for the wire. *Carried over:* it is what a durable call stores.
- **`callAsync`** (`#pendingAsyncCalls`), whose Promise survives a freeze and a reconnect but not a reload. *Unchanged,* and never durable.

In Resources:

- **The write queue** (`frontend/debounce.ts`). It coalesces writes to one resource (a 500 ms quiet window, 2 s at most), keeps one transaction in flight per resource, and holds writes while disconnected. *Adapted:* what it submits goes out as a durable call, and coalescing still happens before a write is sent.
- **`newETag` replay** (`snapshots.ts` Steps 4.5a and 6.5), which answers a transaction as committed when a resource currently carries its `newETag`. *Adapted:* both checks read only the current snapshot, so once someone else has written the resource, a resend of a write that landed reads as stale; the check widens to the resource's history.
- **The outcome engine** (`conflict-outcome.ts`). It hears a transaction's answer through `callAsync` today and, when the answer is lost, rolls the write back and reports `timeout`. *Adapted:* a durable call's handler feeds it, and nothing rolls back for a lost answer.
- **The store adapter's `applyOptimistic`,** which paints an unsaved value with the eTag it was written against. *Carried over:* the reloaded page paints what the outbox holds through it.
- **Each op's own retry while the Star asks what is current** (`client-resources.ts`'s `#versioned`). *Carried over.*
- **ADR-024's line that sending a write again after a reload is not enough.** *Left behind,* answered below.

## Design intent

- **A call is durable when its caller makes it so, and only an `lmz.call` with a result handler can be.** The handler is a continuation stored with the call, so it runs on whichever load of the page is alive when the answer comes. A `callAsync` Promise dies with its page, so `callAsync` stays a page's own convenience.
- **A durable call is stored in the tab before it is sent,** with its target, its chain, its handler and its place in order.
- **A Client sends one durable call at a time to each node, and the next to that node only once it has answered the last.** That is Larry's one-at-a-time rule, kept per target the way Erlang keeps order per pair, so a slow call to the Galaxy never holds up a write to the Star. Every data write goes to the Star, so a page's writes land in the order made.
- **An answer reaches whichever load is alive.** The reloaded page reconnects at the same address, its host node delivers the answer it held, and the Client matches a durable call's answer by its `callId` rather than dropping it for an old `loadId`.
- **A call whose answer was lost is sent again only if its callee is safe to repeat.** Otherwise its handler hears that the outcome is unknown. No node keeps a ledger of calls it has seen ([ADR-005](../docs/adr/005-optimistic-concurrency-etags.md)); where a call says it is safe to repeat is § *Open questions*.
- **Resources' writes are durable calls.** A write is stored once it leaves the quiet window, and a conflict's resolution goes in as a new write at the end, so a conflict on one resource never stalls the others.
- **A resend of a write that landed is recognized as committed, even after someone else wrote the resource.** The replay check looks for the `newETag` anywhere in the resource's history, which [ADR-004](../docs/adr/004-snodgrass-temporal-resources.md) keeps. Without that, Austen's write that landed just before her reload, followed by Jennifer's edit, would come back as a conflict, or as "already exists" for a create.
- **A write built at an older ontology version is sent at the page's current one.** Resources rewrites its version before resending, and the Star checks it against the types it runs: a write that still fits is saved, and one that no longer fits ends `rejected`, rolled back in the store as any invalid write is.
- **Code after an `await` runs only while its page lives.** A navigation or a second write the old page meant to make after the first landed dies with it. So writes that must land together go in one transaction ([ADR-006](../docs/adr/006-resources-reference-by-id.md)), and work that must follow an outcome goes in a durable call's handler or a handler the page registers. The guidance Studio's model reads says so, beside the API it describes.

## Constraints

- [ADR-003](../docs/adr/003-continuation-messaging.md): no reply Promise is held across a reload; what follows a call travels as its continuation.
- [ADR-005](../docs/adr/005-optimistic-concurrency-etags.md): a callee's own contract is the one guard against doing a call twice; nothing adds a dedupe ledger.
- [ADR-007](../docs/adr/007-shared-node-security-core.md): `lmz.call` is one core every node type shares, so "durable" means one thing wherever it is accepted.
- [ADR-002](../docs/adr/002-structured-clone-everywhere.md): a stored call keeps the full structured-clone value space.
- [ADR-024](../docs/adr/024-two-versions-keep-an-app-in-step.md): a page sends only at its own ontology version, and data moves only forward.
- `mesh.md` § *Package dependency direction*: Mesh never imports Resources, so the version rewrite is a hook Resources supplies.
- `calibration.md` §1: a tab keeping its own person's unsent calls is not a privacy risk to design around.
- `live.md`: a `/live` scenario reloads a real page with calls outstanding.
- Milestone: pre-alpha, before the build-version task. No stored shape on any server changes, so it rides the deploy.

## Future state

- **A Star with real users migrates a stored write forward before it runs**, with the same user-developer migration code that carries stored data forward (fast-follow Item 4). ⚠️ Design consideration: the Star then needs the version a write was built at as well as the one the page sends at, so the stored call keeps both.
- ⚠️ Design consideration: a Durable Object could keep a durable outbox in its own storage the same way, for a node that must not lose a call across its own eviction.
- ⚠️ Design consideration: a page could warn before its tab closes with calls still in the outbox, since a closed tab is the one loss this leaves.

## Open questions

1. **Where does the outbox live?** It decides what survives, and whether two tabs can send one call twice.
   - **(a) The tab's `sessionStorage`. Recommended.** It survives a reload and is shared with no other tab, so no call is sent from two. A closed tab loses its outbox, and it holds about 5 MB.
   - **(b) IndexedDB.** It survives a closed tab, holds far more, and stores structured-clone values natively. Every tab of an origin shares it, so each call needs an owning tab, and a crashed owner needs a takeover rule.
2. **Where does a call say it is safe to repeat?**
   - **(a) On the callee, as an option on `@mesh()`, checked when a resend arrives. Recommended.** A resend says in its envelope that it is one, and the node's framework runs it only if the method says it may; otherwise it answers that the outcome is unknown. The method's author knows, and one declaration covers every caller.
   - **(b) At the call site,** as an option beside "durable". Simpler, but every caller asserts something about a method it did not write, and two callers can disagree.
3. **What does `await transaction()` resolve with while the outbox holds the write, for as long as its page lives?** Today a lost answer resolves `timeout` and a dropped connection `infrastructure-error`, both `retryable: true`, and the app may resubmit; under the outbox a resubmit is a second write.
   - **(a) It resolves when the write is answered, however long that takes. Recommended.** The two retryable kinds go from `TransactionOutcome`, since the outbox resends both itself. An app that wants a spinner reads the store's unsaved state.
   - **(b) Keep `timeout` as "still trying, do not resubmit".** The await site keeps a bound, at the cost of a kind whose meaning flips, in an API the codegen model has learned.
