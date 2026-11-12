# The agent acts under the claims recorded on a post

**Status:** Built on 2026-11-12, on `pre-alpha`, through its six phases, verified and handed off; § *Build notes* has each phase's record and § *Close of the build* the final tree's results. It came before the wipe and before `nebula-testing-with-personas.md`, whose `provision` tool is written against it.

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

- **Reworks** [archive/nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md). Of that file's design intent:
  - **Its DI3, DI6 and DI7 stand:** the agent posts as itself, every turn ends with a message that answers its post, and a turn that ends with posts waiting starts a decision.
  - **Its DI1 stands,** the general tool that grows one named tool at a time.
  - **Its DI2 is replaced by D4 here.** It kept a participant's claims in memory only, and never stored.
  - **Its DI4 and DI5 are replaced by DI1 here.** The agent's judgment among held claims goes (D7), and what DI5 said of a tenant Star's data is now true of every tool.
  - **Among its decisions,** D4 here reverses its D8 and D30, D7 its D1, and D11 its D25, and D5 widens its D26.
- **Gates** [nebula-testing-with-personas.md](../nebula-testing-with-personas.md): `provision` is a loop tool, and it should be written once, against DI3. That file's rows that describe a held call, and its superseded row rejecting a replay of stored claims, are reworded in the first phase (D6).
- **Changes** [nebula-pre-alpha-fast-follow.md](../nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*, whose turn can run the work where today it can only ask. Its goal line, its *Until then* line and its pointer at `#takenUp` are reworded in the first phase (D6). The wake check itself stays there.
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
  - **`lmz.actFor` takes a plain record,** where today it takes a handle no node can build, so the rule is kept by the Galaxy having one call site, which goes through the plane. It keeps the refusal the handle gave for free: a record whose `sub` is not shaped like a person's id, as the agent's own `agent:lumenize` is not.
- **DI5. After an eviction a waiting post is acted on by a later turn that takes it up,** under the same record. Until the wake check lands (fast-follow Item 15), nothing starts a turn after an eviction. The next person's post starts one, and the decision after it can take up the stranded post under that post's own record.
- **DI6. Every waiting post that no running turn has taken up can be taken up.** A decision picks among the posts `waitingPosts` returns, less any a turn still running took up, and the model is told of no held set. `#takenUp` stays for that, kept in memory as it is today, and an edit to a post in it still starts no turn. Together they stop a second turn on a post whose first turn the deadline cut off and which is still running. Both go when fast-follow Item 15 decides how a failed turn recovers.
- **DI7. A tool call names the snapshot of the post that its turn read, and fails if the post has moved on.** The snapshot is named by the post's id and its `validFrom`, as a Resources write names the version it was working from (ADR-005).
  - **The check is one comparison with the current `validFrom`,** so no past snapshot is read. A turn that read the post at `…15:04:05.123Z` fails once the post's current snapshot is `…15:09:41.870Z`, before anything runs. A deleted post fails the same way.
  - **It runs once more as the turn's closing message is committed,** so an edit after the last tool call is caught too.
  - **Every post a message names is held to the same comparison (D16).** A decision that answers in a message, and a closing step, each read posts and then wait on the model. A post edited in that wait is not answered by what the model wrote, and waits on.
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

- **ADR-016 said a stored `access` or `aud` is never read back to decide anything, and that sentence is dropped (D9).** The ADR is about recording who did what, and the sentence was about checking. It also called such a read a stored scope set, which is ADR-013's term for something else: the set of scopes a person resolves to. What the ADR keeps is the recording fact, that both fields are as of the write and never updated. ADR-013's text stays as it is. The edit is the first phase, and Larry approves it before any code is written (D6).
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
| D16 | An agent message answers a post only if the post still reads as the model was shown it, for every post the message names, the turn's own or not (Larry, 2026-11-12, after the verifier panel). The comparison runs before the commit and once more after it, since the commit awaits in between. | **Only the post the turn took up**, DI7 as first written: a decision's message or a closing step could mark a post answered on words edited while the model was thinking. |
| D12 | The plane's entry is `actUnderClaimsOf(resourceId, validFrom, principal, fn)`, and Mesh's form keeps the name `lmz.actFor`, taking a record (Larry, 2026-11-12; was Q7). | **`actForSubOf`**: the function runs under the whole record, `sub`, the existing `act` chain, `access` and `aud`, and the name would say only `sub`. **`actForAuthor`, `actForWriter`**: each reads oddly on a resource's id, and after an edit the author is not who wrote the current snapshot. |
| D5 | A record's passage and dominion stay usable until its post is answered, with no limit from a token's lifetime or an eviction (Larry, 2026-11-12). This widens the archived file's D26, which the eviction bounded. Mitigation waits for a customer to ask. | **A cap on a post's age**, one comparison of the snapshot's moment: an old post would need a second ask, to stop work that is recorded and can be undone. **A live read of the membership per call**: it is D4's rejected mint again. |
| D15 | Each source tool checks the poster's `write` on the `chat` node as it runs, by the same `requireChatWrite` a direct call to that entry meets (Larry, 2026-11-12, after Stage 2). The model receives the refusal as the call's tool error. This reverses `security.md`'s rule of 2026-09-06 that a turn's source writes run on its post's verdict. | **The post's verdict for as long as the post waits**: a collaborator whose `write` was removed would keep driving source writes and builds from every unanswered post, and removing a grant would stop nothing the agent does. |
| D9 | ADR-016 loses its sentence that a stored `access` or `aud` is never an authz input, and keeps only that both are as of the write (Larry, 2026-11-12, at Phase 1's approval; was Q8). The ADR records who did what, and the claims are an authz input when they are written and again when the agent acts under them. | **Keep the sentence with one named exception**, this file's first answer: an explicit exception, with "stored scope-set" on both sides of it, in an ADR that is not about checking. **Soften it to a SHOULD NOT**: the ADRs do not use those keywords, and the risk it names is ADR-013's to state. **Amend ADR-013 as well**: its scope-set sentence names a re-point and a scope teardown as the harms, and neither reaches a post's record. |
| D6 | The first phase edits ADR-016 (D9), and Larry approves the wording before any code phase starts (Larry, 2026-11-12). The same phase drafts, for his review, the rewording of every place that describes the held call or restates that a stored `access` is never read back. They are found, not listed, by the command in § *Constraints*, by the same pattern over source JSDoc, and by `grep -rn 'authz input'` for each restatement of the sentence ADR-016 loses: `security.md`'s line that a record's readers are for traceability only, and the JSDoc on `RecordedClaims`, `WireRecordedClaims` and the Registry's refresh record. | **Reword the ADRs at close-out**: the code would be built against an ADR that calls it a security bug, and a reviewer panel would report it as one. **A list of the files here**: it was stated in three places with three memberships, and each missed some. |
| D3 | The hold on a person's call goes, and the hold on a turn's model calls stays as it is: `ctx.waitUntil` and the 14-minute deadline (Larry, 2026-11-12). Something has to wait for the model, and an executor apart from the Galaxy would be a second Durable Object held awake in place of the first. Starting or resuming an evicted turn is fast-follow Item 15 and a backlog row. | **A callback from Cloudflare**: AI Gateway's background runs are best-effort and unsigned, Workers AI's async queue takes minutes, and neither streams. **An executor Worker or Durable Object behind `lmz.call`**: two more hops and a recovery row, to save about $0.00014 of Galaxy duration a turn. **No hold at all, with a restart from the post**: it brings the wake check and its bounds into this task. |
| D14 | Mesh stores the origin a node's own pages are served on in the same record as its binding name and instance name, which merge under one key, `__lmz_do_address`, and `lmz.actFor` hands an agent's call that origin (Larry, 2026-11-12, after Stage 1). All of it is the node's address. Larry approved the key's name and the whole-origin field the same day. | **A key of the Galaxy's own, checked as each post commits**: a second place that learns where a node lives, and a read per post where Mesh's per-call read already has it. **The origin of whichever call arrives**: it differs between a tenant's page and the Galaxy's own, so writing on a difference would write on most calls. **A scheme and a port as fields of their own**: `lmz.actFor` would have to build a host to go with them, and the node's own origin is already a whole one. **Once per post**: a write on every post, for a value that is the same for the life of a stack. **A function shipped beside the ontology that rewrites a value before it is stored**: a general mechanism on the path that gates personas, for a consumer only a local stack has (§ *Beyond this task*). **The origin on every snapshot**: a host's length on every write in every Star. **A port in the local `LUMENIZE_ORIGIN`**: a local stack answers on more than one port. |

## Phases

Each phase leaves every suite it touches green. A criterion that names a test or a scenario still to be written arrives unverified; a criterion that is a command was run against today's tree on 2026-11-12, and what it printed is beside it.

1. **The ADR admits acting from a stored record, and the vision says how the agent acts.** ADR-016's bullet that what was asserted is never an authz input goes, and the bullet above it gains the one recording fact it held: `access` and `aud` are as of the write and never updated (D9). `workflow.md`'s index line for ADR-016 follows. `docs/vision/auth.md` § *When the agent acts* is rewritten in present tense for the stored record, with a *Today's code differs* note that Phase 6 removes, and ADR-025 is brought in line where it speaks of held claims. `durable-objects.md` § *Wall-clock billing* stops saying the fix is to mint the claims again, since that file loads through every later phase. Larry approves the ADR-016 sentence and the `auth.md` section before Phase 2 starts (D6). The other rules that describe the code as built change in Phase 6, when that code has changed.
   - **Success criteria:**
     - Larry has approved the wording, recorded as a dated line in § *Build notes*.
     - `node scripts/check-prose.mjs docs/adr/016-record-the-acting-principal.md docs/vision/auth.md docs/adr/025-fine-grained-access-is-the-orgtree.md` leaves each file no further over budget than it was. Today all three print within budget.
     - `grep -n 'never an authz input' docs/adr/016-record-the-acting-principal.md .claude/rules/workflow.md` prints nothing. Before the phase it printed a line in each, so it fails on an edit that reaches the ADR and misses the index line.
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
     - `grep -rn '__lmz_do_binding_name\|__lmz_do_instance_name' packages/mesh/src packages/mesh/test apps/nebula/src apps/nebula/test website/docs` prints one line, the list of retired keys `identity-stamp.test.ts` asserts are never written. Before the phase it printed `lmz-api.ts`, `test-worker-and-dos.ts` and `gateway.mdx` as well.
     - The whole `packages/mesh` suite passes with the same `Test Files` count as before the phase.

3. **`lmz.actFor` runs a function under a stored record (DI1, DI3).** `actFor(record, principal, fn)` takes a `RecordedClaims`. It builds the call's context as it does today from a held call: an empty `callChain`, `originAuth` with the record's `sub` and its claims, and the node's principal prepended as the outermost `act` by `prependActor`. It adds `originRequest: { origin }` from the node's address when one is stored; a `MeshWorker` has no address and adds none. It refuses a record whose `sub` is not shaped like a person's id, by the `UUID_SHAPE` test that already refuses a principal shaped like one. The form that takes a held call stays beside it until Phase 5 removes it, marked `TEMP → target=the record form alone`, so the Galaxy keeps working between phases.
   - **Success criteria,** in `packages/mesh/test/claims-forms.test.ts`. In each, the record names a person other than the caller of the probe, with different `access`, so a build that re-uses the probe's own call context fails:
     - Inside `actFor(record, 'agent:lumenize', fn)`, `callContext.originAuth.sub`, `access` and `aud` are the record's, and `claims.act` is `{ sub: 'agent:lumenize', profileId: 'agent:lumenize' }`. Mutations: run under the record unchanged; build from the current call context.
     - A record that already has an `act`, an admin impersonating the poster, comes out with the agent outermost and the admin nested beneath it, and a write made on a second node inside the block records all three. Mutation: overwrite `act`.
     - A record whose `access.scopeAdmin` is true passes `requireDominionHere` on a node at its `aud` inside the block, and one without the bit is refused. Mutation: drop `access` when building the claims.
     - With an origin in the node's address, `callContext.originRequest.origin` inside the block is that origin, and a call made inside carries it to the callee. With none stored, `originRequest` is absent. Mutation: never set it.
     - A record whose `sub` is `agent:lumenize` is refused. A principal shaped like a UUID is refused as today. Mutation: drop each check in turn.
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
     - **`/live`, an edit under a running turn.** A scenario of its own, `post-edited-mid-turn`: Austen edits Jennifer's post as soon as it has committed, while its turn waits on the model. It gates that the stopped turn recorded no tool call that ran, that its message answers no post, and, when a later decision takes the edited post up, that the turn ran under Austen. Each limb has a mutation of its own.
     - **`/live`, deployed, after a redeploy: not built.** With the real model a post is answered within a minute, and a redeploy takes several, so no scenario can leave a post waiting across one. § *Build notes* has the detail. The lane case below is the witness.
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
     - A deployed pass of `waiting-posts-answered`, `post-edited-mid-turn` and `agent-invites` on `test-nebula` passes. A deployed Galaxy's stored origin cannot be read from outside it, so its value there is unchecked (§ *Build notes*). `node scripts/issues.mjs --worker test-nebula --since <its start>` shows no new issue. `test-nebula` is redeployed in place, so an object stamped under the old keys can wake from an alarm with no `__lmz_do_address`: the stale-account sweep runs first, and any issue of that kind is named in § *Build notes*, not counted as new.
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

### Phase 1

- **For Larry:** the ADR-016 edit and the reworded paragraphs of `auth.md` (§ *How the claims travel*, § *When the agent acts*) wait for his approval before Phase 2 (D6). Approved by Larry on 2026-11-12, after the ADR-016 change below.
- **Decided at the approval (Larry, 2026-11-12):** no explicit exception in ADR-016. The bullet is dropped and its one recording fact kept (D9). Three JSDoc comments restate the dropped sentence, on `RecordedClaims`, `WireRecordedClaims` and in `auth-registry.ts`; they are reworded with the code they sit on, in Phases 3 to 5, and Phase 6's grep is the check.
- **Changed from the plan:** ADR-025 says nothing of held claims, so it has no edit. ADR-015's one line that does, in its § *Terminology* code block, is reworded here with the rest, since it states the model and is his to approve in the same read.
- **Retro:** `auth.md` said the agent "can do exactly what the person whose claims it uses could and nothing more". Under D5 that is no longer exact, so the paragraph now says which permissions are read when.
- **Close-out:** `durable-objects.md` § *Wall-clock billing* no longer says the fix is a mint.

### Phase 2

- **Built:** one `__lmz_do_address` record in `createLmzApiForDO`, and `__setOrigin` on `LmzApi`, called by `ScopedMeshDO.onRequest` after a 101.
- **Evidence:** `packages/mesh` passes 83 files and 1033 tests, the file count it had. `identity-stamp.test.ts` went from six cases to twelve, and each new assertion reddened alone under its mutation: a retired key written, the name comparison dropped, a write on every upgrade, a write only when none is stored, whole origins compared, the origin set before the accept, the origin filled from an arriving call, and every node persisting. `/live` `client-routes` passed.
- **Changed from the plan:** the retired-key grep prints one line, since the test names the two keys to assert nothing writes them. The criterion says so now.
- **Not mutated:** the case that a reset keeps the origin. It is storage by construction, so no single change keeps the names and loses the origin.
- **Retro:** all twelve passed on first run, which is the signal to distrust, so every one was mutated before the phase closed. A first mesh call now makes one `kv.put` where it made two. A first contact that is a Client's upgrade still makes two, the names and then the origin.

### Phase 3

- **Built:** `lmz.actFor(record, principal, fn)` in `packages/mesh/src/lmz-api.ts`, beside the held form, which is marked TEMP. A node with a stored origin hands it to the chain; a `MeshWorker` hands none.
- **Evidence:** `packages/mesh` passes 83 files and 1040 tests, seven more than Phase 2 left. Each of the seven reddened under its mutation: the record run unchanged, the claims built from the probe's own call, `act` overwritten, `access` dropped, `originRequest` never set, and each of the refusals dropped. `apps/nebula` type-checks against the widened signature.
- **Changed from the plan:** the held form's case for a handle a node built itself now reads the record form's refusal, since an object that is no genuine handle is taken for a record. The JSDoc on `RecordedClaims` said its `access` is never read back as an authz input, which this phase made false, so it is reworded here and not in Phase 6.
- **Not added:** a new case in `impersonation-mint.test.ts`. The record form's claims equal the held form's, field for field, which the first case asserts, and the mint's existing case keys on `act` being there.
- **Retro:** the record's person had to differ from the probe's caller in `sub`, scope and admin bit, or a build that re-used the running call would pass. The mutation that does exactly that reddened three cases.

### Phase 4

- **Built:** `Resources.actUnderClaimsOf` in `packages/resources/src/resources.ts`, `Snapshots.currentRecord` for the full record, and `ResourceMovedOnError` with its guard in `errors.ts`, exported from the package.
- **Evidence:** `packages/resources` passes 4 files and 29 tests, one file and six tests more. Each of the six reddened under its mutation: the claims built from the wire projection, the claims taken from the probe's own call, the `validFrom` comparison skipped, a tombstone accepted, the member added to `requests`, and the orgTree check skipped for a write under a record. `npm run audit:dep-direction` passes.
- **How the fixtures are honest:** each record was stamped by the server from a `NebulaClient` logged in through the Registry. The probe is called on the stub with no call running, so the mutation that reads the running call's claims fails four cases at once.
- **Retro:** the writer in the grant case had to be the universe's second login, a plain member. Its first login is an admin, whose bit bypasses the grant, and the case would have passed for the wrong reason.
- **Close-out:** the JSDoc on `WireRecordedClaims` no longer cites ADR-016 for a sentence the ADR lost in Phase 1.

### Phase 5

- **Built:** the Galaxy's turn, decision and tools run through one `actUnder`, which calls `actUnderClaimsOf`. The loop stops `post-moved` on `ResourceMovedOnError`, and the closing commit compares the post's `validFrom` once more. `#held`, `holdPost`, `heldCallFor`, `renderHeldBlock`, the `postId` tool argument, and Mesh's `holdCall`, `HeldCall` and `'rechained'` kind are gone. The tool-args validator is regenerated under bundle id `v7`.
- **Evidence, suites:** `apps/nebula` passes 129 files and 1162 tests, `packages/mesh` 83 files and 1032, `packages/resources` 4 files and 29.
- **Evidence, mutations in the lane:** each of these reddened the case written for it in `waiting-posts.test.ts`: acting under the current record whatever its `validFrom`, the trigger's check on a taken-up post dropped, `replyTo` kept after a conflict, the comparison at the close skipped, the model's `answers` passed through after a conflict, the decision reading the thread again for the `validFrom`, the model's pick passed unchecked, the decision's filter dropped, a missing post read as unchanged, and a moved post treated as a tool error. Skipping the chat floor in-process reddened `source-chat-floor.test.ts` F5, and a `held` label or a `postId` on `write_file` each reddened its case in `agent-loop.test.ts`.
- **Evidence, `/live`, local:** `post-edited-mid-turn` passed, with the model taking the edited post up, and each of its limbs reddened at its own assertion under its mutation. `waiting-posts-answered`, `closing-step` and `agent-invites` passed. `agent-invites`' link limb names the stack's host and port, which settles C3 locally, and it reddened with the origin left off the chain.
- **For Larry, a design fact found:** demoting an account's last accepted admin at the Registry makes every invite into that account fail with *"its account's founder has not accepted it yet"*, because the Registry reads the admin bit to decide the founder accepted. With a second admin, demoting the founder changes nothing. It is older than this task and no product path demotes anyone yet. Larry left it with a row in `tasks/backlog.md` § *Nebula Auth* (2026-11-12). The invite-after-demotion case uses an invited admin of the app for that reason.
- **For Larry, changed from the plan:**
  - **The deployed redeploy limb is not built.** The phase asked for a post left waiting across a redeploy. With the real model a post is answered in under a minute and a redeploy takes several, so no scenario can arrange it, and timing a post into a rollout is a guess. The lane's abort case is the witness that a waiting post is worked after an eviction.
  - **The edit limb is a scenario of its own,** `post-edited-mid-turn`. It sends the edit as soon as the post commits, since a log line of a running turn arrives deployed only when the turn ends.
  - **A turn's post is required.** `runCodegenTurn` took an optional post and offered no acting tool without one. Both callers always pass one, so the branch is gone.
  - **One operand of the close-time check was deleted, not tested.** A loop stopped `post-moved` always leaves a post whose `validFrom` differs, so the comparison alone decides.
  - **The model no longer hears whose claims carry the admin bit.** The held block said so. It learns from an invite's refusal instead.
- **Retro:**
  - All twenty lane cases passed on first run, and the mutations were the only evidence any could fail.
  - A check that the whole prompt never says *held* was wrong: the platform guidance says a reference is *held by id*. It is scoped to the contract, the tools and the two requests.
  - The dev-studio lane ran its Galaxy with no name and a caller whose `sub` was the word `admin`. A probe now writes a real post, so the stand-in call names a Client, carries a `sub` shaped like a person's, and stamps the node's name.
  - The lane file passed twenty tests on one shared owner address, and the twenty-first failed at the owner's refresh. It is the known limit of about two dozen memberships on one address, so the owner has an address per test now.
- **Close-out:** `as-caller.ts` still has its use, so the backlog row on a public seam stays, with a new reason to write in Phase 6.

### Phase 6

- **Reworded:** `security.md` (the two forms that write `originAuth`, the refusals `actFor` makes, the bound on work the agent does for a person, and the chat floor, which a turn's source tools now meet as they run), `studio-guidance.md` (no held-posts block), `live-scenarios.md` (the scenario's name), fast-follow Item 15, the personas file's superseded row, three backlog rows, one Registry comment that restated the sentence ADR-016 lost, and `auth.md`'s *Today's code differs* note.
- **Triage of the command in § *Constraints*:** it prints this file and four sibling task files. Each remaining line is history and is left: `nebula-pre-alpha.md`'s rows on what the held call was, the personas file's status line and review log, the backlog's row that says the held call went and its pointer at what the archived build landed, and fast-follow's pointer at `#takenUp`, which still exists.
- **Local sweep:** 71 of 73 passed on the first run, with `redeploy-strands-no-client` parked by design. `post-edited-mid-turn` failed its third limb on a 20-second wait for a line the model's answer comes before; the wait now allows a model call, and it passed alone and on the rerun. `refresh-reads-the-host` failed on an email Resend reports delivered and passed on the rerun with nothing changed: **a flake**, reported as one. `all --rerun` then showed 73 of 73 on this tree.
- **Deployed pass:** `test-nebula` was redeployed at the Phase 5 commit and its self-check matched. `post-edited-mid-turn`, `agent-invites` and `waiting-posts-answered` each passed there. In `waiting-posts-answered` the closing step answered Austen's post, so the decision limb reported *not exercised*.
- **Workers Issues since the deploy began (2026-11-12T20:35:45Z):** one, the recurring `scope-deleted` exception first seen 2026-10-13, which a scope's teardown raises by design. Nothing new.
- **For Larry, not verified:**
  - **A deployed Galaxy's stored origin.** Nothing outside a Durable Object can read its storage, and deployed the agent's invite link reads the same from the stored origin as from the facade's fallback, so `agent-invites`' link limb cannot tell them apart there. Locally it can, and did.
  - **A post left waiting across a real redeploy** (Phase 5's note).
- **Retro:** the sweep found what running the new scenario alone did not, a wait sized for a log line where a model call sits in between. Under the sweep's load the model took longer than 20 seconds.
- **Close-out still owed at the hand-off:** the personas file's status line and `nebula-pre-alpha.md`'s row, which both say this task is waiting; the archive move; and the memory note on this design.

### Verifier panel

One reader for each phase, on the tree at the Phase 6 commit. Phases 2, 3 and 4 conformed; 1, 5 and 6 did not. What it found, and what became of each:

- **A real defect, fixed: the close's comparison and the commit were not one step.** The commit validates its value first, which awaits, and an edit landing in that wait left the turn's message answering words nobody had worked. The turn now looks once more after the commit and takes the answer back (`#takeAnswerBack`). A new lane case holds the commit, lands the edit and releases it; with the second look removed it reddens.
- **ADR-016 still cited the sentence Phase 1 dropped,** in its § *Consequences*, hyphenated, so neither grep could see it. The line now says only that the stored fields go stale, which is correct for a record of what was claimed. This is one more sentence of the ADR for Larry to read.
- **`actFor`'s refusal of a record the principal already fronts read `act.sub`,** an identity read of the chain, which `security.md` rules out and had no bucket for. It is deleted, with its test and its sentence in the rule and in DI3. A record the agent wrote for a person is no chat post, so nothing reaches it, and acting on one would only nest the agent twice.
- **A criterion's third case was missing:** a decision naming a resource that is no post. Added, and it reddens when that id is let through.
- **Stale comments the diffs never touched:** `buildNow`'s JSDoc still argued the post's verdict, which would have invited removing the live check, and six test comments still described the held call. All reworded. `isResourceMovedOnError` had no caller and is gone. `mark_complete`'s description no longer says the turn's post is always counted.
- **`post-edited-mid-turn` limb 1 had no positive control.** It now says *not exercised* when the model called no tool, where it would have passed on any tree.
- **For Larry, the Phase 6 commit carries work that is not this build's.** `tasks/nebula-testing-with-personas.md` had uncommitted edits of its own when that commit named the file by path: new conventions, renumbered decisions, a phases section. They are in `91f7114` whole, under a message that mentions only one reworded row. Nothing was lost, and the commit message is wrong about that file.
- **A gap outside DI7's letter, which Larry had fixed (D16):** a post answered without being taken up got no `validFrom` check. A decision that answers in a message, and a closing step, each name posts read before their model call. `#commitAnswering` now holds every post a message names to the snapshot the model was shown, at both commit sites, and replaces `#takeAnswerBack`.
  - Two mutations survived on the first try, and both were right to. With the check before the commit removed, the look after it caught every case, so the first check's own worth is one write where the second costs two; a case now asserts the message was written once. A guard for a post the model was never shown could not be reached, and is deleted.
  - A decision's message and a closing message each have a lane case, and both redden when no post is ever seen as moved.
- **Left as they are:** ADR-019, withdrawn and kept as history, still quotes the dropped clause. `auth.md` § *When the agent acts* says all of a turn's work runs under its post, where a landing's `ServedBuild` is the agent's own write, and it states the structured yes in present tense with no note that it is unbuilt; both predate this build. On a `.dev` Star the stored origin's host can be a persona's, which the JSDoc now says. Deployed, `post-edited-mid-turn` did exercise its third limb, and `waiting-posts-answered` did not exercise its decision limb.
- **After the fixes:** see § *Close of the build* for the suites, the sweep and the deployed pass on the final tree.


### Close of the build

Every number here is from the tree at `be63ff1`, the commit after the last source edit.

- **Suites:** `apps/nebula` 129 files and 1165 tests, `packages/mesh` 83 and 1031, `packages/resources` 4 and 29, all passing.
- **Local sweep:** every scenario ran on this tree, and all passed, with one flake. `first-app-built` failed once and passed on a rerun with nothing changed.
  - The flake was the scenario's own watch. It counted the thinking bubble and then read its text, and when the stream strip replaced the bubble between the two, the read waited Playwright's default 30 s and failed a turn that was streaming normally.
  - The watch now treats a read of a vanished element as no sample. That edit came after the sweep, and `first-app-built` alone was run again on it and passed.
- **Deployed pass:** `test-nebula` was redeployed and its self-check matched `be63ff1`. `post-edited-mid-turn`, `agent-invites`, `waiting-posts-answered` and `closing-step` passed there. An earlier deploy of this tree failed on a registry push, so the passes recorded before it were against the Phase 5 deploy.
- **Workers Issues since that deploy:** nothing new. The standing `scope-deleted`, and a recurring `teardown failed` from objects the deploy itself reset.
- **Not verified:** a post waiting across a real redeploy and answered after it, which `redeploy-strands-no-client` would be the place for; and the stored origin's value on a deployed `.dev` Star, where only the invite link's host was read.

### Retro

Walked through with Larry on 2026-11-12.

- **The redesign deleted a class of guard.** Acting from the stored record removed the held call and each guard for how it could go stale. `durable-objects.md` § *Wall-clock billing* carries the lesson.
- **Naming a snapshot by `validFrom` paid twice.** It gave the edit conflict with no new mechanism, and D16 is the same comparison applied to posts a message only answers.
- **Mutation checks were the only evidence in the lane.** Twelve cases in Phase 2 and twenty in Phase 5 passed on first write. Mutating them found fixtures that would have passed for the wrong reason, such as a writer whose admin bit bypassed the grant under test.
- **The panel found a defect every test missed.** The close's comparison and the commit were separate steps with an await between them. The case needed a gate that holds the commit open, which no test had until the panel named the window.
- **A failed deploy read as a pass.** The registry push failed, the script chain went on, and the deployed scenarios passed against the old deploy. `live.md` § *Two venues, one registry* now says a deployed pass counts only once the self-check has matched `HEAD`.
- **The dropped ADR sentence survived where a grep could not see it,** hyphenated in ADR-016's § *Consequences*. Larry read the reworded line and kept it.
- **The Phase 6 commit took in Larry's uncommitted work on the personas file.** He knew the risk of a second session on the tree, and no guidance changes for it.
- **`first-app-built`'s flake predates the build.** No other scenario reads an element it has just counted with no bound on the read, so `live-scenarios.md` gains nothing.
