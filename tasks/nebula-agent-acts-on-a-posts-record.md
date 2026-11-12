# The agent acts under the claims recorded on a post

**Status:** Pass 1 hand-reviewed and through Stage 1 on 2026-11-12; phases written the same day, for Stage 2. It comes before the wipe and before [nebula-testing-with-personas.md](nebula-testing-with-personas.md), whose `provision` tool should be written against it.

## Conventions

A list that other sections cite gives each item a prefixed ID: `B` for a blocker in today's code, `DI` for an item of design intent, `C` for a checkable claim, `Q` for an open question and `D` for a decision. IDs follow the order items were raised, not the order shown, and are never reused, so D3 is the third decision made wherever its row sits, and a gap is an item removed or answered.

## Objective

**When Studio's agent acts for a person, it runs under the claims recorded on the post they wrote, read from the Galaxy's own storage. The Galaxy keeps no call of theirs open, and asks nobody for a token.**

Jennifer posts *"add a recently-bought list"* in the chat of `acme.crm`. The post's snapshot is stored with the claims her call carried: her `sub`, her `access` on `acme.crm`, and the `aud` of the page she posted from. A turn that takes the post up runs its tools under those claims, with `agent:lumenize` added as actor. If the Galaxy is evicted, the post and its record are still in storage and the post is still unanswered, so whatever turn next takes it up runs under the same record.

```ts
// On the post's snapshot, stamped by the server (ADR-016). Ids shortened.
recordedClaims: { sub: '7c1e…', profileId: 'b0d4…',
                  access: { authScope: 'acme.crm' }, aud: 'acme.crm' }

// What each tool call in the turn runs under: the same, with the agent as actor.
{ sub: '7c1e…', profileId: 'b0d4…', access: { authScope: 'acme.crm' }, aud: 'acme.crm',
  act: { sub: 'agent:lumenize', profileId: 'agent:lumenize' } }

// The Galaxy's one call site. It names the post and the snapshot its turn read.
// The plane reads that row and calls lmz.actFor with the record.
this.#resources.actUnderClaimsOf(postId, '2026-11-12T15:04:05.123Z', 'agent:lumenize',
  () => entries.write_file(path, content))
```

## Context

The agent posts as itself and acts for people. A tool call runs as *Jennifer + agent*, so a commit, a tenant Star's record and an invite's record each name both, and each check reads Jennifer's permission. The build that shipped this on 2026-11-11 took Jennifer's claims from the call her post arrived in. It kept that call open in memory and stepped back into it for each tool call.

Keeping a person's call open so that it stays in memory is the mistake `durable-objects.md` § *Wall-clock billing* now names. What the choice cost is in today's code:

- **B1. `#held`, a map from post to held call, in the Galaxy's memory.** An eviction empties it, so a post can be waiting with nothing the agent can act under, and the agent can then only ask someone to post again.
- **B2. A second job for `ctx.waitUntil`.** It holds the Galaxy while a turn's model calls and builds run, which stays. It also has to keep every held call alive until its post is answered, across the decisions that follow a turn, which is why each turn was given a hold of its own.
- **B3. `#takenUp`, the posts a running turn has taken up.** An edit to such a post holds nothing, since without that an edit swapped the claims under a running turn. It also starts no turn, and no decision offers such a post: both keep a second turn off a post whose first turn the 14-minute deadline cut off and which is still running.
- **B4. Claims used long after they were issued.** A held call is never checked against its token's `exp`, so a person demoted after posting still acts until their post is answered or the Galaxy is evicted.
- **B5. `lmz.holdCall()` and `lmz.actFor(held, …)` in Mesh,** with a marker that says a chain was already acted for. The marker does not survive a result handler that runs after a call to another node.
- **B6. A decision may pick only a post whose call is held,** and the model is told which those are in a block of its own (`renderHeldBlock`).

The held call also carries something a stored record lacks:

- **B7. The origin the poster's request arrived on.** An agent's invite builds its emailed link from `callContext.originRequest`. Without it the facade falls back to the deployment's own origin, which is right when deployed and has no port on a local stack.

The same claims are already in storage. Every snapshot is stamped by the server with the claims of the write that made it (ADR-016), so a post's record holds what its held call holds, and an eviction does not lose it. This task has the agent act from that record. B1, B2, B5 and B6 then have nothing left to guard, and B3 keeps the reads that hold off a second turn (DI6). Mesh keeps what the link needs with the node's stored address (DI10). B4 is not fixed, and loses its one limit, the eviction (DI9).

The rest of this file says what a turn reads in place of the held call, what that lets us delete, and what we accept by doing it. How a turn's loop is kept running is unchanged (D3).

## Goals

1. **A waiting post is enough to act on.** Today a post is actionable only while the isolate that received it lives (B1, B6).
2. **After an eviction, a later turn can do the work.** Today the agent can only ask someone to say yes, and the work then runs as whoever does (B1). What starts that turn is still the next post, until the wake check lands (DI5).
3. **Acting for a person needs nothing outside the Galaxy.** A turn reads one row of the Galaxy's own storage. It makes no call to the Registry and verifies no token.
4. **Mesh loses `lmz.holdCall()`,** and with it each guard on a handle that can go stale (B3, B5).

## Relationships

- **Reworks** [archive/nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md). Of that file's design intent:
  - **Its DI3, DI6 and DI7 stand:** the agent posts as itself, every turn ends with a message that answers its post, and a turn that ends with posts waiting starts a decision.
  - **Its DI1 stands,** the general tool that grows one named tool at a time.
  - **Its DI2 is replaced by D4 here.** It kept a participant's claims in memory only, and never stored.
  - **Its DI4 and DI5 are replaced by DI1 here.** The agent's judgment among held claims goes (D7), and what DI5 said of a tenant Star's data is now true of every tool.
  - **Among its decisions,** D4 here reverses its D8 and D30, D7 its D1, and D11 its D25, and D5 widens its D26.
- **Gates** [nebula-testing-with-personas.md](nebula-testing-with-personas.md): `provision` is a loop tool, and it should be written once, against DI3. That file's rows that describe a held call, and its superseded row rejecting a replay of stored claims, are reworded in the first phase (D6).
- **Changes** [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*, whose turn can run the work where today it can only ask. Its goal line, its *Until then* line and its pointer at `#takenUp` are reworded in the first phase (D6). The wake check itself stays there.
- **Supersedes** in `.claude/rules/security.md`: the bullet on the wider bound of the agent's work and the `lmz.actFor(held, …)` half of the two forms that write `originAuth`, each of which describes a held call, and the bullet on a turn's source writes, which D15 reverses. `.claude/rules/durable-objects.md` § *Wall-clock billing* says the fix is to mint the person's claims again, which D4 replaced.
- **Re-derives** `tasks/backlog.md`'s row *Mesh has no public seam for running in-DO code under a call context*, whose stated reason is that a loop tool runs only inside a held call.
- **Renames** the `/live` scenario `held-post-answered`, which `.claude/rules/live-scenarios.md` cites by name.

## Current state

Built already, with what becomes of each part:

- **`recordedClaims` on every snapshot,** stamped by the server from the verified claims of the write: it becomes the source of a turn's claims. The column holds the full record: `sub`, the `act` chain, `profileId`, `access` and `aud`. Every read hands out only `sub`, `act` and `profileId`, through the allow-list in `Snapshots`' one read helper, and that stays as it is for clients.
- **`lmz.actFor` in Mesh:** adapted. Today `actFor(held, 'agent:lumenize', fn)` runs `fn` under the claims of a held call, with the agent added as the outermost `act`. It will take a stored record where it takes the handle, and do the same. It stays one of the two forms that may write `originAuth`. The claims it builds have the shape an impersonation token's have, a person as `sub` and whoever is driving as `act`, and every check reads the two the same way. They differ in how they come to exist:
  - **Impersonation is an admin's choice.** `AuthFacade.impersonate(sub)` requires dominion over the subject, and the Registry signs a token that a browser tab then holds for 15 minutes.
  - **The agent acting is the person's own request.** It needs no dominion, nothing is signed, and the claims last one chain of calls on the server. The agent can sit on top of an impersonated chain, where an impersonator cannot impersonate again.
- **The agent as a local principal** (`lmz.asLocalPrincipal`, `NEBULA_SUB`, its protected `write` on `chat`): carried over unchanged.
- **`waitingPosts` in `apps/nebula/src/participants.ts`,** the one function that decides whether a post is answered: carried over unchanged. It becomes the only thing that says a post can be acted on.
- **A tool call's record,** `post` and `claims` on each `codegen.toolCalls` entry, and Studio's marks: carried over unchanged.
- **The single-flight latch `#turnInFlight`:** carried over. It is in memory by design, and an eviction clearing it is correct.
- **`lmz.holdCall`, `HeldCall`, `#held`, `holdPost`, `heldCallFor`, `renderHeldBlock`:** left behind (B1, B2, B5, B6). So is the `'rechained'` context kind, which only `holdCall` reads, and the `postId` argument of `read_file`, `write_file`, `edit_file` and `build` (D7). The `'local-principal'` kind stays, since `buildOutgoingCallContext` reads it to start a fresh chain.
- **`#takenUp`:** carried over, with the reads that keep a second turn off a post (B3, DI6). Only what it did for a held call goes.
- **The dev-studio lane's `holdPost` probe:** left behind. A lane test that needs a post to act on writes one through a client's call. Whether `as-caller.ts` keeps a use is settled at close-out, and with it `tasks/backlog.md`'s row *Mesh has no public seam for running in-DO code under a call context*.
- **`ctx.waitUntil` around a turn, one hold for each turn, `#underDeadline` and `generationDeadlineMs`:** carried over unchanged (D3). Whether one hold for a whole run of turns would do is unmeasured, and is not this task's.
- **The Registry, the auth facade and `mintImpersonationToken`:** untouched. No turn reaches them to get claims.

Missing:

1. `actUnderClaimsOf(resourceId, validFrom, principal, fn)` on the Resources plane (D12). It runs a function under the full record of one stored snapshot. The Galaxy names a post and never passes a person's `access` or `aud` as an argument; the function sees them as its call's context.
2. `lmz.actFor` taking a record.
3. Mesh's stored stamp for a node, today its binding name and instance name under a key each, merged into one record that also holds the origin the node's own pages are served on (DI10).

## Design intent

- **DI1. Every tool call in a turn runs under the claims recorded on the post the turn took up.** Each call reads the record from storage, as stored: the poster's `sub`, `profileId`, `access` and `aud`. The agent is added as the outermost `act`. If an admin was impersonating Jennifer when the post was written, the admin stays in the chain beneath the agent, so the record of a tool call names all three. The model chooses which waiting post a turn takes up, and from there the Galaxy chooses the record: no tool takes a post as an argument (D7). So the post a turn answers, the claims its work ran under and the records that work leaves all name the same person. Austen's turn runs under Austen's record, and a tenant Star refuses it as it does today.
- **DI3. The Galaxy acts for a person only on claims the server recorded from that person's own verified call.** This is a rule for the Galaxy's code, whether the model or a fixed step starts the work: the agent's loop today, the wake check and `provision` next.
  - **The Galaxy names a snapshot and never claims.** It passes the post's id and the `validFrom` of the snapshot the turn read, and the Resources plane reads that snapshot's record and hands it to Mesh. The model picks a post and never claims (DI1).
  - **`provision` uses it for its check at the chat floor and its one ADR-016 record,** and then hands the procedure to the dev Star on a chain the Galaxy starts, which carries no person's claims.
  - **`lmz.actFor` takes a plain record,** where today it takes a handle no node can build, so the rule is kept by the Galaxy having one call site, which goes through the plane. It keeps the refusals the handle gave for free: a record whose `sub` is not shaped like a person's id, as the agent's own `agent:lumenize` is not, and a record whose outermost `act` is already the principal.
- **DI5. After an eviction a waiting post is acted on by a later turn that takes it up,** under the same record. Until the wake check lands (fast-follow Item 15), nothing starts a turn after an eviction. The next person's post starts one, and the decision after it can take up the stranded post under that post's own record.
- **DI6. Every waiting post that no running turn has taken up can be taken up.** A decision picks among the posts `waitingPosts` returns, less any a turn still running took up, and the model is told of no held set. `#takenUp` stays for that, kept in memory as it is today, and an edit to a post in it still starts no turn. Together they stop a second turn on a post whose first turn the deadline cut off and which is still running. Both go when fast-follow Item 15 decides how a failed turn recovers.
- **DI7. A tool call names the snapshot of the post that its turn read, and fails if the post has moved on.** The snapshot is named by the post's id and its `validFrom`, as a Resources write names the version it was working from (ADR-005).
  - **The check is one comparison with the current `validFrom`,** so no past snapshot is read. A turn that read the post at `…15:04:05.123Z` fails once the post's current snapshot is `…15:09:41.870Z`, before anything runs. A deleted post fails the same way.
  - **It runs once more as the turn's closing message is committed,** so an edit after the last tool call is caught too.
  - **Either way the turn ends with a message that answers no post,** and the Galaxy sees to that whatever the model names. The edited post is waiting again with its new words, the edit itself starts nothing while the turn runs, and the decision after the turn can take the post up. So a turn never acts for a person on words they did not write, and never marks them answered.
- **DI9. The claims are the poster's as of the moment they posted, and stay usable until the post is answered.** A few things can change in between, and they differ:
  - **A grant in an orgTree is still read live.** Each node's check looks up the grant by `sub` when the call arrives. Take away Jennifer's `write` on the Galaxy's `chat` node and the agent's next `write_file` for her is refused, since each source tool makes the check a direct call to that entry would meet (D15). A call to a tenant Star is refused there the same way (C6). The refusal reaches the model as that call's tool error, with the message a person's own refused call carries, and the agent decides what to do next: say so in the chat, or ask someone who holds the grant.
  - **Passage and dominion are read from the record.** They come from `access` and `aud`. A person who lost their admin bit, or their membership, after posting still has both for the work their post asked for. An eviction no longer ends that, and no token's lifetime does.

  We accept this. They held the permission when they posted, every call is recorded as theirs with the agent as actor, and what the call does can be undone. If a customer's security review ever challenges it, the first step is a post in the chat when a participant's membership changes, which the agent weighs when it decides whether to act (§ *Beyond this task*).
- **DI10. A node's stored address holds the origin its own pages are served on, beside its binding name and instance name.** Mesh already reads both names on every call, from a key each, to check the call was addressed to this node. They become one record under one key, `__lmz_do_address`, which is one read where there were two:

  ```ts
  { bindingName: 'GALAXY', instanceName: 'acme.crm',
    origin: 'http://crm.acme.lumenize.localhost:5174' }
  ```

  - **Mesh fills the origin when one of the node's own Clients connects.** A page on the Galaxy's host opens its socket on the Galaxy, and the origin of that upgrade is the value the Gateway already stamps on the Client's calls as `originRequest.origin`. So the stored origin is never a caller's from another host. It is written when an upgrade is accepted, and rewritten only when the scheme or the port differs from the stored one: once in production, and again on a local stack when a tab connects on its other port. A `.dev` Star also hosts its personas' pages, on `manny--dev.crm.acme…`, and those share its scheme and port, so they rewrite nothing.
  - **`lmz.actFor` reads it from the record** and puts it in the call's context as `originRequest.origin`, where the facade already reads it. A node no Client has connected to has none, and the facade's fallback stands. The Galaxy passes nothing, and the facade is untouched.
  - **An unscoped node keeps to its rule:** it hosts no Clients, so it has no origin, and it holds its names in memory and persists them only where it does today.
  - **It lands before the wipe,** so no stored stamp needs migrating.

Claims this rests on. C6, C7, C8 and C12 were checked against the code on 2026-11-12, by the reads each names; C3 is checked by the scenario it names, in Phase 5.

- **C6. Every orgTree check a tool call meets reads the grant from the node's own storage,** keyed by `sub`, and reads `access` and `aud` only for the dominion bypass. Checked in `OrgTree.requirePermission`: `hasDominionOver(claims, hostName)`, then `resolvePermission` by `sub`.
- **C7. Nothing a tool call reaches reads a claim the record lacks.** `AuthClaims` has `iss`, `exp`, `iat` and `jti` beyond what `toRecordedClaims` keeps. Checked by a grep for a read of any of the four off a call's claims under `packages/mesh/src`, `packages/resources/src` and `apps/nebula/src`: only the `ClientGateway` reads `exp`, for its own socket.
- **C8. Every post a turn can take up carries a person's recorded claims, `access` and `aud` among them.** Checked in `Snapshots`: every write records `toRecordedClaims` of its call's claims. A post arrives in a client's call with verified claims, and the agent's own posts carry the agent's record and are never waiting. The record is the claims and nothing else of the call's context: it has no `originRequest` (B7) and no `callChain`, which starts empty under `actFor` today as well.
- **C12. Every reader of the two stored names goes through `createLmzApiForDO`.** Checked by a grep for `__lmz_do_binding_name` and `__lmz_do_instance_name`: beyond `lmz-api.ts`, only `packages/mesh/test/identity-stamp.test.ts` and `packages/mesh/test/test-worker-and-dos.ts` name them, and both move with the change.
- **C3. An agent's invite link names a host and port this stack answers on.** Deployed, the facade's fallback already builds the right link, so only a local stack's port is at stake. The witness is the limb of `apps/nebula/harness/scenarios/agent-invites.ts` that checks the link's host is this stack's own, which passes today and has to pass after (DI10).

## Constraints

- **ADR-016 forbids what DI1 does, and is amended to admit it (D9).** It says a stored `access` or `aud` is never read back to decide anything, and calls that a stored scope set, which ADR-013 rejects. The sentence is worded for a record read on some later, unrelated call. Here the record is the request itself, and the call acted on is the one it asked for. ADR-016 gains that one exception and stops calling it a stored scope set, so ADR-013's text stays as it is. Writing the sentence is the first phase, and Larry approves it before any code is written (D6).
- **ADR-016's other half is unchanged:** each action a tool takes is recorded with the person and the agent both.
- **ADR-025:** the agent stays a local principal with no membership. `security.md`'s rule that only `lmz.actFor` and `lmz.asLocalPrincipal` write `originAuth` stands, with `actFor`'s source changed from a held call to a stored record.
- **`durable-objects.md` § *Wall-clock billing*:** no person's claims are kept by keeping the Galaxy awake. The turn's own hold only saves a restart.
- **No ADR is ratified by this task.** Every rule, ADR, vision doc and sibling task file that describes the held call, or restates that a stored `access` is never read back, is reworded in the first phase (D6). Those edits are Larry's to review. This finds the files that describe the held call, and today it names rules, an ADR and sibling task files:

  ```sh
  grep -rlE 'holdCall|HeldCall|held (call|claims|post)|#takenUp|renderHeldBlock' .claude docs tasks/*.md
  ```

## Beyond this task

- ⚠️ Design consideration: a live check can be added later without changing a caller. Every tool call enters through `actUnderClaimsOf`, so a chat post about a changed membership, or a read of the membership before a call that changes who can do what, lands in that one place.
- ⚠️ Design consideration: what the agent does with a refusal is left to what pre-alpha shows (Larry, 2026-11-12). It gets the refusal's message as a tool error. Whether that message is good enough, and what ways forward the agent needs from there, are fixed as they come up.
- ⚠️ Design consideration: editing a post is to go (Larry, 2026-11-12). A person who wants to change what they asked writes a new post that refers to the first. Studio stops offering the edit first, which is fast-follow § *Item 16: Studio replies to a message, and never edits one*. Refusing it on the server comes later, since it needs a `create` level in the orgTree that allows a new post without allowing a change to an old one. Until then a direct call can still edit a post, which DI7 covers. Nothing here should come to depend on a post's words staying fixed.
- ⚠️ Design consideration: an ontology could ship a function that rewrites a value before it is stored, run in the facet that runs validation (Larry, 2026-11-12). It would be handed the call's context whole, since a user-developer writes it for their own app. A migration is a rewrite of the same kind, so the migrations work, fast-follow § *Item 4: The prod ontology install path*, is where its signature is settled. It was considered here for an invite link's origin and set aside (D14).
- ⚠️ Design consideration: a turn whose rounds are stored could resume where an eviction stopped it. `tasks/backlog.md` § *Other Nebula backlog* has the row, with what the Agents SDK's fibers do. Nothing here should make the model's transcript depend on memory in a new way.
- ⚠️ Design consideration: `actUnderClaimsOf` serves any node's local principal. A Star's agent, or a scheduled job acting for the person who set it up, would act from the record of the snapshot that asked for the work.
- ⚠️ Design consideration: the structured yes that the archived file's D2 defers to the first call that discloses tenant data is unchanged, and still waits for that call.

## Open questions

None.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D2 | The agent may act for a person on the strength of a post they wrote, with no session of theirs open (Larry, 2026-11-12). The post is their request, on the record as theirs. | **A live person for every act**, the archived file's D8: after an eviction the agent can only ask someone to say yes, and the yes runs as whoever gives it. |
| D4 | A turn's tools run under the claims recorded on its post, read from the Galaxy's storage (Larry, 2026-11-12, at the hand review). | **A token the Registry mints each turn**: it reads the membership live, so a demotion is noticed by the next turn. It costs a new mint for local principals, a Mesh form that verifies a signature, a Registry read per turn, and a second when a 14-minute turn outlasts a 15-minute token. That mint also writes a flat actor, so an impersonating admin drops out of the chain. **Keep the held call**: it needs B1 to B6. **Tools under the agent's own claims**: the agent would need grants in tenant Stars, and Austen's request would run on the agent's authority. |
| D7 | Every tool call in a turn runs under its turn's post, and no tool names another (Larry, 2026-11-12, at the hand review). This drops the free choice among posts that the archived file's D1 gave a source tool. | **A post argument on the source tools**, today's code: a source write is not checked against the poster's grant, so the argument changes only whose name a commit carries, and it needs its own rule for the calls that may not use it. |
| D11 | A tool call names the snapshot it acts under by the post's id and `validFrom`, and fails as a conflict when the post has moved on (Larry, 2026-11-12). The turn then ends without answering the post, which is waiting again with its new words. | **Read the post's current record, whatever it is**: after an edit the turn would act for the editor on a request the turn never read. **Stay on the snapshot first read**: it reads a past snapshot, which no read path does today, and acts on words their writer has replaced. |
| D12 | The plane's entry is `actUnderClaimsOf(resourceId, validFrom, principal, fn)`, and Mesh's form keeps the name `lmz.actFor`, taking a record (Larry, 2026-11-12; was Q7). | **`actForSubOf`**: the function runs under the whole record, `sub`, the existing `act` chain, `access` and `aud`, and the name would say only `sub`. **`actForAuthor`, `actForWriter`**: each reads oddly on a resource's id, and after an edit the author is not who wrote the current snapshot. |
| D5 | A record's passage and dominion stay usable until its post is answered, with no limit from a token's lifetime or an eviction (Larry, 2026-11-12). This widens the archived file's D26, which the eviction bounded. Mitigation waits for a customer to ask. | **A cap on a post's age**, one comparison of the snapshot's moment: an old post would need a second ask, to stop work that is recorded and can be undone. **A live read of the membership per call**: it is D4's rejected mint again. |
| D15 | Each source tool checks the poster's `write` on the `chat` node as it runs, by the same `requireChatWrite` a direct call to that entry meets (Larry, 2026-11-12, after Stage 2). The model receives the refusal as the call's tool error. This reverses `security.md`'s rule of 2026-09-06 that a turn's source writes run on its post's verdict. | **The post's verdict for as long as the post waits**: a collaborator whose `write` was removed would keep driving source writes and builds from every unanswered post, and removing a grant would stop nothing the agent does. |
| D9 | ADR-016 alone is amended (Larry, 2026-11-12; was Q8). Its sentence that a stored `access` or `aud` is never an authz input gains one exception: a node's local principal may act under the claims recorded on a snapshot, for the work that snapshot asks for. | **Amend ADR-013 as well**: its scope-set sentence names a re-point and a scope teardown as the harms, and neither reaches a post's record, since a re-point leaves `sub` alone and a teardown removes the post. **Amend neither, and mark the code as an exception**: every reviewer then meets an ADR that calls shipped code a security bug. |
| D6 | The first phase edits ADR-016 to admit DI1 (D9), and Larry approves the wording before any code phase starts (Larry, 2026-11-12). The same phase drafts, for his review, the rewording of every place that describes the held call or restates that a stored `access` is never read back. They are found, not listed, by the command in § *Constraints*, by the same pattern over source JSDoc, and by reading for each restatement of ADR-016's sentence, `security.md`'s line that a record's readers are for traceability only and `workflow.md`'s index lines among them. | **Reword the ADRs at close-out**: the code would be built against an ADR that calls it a security bug, and a reviewer panel would report it as one. **A list of the files here**: it was stated in three places with three memberships, and each missed some. |
| D3 | The hold on a person's call goes, and the hold on a turn's model calls stays as it is: `ctx.waitUntil` and the 14-minute deadline (Larry, 2026-11-12). Something has to wait for the model, and an executor apart from the Galaxy would be a second Durable Object held awake in place of the first. Starting or resuming an evicted turn is fast-follow Item 15 and a backlog row. | **A callback from Cloudflare**: AI Gateway's background runs are best-effort and unsigned, Workers AI's async queue takes minutes, and neither streams. **An executor Worker or Durable Object behind `lmz.call`**: two more hops and a recovery row, to save about $0.00014 of Galaxy duration a turn. **No hold at all, with a restart from the post**: it brings the wake check and its bounds into this task. |
| D14 | Mesh stores the origin a node's own pages are served on in the same record as its binding name and instance name, which merge under one key, `__lmz_do_address`, and `lmz.actFor` hands an agent's call that origin (Larry, 2026-11-12, after Stage 1). All of it is the node's address. Larry approved the key's name and the whole-origin field the same day. | **A key of the Galaxy's own, checked as each post commits**: a second place that learns where a node lives, and a read per post where Mesh's per-call read already has it. **The origin of whichever call arrives**: it differs between a tenant's page and the Galaxy's own, so writing on a difference would write on most calls. **A scheme and a port as fields of their own**: `lmz.actFor` would have to build a host to go with them, and the node's own origin is already a whole one. **Once per post**: a write on every post, for a value that is the same for the life of a stack. **A function shipped beside the ontology that rewrites a value before it is stored**: a general mechanism on the path that gates personas, for a consumer only a local stack has (§ *Beyond this task*). **The origin on every snapshot**: a host's length on every write in every Star. **A port in the local `LUMENIZE_ORIGIN`**: a local stack answers on more than one port. |

## Phases

Each phase leaves every suite it touches green. A criterion that names a test or a scenario still to be written arrives unverified; a criterion that is a command was run against today's tree on 2026-11-12, and what it printed is beside it.

1. **The ADR admits acting from a stored record, and the vision says how the agent acts.** ADR-016's sentence that what was asserted is never an authz input gains the one exception D9 states, and no longer calls that use a stored scope set. `workflow.md`'s index line for ADR-016 gains a clause. `docs/vision/auth.md` § *When the agent acts* is rewritten in present tense for the stored record, with a *Today's code differs* note that Phase 6 removes, and ADR-025 is brought in line where it speaks of held claims. `durable-objects.md` § *Wall-clock billing* stops saying the fix is to mint the claims again, since that file loads through every later phase. Larry approves the ADR-016 sentence and the `auth.md` section before Phase 2 starts (D6). The other rules that describe the code as built change in Phase 6, when that code has changed.
   - **Success criteria:**
     - Larry has approved the wording, recorded as a dated line in § *Build notes*.
     - `node scripts/check-prose.mjs docs/adr/016-record-the-acting-principal.md docs/vision/auth.md docs/adr/025-fine-grained-access-is-the-orgtree.md` leaves each file no further over budget than it was. Today all three print within budget.
     - `grep -n 'never an authz input' docs/adr/016-record-the-acting-principal.md .claude/rules/workflow.md` shows the exception beside each hit. Today it prints the two bare sentences. This is the one criterion here that fails on an edit that reaches the ADR and misses the index line.
     - `grep -n 'Minting the person' .claude/rules/durable-objects.md` prints nothing. Today it prints the sentence.

2. **A node's stored address is one record, and holds the origin its own pages are served on (DI10).** In `createLmzApiForDO`, the keys `__lmz_do_binding_name` and `__lmz_do_instance_name` become one key, `__lmz_do_address`, holding `{ bindingName, instanceName, origin? }`. The mismatch refusals, first-write-wins, and an unscoped node's rule of holding the stamp in memory all behave as today. `ScopedMeshDO.onRequest` sets the origin through a new `@internal` member of `LmzApi`, only after `ClientGateway` has accepted the upgrade with a 101, from the same `new URL(request.url).origin` that `captureOriginRequest` puts on the Client's calls. The Gateway itself is handed no `lmz` and writes nothing. The record is rewritten only when the scheme or port differs from the stored origin's. The one write site logs a `lmz.mesh.address` debug line, which is how a test counts writes. `website/docs/mesh/gateway.mdx` names the two old keys and is reworded here.
   - **Success criteria,** in `packages/mesh/test/identity-stamp.test.ts` unless another file is named:
     - After a scoped node's first call, its storage holds `__lmz_do_address` with both names, and neither old key. Mutation: keep writing the old keys.
     - A call naming another binding or instance for the same object is refused with today's mismatch message. Mutation: drop the comparison in the merged setter.
     - After a Client connects on `http://crm.acme.lumenize.localhost:5174`, the record's `origin` is that string, and the debug sink has one `lmz.mesh.address` line for it. A second Client on the same origin adds none. Mutation: write on every upgrade.
     - A Client connecting on port `8787` after one on `5174` rewrites the origin, and the sink has a second line. Mutation: write only when no origin is stored.
     - A Client connecting on a persona's host with the same scheme and port rewrites nothing. Mutation: compare whole origins.
     - An upgrade the Gateway refuses, a missing subprotocol for one, leaves the origin unset. Mutation: write before the upgrade is accepted.
     - A call from a Client hosted on another node, whose `originRequest.origin` names that other host, leaves the record unchanged. Mutation: fill the origin from an arriving call's `originRequest`.
     - An unscoped node's call leaves no `__lmz_do_address` row and holds no origin. The existing case asserts absence through a list of keys, so after porting it, the mutation "persist for every node" is run again to see it red. A scoped node's record keeps its origin across `ctx.abort()`.
     - The `/live` scenario `client-routes` still passes: a Client's call to an unscoped id nobody created leaves no row.
     - `grep -rn '__lmz_do_binding_name\|__lmz_do_instance_name' packages/mesh/src packages/mesh/test apps/nebula/src apps/nebula/test website/docs` prints nothing. Today it prints `lmz-api.ts`, `identity-stamp.test.ts`, `test-worker-and-dos.ts` and `gateway.mdx`.
     - The whole `packages/mesh` suite passes with the same `Test Files` count as before the phase.

3. **`lmz.actFor` runs a function under a stored record (DI1, DI3).** `actFor(record, principal, fn)` takes a `RecordedClaims`. It builds the call's context as it does today from a held call: an empty `callChain`, `originAuth` with the record's `sub` and its claims, and the node's principal prepended as the outermost `act` by `prependActor`. It adds `originRequest: { origin }` from the node's address when one is stored; a `MeshWorker` has no address and adds none. It refuses a record whose `sub` is not shaped like a person's id, by the `UUID_SHAPE` test that already refuses a principal shaped like one, and a record whose outermost `act.sub` is already the principal. The form that takes a held call stays beside it until Phase 5 removes it, marked `TEMP → target=the record form alone`, so the Galaxy keeps working between phases.
   - **Success criteria,** in `packages/mesh/test/claims-forms.test.ts`. In each, the record names a person other than the caller of the probe, with different `access`, so a build that re-uses the probe's own call context fails:
     - Inside `actFor(record, 'agent:lumenize', fn)`, `callContext.originAuth.sub`, `access` and `aud` are the record's, and `claims.act` is `{ sub: 'agent:lumenize', profileId: 'agent:lumenize' }`. Mutations: run under the record unchanged; build from the current call context.
     - A record that already has an `act`, an admin impersonating the poster, comes out with the agent outermost and the admin nested beneath it, and a write made on a second node inside the block records all three. Mutation: overwrite `act`.
     - A record whose `access.scopeAdmin` is true passes `requireDominionHere` on a node at its `aud` inside the block, and one without the bit is refused. Mutation: drop `access` when building the claims.
     - With an origin in the node's address, `callContext.originRequest.origin` inside the block is that origin, and a call made inside carries it to the callee. With none stored, `originRequest` is absent. Mutation: never set it.
     - A record whose `sub` is `agent:lumenize` is refused, and so is one whose outermost `act.sub` is the principal. A principal shaped like a UUID is refused as today. Mutation: drop each check in turn.
     - The impersonation mint still refuses a caller inside the block, by its root-identity message (`packages/mesh/test/auth/impersonation-mint.test.ts`).

4. **The Resources plane runs a function under one snapshot's claims (D12, DI7).** `actUnderClaimsOf(resourceId, validFrom, principal, fn)` is a method of the plane a host calls in-process. It is not on the `requests` surface a host's `@mesh()`-decorated `resources` getter returns, so no call from outside the node reaches it. It reads the current snapshot's full record from the `recordedClaims` column, which no other read hands out, and calls `lmz.actFor` with it. When the resource's current `validFrom` is not the one named, or the current snapshot is a tombstone, it throws before `fn` runs. The error is a class of its own in `packages/resources/src/errors.ts`, told apart by `name` as its neighbours are.
   - **Success criteria,** in a new `packages/resources/test/act-under-claims-of.test.ts`, through `packages/resources/test/test-worker.ts`, which composes its own plane and can carry a test-only probe. Each resource is written through a real Client's call, so its record is one the server stamped, and the probe is fired by a different person:
     - Inside the block, `originAuth.sub`, `access` and `aud` are the writer's, while a `read` of the same resource by a Client shows neither `access` nor `aud`. Mutations: build the claims from the wire projection; build from the probe's own call context.
     - A `validFrom` older than the current one throws the new error and `fn` is never called, asserted by a flag `fn` would set. Mutation: skip the comparison.
     - A deleted resource throws the same way. Mutation: accept a tombstone's record.
     - A resource the agent wrote, whose record's `sub` is `agent:lumenize`, throws before `fn` runs.
     - **A grant taken away is refused live (DI9).** The writer holds no admin bit. After the snapshot is written their `write` is removed, and a Resources write made inside the block throws `PermissionDeniedError`. Mutation: skip the orgTree check when a record was acted under.
     - `'actUnderClaimsOf' in plane.requests` is false. A chain over the wire cannot test this, since the fourth argument is a function and no chain carrying one arrives. Mutation: add it to the `requests` surface.
     - `npm run audit:dep-direction` passes, since the plane imports Mesh and never the reverse.

5. **A turn runs under its post's record, and nothing of the held call is left (DI1, DI5, DI6, DI7, D7).** In `apps/nebula/src/galaxy.ts`:
   - **One call site.** A `protected` member of `Galaxy` wraps `this.#resources.actUnderClaimsOf`, and every place that steps into a held call today goes through it: the tools, the claims a tool call's record shows, and a commit's identities. The claims a record shows are read inside the same block its tool runs in.
   - **Which snapshot.** The `validFrom` is `snap.meta.validFrom` of the snapshot whose `content` becomes the turn's request, threaded through `runTriggeredTurn` and `#chatTurn`. The thread is not read again for it. The Galaxy passes only an id `waitingPosts` returned in that same read.
   - **The chat floor.** Inside the block, `read_file`, `write_file`, `edit_file` and `build` each call `requireChatWrite` before they act (D15). A refusal is a tool error like any other, carrying `PermissionDeniedError`'s own message, and the loop goes on.
   - **A conflict.** `runCodegenLoop` gains a stop of its own for the conflict error, keyed on its `name`, where today a tool's throw becomes a tool error and the loop goes on. A read that only logs does not check. As the closing message commits, the Galaxy compares the post's `validFrom` once more. After a conflict at either point the Galaxy drops the post from `replyTo` and from `answers`, whatever the model named.
   - **What goes.** `#held`, `holdPost`, `heldCallFor` and `renderHeldBlock`. The four source tools lose `postId` from their schemas and signatures, and `take_up` keeps its own. Mesh loses `lmz.holdCall`, `HeldCall`, the `'rechained'` kind and the held form of `actFor`, and `claims-forms.test.ts`'s cases for a handle go with them.
   - **What the model is told.** In `codegen-loop.ts`: `TOOL_CONTRACT`'s sentence on held posts, `renderDecisionRequest`'s `held` and `not held` labels, `take_up`'s description and refusal text, and the invite tool's "takes no postId". `studio-guidance.md` says where each kind of guidance lives, and `tasks/nebula-pre-alpha.md` § *Data-bound generation* records a change to the contract's wording.
   - **What stays.** `#takenUp`, with both its reads (DI6).
   - **The lanes.** The baseline lane's turn probe loses `opts.held`, and the dev-studio lane's probe writes its post through a Client's call. The scenario `held-post-answered` becomes `waiting-posts-answered` and the lane test `held-posts.test.ts` becomes `waiting-posts.test.ts`, with every file that cites either.
   - **Success criteria:**
     - **`/live` first.** `waiting-posts-answered` passes: two people post during one turn, and each post's tool calls are recorded under its own poster with the agent as actor. It gates only on what holds whatever the model chooses.
     - **`/live`, an edit under a running turn.** A new limb of `waiting-posts-answered`: after the turn's first tool-call log line, the harness edits Jennifer's post through her Client. It gates that no later tool-call record of that turn acts on the old snapshot, and that no message from that turn lists the post in `answers`. It records, without gating, whether a later decision took the post up. Mutation: act under the current record whatever its `validFrom`. Whether the edit can be timed reliably is unmeasured; if it cannot, the limb is parked in the registry with that reason, and the lane case below stands alone.
     - **`/live`, deployed, after a redeploy.** A new limb behind `HARNESS_REDEPLOY=1`, as `redeploy-strands-no-client` runs: a post waits, the Worker is redeployed, a second person posts. It gates that any turn taking up the earlier post logs `took up` with its recorded writer's claims. It reports "not exercised" when the model never takes it. Mutation: read the claims from a map in memory.
     - `/live` `agent-invites` passes every limb, the link's host among them (C3). Its own mutation for that limb, dropping the origin from the call, still reds it.
     - **After an eviction, a waiting post is worked.** In `apps/nebula/test/test-apps/baseline/waiting-posts.test.ts`: Jennifer posts through a Client while a scripted turn runs, the Galaxy is aborted, and Austen's next post starts a turn whose decision takes up Jennifer's post. Its `write_file` lands, and the commit and the tool call's record name Jennifer with the agent as actor. It is in this lane because the model's pick is scripted and because a local stack's `ctx.abort()` wipes storage, where this lane's keeps it; the test says so. Mutation: read the claims from a map in memory.
     - **An edit under a running turn ends the turn.** In `waiting-posts.test.ts`: between a scripted turn's first and second tool call, Austen edits Jennifer's post through a Client. The second call stops the loop, nothing it would have written exists, and the scripted closing step names the edited post. The committed message answers nothing and the post is in `waitingPosts` again. The next decision takes it up and its tool call is recorded under Austen. Mutations: act under the current record whatever its `validFrom`; pass the model's `answers` through after a conflict.
     - **An edit the tools never see is caught at the close.** In `waiting-posts.test.ts`: an edit during a turn that calls no tool, an edit after the last tool call, and a delete in place of each edit. In each the committed message does not answer the post. Mutation: skip the comparison at the close.
     - **An edit while the decision's model call is pending.** In `waiting-posts.test.ts`: the turn's first tool call conflicts. Mutation: read the thread again for the `validFrom`.
     - **A pick the Galaxy did not offer is refused.** In `waiting-posts.test.ts`: a scripted decision names an answered post, then the agent's own message, then a resource that is no Message. Each logs `refusedPick` and starts no turn. Mutation: pass the model's id straight to the wrapper.
     - **A post whose turn is still running is not offered, and an edit to it starts no turn.** The existing case for a turn the deadline cut off keeps passing, and a new one edits that post while its turn runs. Mutations: drop the filter in `#decisionFor`; drop the check in `#onChatCommitted`.
     - **A source tool is refused once the poster's `write` is gone (D15).** In `waiting-posts.test.ts`: Austen posts, his `write` on the `chat` node is removed, and the turn's `write_file` returns a tool error that carries `PermissionDeniedError`'s message and names the `chat` node. Nothing is written, and the scripted model's next round receives that text. `source-chat-floor.test.ts`'s case that a grant lapsing after the post stops nothing is inverted in the same commit. Mutation: skip the check in-process.
     - **An invite lands under a record whose poster has since lost the admin bit,** and its record names her and the agent (D5). In `waiting-posts.test.ts`. She is demoted through the Registry's own path, and the test proves it took: her next refresh carries no `scopeAdmin`, and her own direct `invite` is refused. Mutation: delete the demotion, and the direct call is no longer refused. This pins what we accept, so the mitigation § *Beyond this task* describes will change this test on purpose.
     - **No tool but `take_up` names a post.** A case in `apps/nebula/test/agent-loop.test.ts` walks every tool's schema and finds a `postId` property on `take_up` alone. Mutation: leave it on `write_file`. And `grep -c 'POST_ID_PROPERTY' apps/nebula/src/codegen-loop.ts` prints `0`; today it prints `5`.
     - **The model is told of no held set.** A case in `agent-loop.test.ts` renders `TOOL_CONTRACT`, every tool's description, the decision request and the closing request, and none matches `/\bheld\b/i`. Mutation: leave the `held` label in `renderDecisionRequest`.
     - **One call site.** `grep -rnE '\.actFor\(' apps/nebula/src packages/resources/src packages/mesh/src` prints one call, in `resources.ts`. Today it prints the calls in `galaxy.ts`.
     - `grep -rnE 'holdCall|HeldCall|heldCallFor|holdPost|renderHeldBlock|rechained' packages/mesh/src packages/mesh/test packages/resources/src apps/nebula/src apps/nebula/test apps/nebula/harness` prints nothing. Today it prints files across Mesh, the Galaxy and their tests.
     - `grep -rln 'held-post' apps/nebula/src apps/nebula/test apps/nebula/harness` prints nothing, so every reference followed the renames. Today it prints the scenario, the lane test and the files that cite them.
     - The `packages/mesh` and `apps/nebula` suites pass with the same `Test Files` counts, less files this phase renames.

6. **Standing guidance and the sibling files describe what was built.** The command in § *Constraints* names the files; each is reworded for the stored record, and the rules among them are Claude's to review and the ADR and vision edits Larry's. Beyond what the command finds: `security.md`'s bullet that a turn's source writes run on its post's verdict, which D15 reverses; its line that a record's readers are for traceability only and its bullet on `asLocalPrincipal`, which names `holdCall`'s refusals; `live-scenarios.md`'s scenario name; every JSDoc the Phase 5 grep's files carried; and `auth.md`'s *Today's code differs* note from Phase 1. Fast-follow Item 15's goal line, *Until then* line and `#takenUp` pointer are reworded, as are the personas file's rows on a held call. The backlog row on a public seam is re-derived or closed.
   - **Success criteria:**
     - Every file the command in § *Constraints* prints has been opened, and either reworded or left because the line is history, with each one left named in § *Build notes*. This is a triage of prose and no tripwire: `tasks/nebula-pre-alpha.md` rightly says what the held call was. Today it prints `security.md`, `studio-guidance.md`, ADR-015 and sibling task files.
     - `grep -rln 'held-post' .claude/rules` prints nothing. Today it prints `live-scenarios.md` and `security.md`.
     - `git diff --name-only <the commit before Phase 2> -- packages apps | xargs grep -nE '\b(DI|[SDQCB])(1[0-9]|[1-9])\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b'` prints no task-file handle. The builder first points it at a line known to hold one, to see it print.
     - `npm run type-check`, `npm run audit:mesh-vocab`, `npm run audit:dep-direction`, `npm run audit:do-http` and `node scripts/check-prose.mjs` on each prose file touched all pass.
     - `npx tsx apps/nebula/harness/drive.ts all` passes, or `all --rerun` after a fix, with any flake reported as one.
     - A deployed pass of `waiting-posts-answered`, with its redeploy limb, and of `agent-invites` on `test-nebula` passes. One Galaxy's stored origin there reads `https://` and its own host. `node scripts/issues.mjs --worker test-nebula --since <its start>` shows no new issue. `test-nebula` is redeployed in place, so an object stamped under the old keys can wake from an alarm with no `__lmz_do_address`: the stale-account sweep runs first, and any issue of that kind is named in § *Build notes*, not counted as new.
     - No changed file holds a NUL or an NBSP, by the byte counts in `workflow.md`.

## Non-goals

- **The wake check.** After an eviction a turn still starts at the next post. Fast-follow § *Item 15: The wake check*.
- **Refusing an edit to a post on the server.** Fast-follow § *Item 16: Studio replies to a message, and never edits one*, and the `create` level it needs.
- **A live check of a poster's membership,** or a chat post when it changes (D5, § *Beyond this task*).
- **A function shipped beside an ontology** (§ *Beyond this task*).
- **Constraining the scheme of a stored origin.** It is stored as the upgrade arrived.
- **A general `lmz.call` tool,** and any tool that reads a tenant Star. The archived file's § *Future state* has both.
- **Renaming `recordedClaims`,** or recording the `callChain` beside it. `auth.md` § *Attribution* is where that starts.
- **A public `lmz` member for a node's origin.** Nothing outside Mesh needs it yet.

## Build notes

Empty until the build.
