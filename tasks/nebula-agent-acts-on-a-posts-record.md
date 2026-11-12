# The agent acts under the claims recorded on a post

**Status:** Pass 1, drafted 2026-11-12 and reworked the same day at Larry's hand review, which replaced the Registry mint with the record already on the post (D4); waiting on his next read, with no phases yet. It comes before the wipe and before [nebula-testing-with-personas.md](nebula-testing-with-personas.md), whose `provision` tool should be written against it.

## Conventions

A list that other sections cite gives each item a prefixed ID: `B` for a blocker in today's code, `DI` for an item of design intent, `C` for a checkable claim, `Q` for an open question and `D` for a decision. IDs follow the order items were raised, not the order shown, and are never reused, so D3 is the third decision made wherever its row sits, and a gap is an item removed or answered.

## Objective

**When Studio's agent acts for a person, it runs under the claims recorded on the post they wrote, read from the Galaxy's own storage. The Galaxy keeps no call of theirs open, and asks nobody for a token.**

Jennifer posts *"add a recently-bought list"* in the chat of `acme.crm`. The post's snapshot is stored with the claims her call carried: her `sub`, her `access` on `acme.crm`, and the `aud` of the page she posted from. A turn that takes the post up runs its tools under those claims, with `agent:lumenize` added as actor. If the Galaxy is evicted, the post and its record are still in storage and the post is still unanswered, so whatever turn next takes it up runs under the same record.

## Context

The agent posts as itself and acts for people. A tool call runs as *Jennifer + agent*, so a commit, a tenant Star's record and an invite's record each name both, and each check reads Jennifer's permission. The build that shipped this on 2026-11-11 took Jennifer's claims from the call her post arrived in. It kept that call open in memory and stepped back into it for each tool call.

Keeping a person's call open so that it stays in memory is the mistake `durable-objects.md` § *Wall-clock billing* now names. What the choice cost is in today's code:

- **B1. `#held`, a map from post to held call, in the Galaxy's memory.** An eviction empties it, so a post can be waiting with nothing the agent can act under, and the agent can then only ask someone to post again.
- **B2. A second job for `ctx.waitUntil`.** It holds the Galaxy while a turn's model calls and builds run, which stays. It also has to keep every held call alive until its post is answered, across the decisions that follow a turn, which is why each turn was given a hold of its own.
- **B3. `#takenUp`, and the rule that an edit to a post a running turn has taken up holds nothing.** Without it an edit swapped the claims under a running turn.
- **B4. Claims used long after they were issued.** A held call is never checked against its token's `exp`, so a person demoted after posting still acts until their post is answered or the Galaxy is evicted.
- **B5. `lmz.holdCall()` and `lmz.actFor(held, …)` in Mesh,** with a marker that says a chain was already acted for. The marker does not survive a result handler that runs after a call to another node.
- **B6. A decision may pick only a post whose call is held,** and the model is told which those are in a block of its own (`renderHeldBlock`).

The same claims are already in storage. Every snapshot is stamped by the server with the claims of the write that made it (ADR-016), so a post's record holds what its held call holds, and an eviction does not lose it. This task has the agent act from that record. B1, B2, B3, B5 and B6 then have nothing left to guard. B4 is not fixed, and loses its one limit, the eviction (DI9).

The rest of this file says what a turn reads in place of the held call, what that lets us delete, and what we accept by doing it. How a turn's loop is kept running is unchanged (D3). Two questions at the end are Larry's.

## Goals

1. **A waiting post is enough to act on.** Today a post is actionable only while the isolate that received it lives (B1, B6).
2. **After an eviction, the next turn can do the work.** Today the agent can only ask someone to say yes, and the work then runs as whoever does (B1).
3. **Acting for a person needs nothing outside the Galaxy.** A turn reads one row of the Galaxy's own SQLite. It makes no call to the Registry and verifies no token.
4. **Mesh has no way for a node to keep a caller's call.** Today it has one, with a guard for each way a held call can go stale (B3, B5).

## Relationships

- **Reworks** [archive/nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md), by its D30. That file's design intent stands except where § *Design intent* below says otherwise. Its D30 names a mint by the Registry, and its D8 rejects stored claims, citing ADR-016. D4 below reverses both.
- **Gates** [nebula-testing-with-personas.md](nebula-testing-with-personas.md): `provision` is a loop tool, and it should be written once, against DI1.
- **Changes** [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*, whose turn can run the work where today it can only ask. The wake check itself stays there.

## Current state

Built already, with what becomes of each part:

- **`recordedClaims` on every snapshot,** stamped by the server from the verified claims of the write: it becomes the source of a turn's claims. The column holds the full record: `sub`, the `act` chain, `profileId`, `access` and `aud`. Every read hands out only `sub`, `act` and `profileId`, through the allow-list in `Snapshots`' one read helper, and that stays as it is for clients.
- **`lmz.actFor` in Mesh:** adapted. It takes a stored record where it took a held call. It still adds the node's local principal as the outermost actor, and it stays one of the two forms that may write `originAuth`.
- **The agent as a local principal** (`lmz.asLocalPrincipal`, `NEBULA_SUB`, its protected `write` on `chat`): carried over unchanged.
- **`waitingPosts` in `apps/nebula/src/participants.ts`,** the one function that decides whether a post is answered: carried over unchanged. It becomes the only thing that says a post can be acted on.
- **A tool call's record,** `post` and `claims` on each `codegen.toolCalls` entry, and Studio's marks: carried over unchanged.
- **The single-flight latch `#turnInFlight`:** carried over. It is in memory by design, and an eviction clearing it is correct.
- **`lmz.holdCall`, `HeldCall`, `#held`, `holdPost`, `heldCallFor`, `#takenUp`, `renderHeldBlock`:** left behind (B1 to B6), and with them the marker `holdCall` reads, if nothing else reads it.
- **`ctx.waitUntil` around a turn, `#underDeadline` and `generationDeadlineMs`:** carried over (D3). The hold each decision's turn was given goes back to one hold per triggered run if nothing else needs it.
- **The Registry, the auth facade and `mintImpersonationToken`:** untouched. No turn reaches them to get claims.

Missing:

1. A way for the Resources plane to run a function under the full record of one stored snapshot, so the Galaxy names a post and the stored `access` and `aud` never leave the plane as data.
2. `lmz.actFor` taking a record.

## Design intent

- **DI1. A turn's tools run under the claims recorded on the post it took up.** They are the record of the snapshot the turn read, as stored: the poster's `sub`, `profileId`, `access` and `aud`. The agent is added as the outermost `act`. If an admin was impersonating Jennifer when the post was written, the admin stays in the chain beneath the agent, so the record of a tool call names all three.
- **DI3. The Galaxy acts for a person only on claims the server recorded from that person's own verified call.** This is a rule for the Galaxy's code, whether the model or a fixed step starts the work: the agent's loop today, the wake check and `provision` next. The Galaxy passes a post's id and the moment of the snapshot it read, and the Resources plane reads the record and hands it to Mesh. The model picks a post and never claims (DI8). Mesh's form takes a plain record, where today it takes a handle no node can build, so the rule is kept by the Galaxy having one call site, which goes through the plane.
- **DI4. No person's claims are kept in memory past a tool call.** A turn keeps the id of its post and the moment of the snapshot it read, and each tool call reads the record again from storage. The Galaxy is still held awake while a turn's model calls and builds run, as today (D3).
- **DI5. After an eviction a waiting post is acted on by the next turn that takes it up,** under the same record. That turn starts at the next post, through the decision after it, until the wake check lands (fast-follow Item 15).
- **DI6. Every waiting post can be taken up.** A decision picks among the posts `waitingPosts` returns, with no second test, and the model is told of no held set.
- **DI7. An edit changes whose claims the next turn runs under, and never a running turn's.** A turn keeps the moment of the snapshot it read to the end. An edit lands as a new snapshot with its editor's record, which a later turn reads.
- **DI8. A call that reads or changes a tenant Star's data, or changes who can do what, still runs under the claims of the post its turn took up,** chosen by the Galaxy and never by the model. This is the archived file's DI5, unchanged. Austen's turn runs under Austen's record, and a tenant Star refuses it as it does today.
- **DI9. The claims are the poster's as of the moment they posted, and stay usable until the post is answered.** Two things can change in between, and they differ:
  - **A grant in an orgTree is still read live.** Each node's check looks up the grant by `sub` when the call arrives. Take away Jennifer's `write` in a tenant Star and the agent's next call for her is refused there (C6).
  - **Passage and dominion are read from the record.** They come from `access` and `aud`. A person who lost their admin bit, or their membership, after posting still has both for the work their post asked for. An eviction no longer ends that, and no token's lifetime does.

  We accept this. They held the permission when they posted, every call is recorded as theirs with the agent as actor, and what the call does can be undone. If a customer's security review ever challenges it, the first step is a post in the chat when a participant's membership changes, which the agent weighs when it decides whether to act (§ *Beyond this task*).

Claims this rests on, each to be checked before the phases are written:

- **C3. An invite link names the right host with no caller's request behind it.** Today the facade takes the host from `callContext.originRequest`, which a held call carried and a record does not. Otherwise it takes it from `deploymentOrigin(env)`. On a local stack those differ.
- **C6. Every orgTree check a tool call meets reads the grant from the node's own storage,** keyed by `sub`, and reads `access` and `aud` only for passage and for the dominion bypass.
- **C7. Nothing a tool call reaches reads a claim the record lacks.** The record drops what `toRecordedClaims` drops, the token's `exp` and `iat` among them. No node inside the mesh checks `exp` today, which the archived file's build notes state.
- **C8. Every post a turn can take up carries a person's full record.** A post arrives in a client's call with verified claims. The agent's own posts carry the agent's record and are never waiting.

## Constraints

- **ADR-013 and ADR-016 both forbid what DI1 does.** ADR-013 calls a stored scope set a security bug, and ADR-016 says a stored `access` or `aud` is never read back to decide anything. Both are worded for a record read on some later, unrelated call. Here the record is the request itself, and the call acted on is the one it asked for. Both ADRs need a sentence that admits this one use and no other, which is Q8. Writing those sentences is the first phase, and Larry approves them before any code is written (D6).
- **ADR-016's other half is unchanged:** each action a tool takes is recorded with the person and the agent both.
- **ADR-025:** the agent stays a local principal with no membership. `security.md`'s rule that only Mesh's two forms write `originAuth` stands, with `actFor`'s source changed from a held call to a stored record.
- **`durable-objects.md` § *Wall-clock billing*:** no person's claims are kept by keeping the Galaxy awake. The turn's own hold only saves a restart.
- **No ADR is ratified by this task.** `docs/vision/auth.md` § *When the agent acts*, ADR-025, the two ADRs above and `security.md`'s bullet on the wider bound of the agent's work all need rewording. Those edits are Larry's to review.

## Beyond this task

- ⚠️ Design consideration: a live check can be added later without changing a caller. Every tool call enters through one form, so a chat post about a changed membership, or a read of the membership before a call that changes who can do what, lands in that one place.
- ⚠️ Design consideration: a turn whose rounds are stored could resume where an eviction stopped it. `tasks/backlog.md` § *Other Nebula backlog* has the row, with what the Agents SDK's fibers do. Nothing here should make the model's transcript depend on memory in a new way.
- ⚠️ Design consideration: the same form serves any node's local principal. A Star's agent, or a scheduled job acting for the person who set it up, would act from the record of the snapshot that asked for the work.
- ⚠️ Design consideration: the structured yes that the archived file's D2 defers to the first call that discloses tenant data is unchanged, and still waits for that call.

## Open questions

- **Q7. The names.** Mesh's form can keep its name, `lmz.actFor(record, principal, fn)`, since it still means what it meant. The plane's entry is new, and a new term is yours to approve. Offered: `actForAuthor(resourceId, validFrom, principal, fn)`, which says whose claims the function runs under.
- **Q8. How do ADR-013 and ADR-016 admit this?**
  - *A third licensed use, worded narrowly.* ADR-013 today licenses two stored copies and no others. The third would read: a node's local principal may act under the claims recorded on a snapshot, for the work that snapshot asks for. ADR-016's sentence gains the same exception.
  - *Leave both ADRs, and mark the code as an exception to them.* It is quicker, and every later reader meets two ADRs that say the code is a security bug.
  - **Recommendation:** the first, in your wording.
- **Q9. Where does an agent's invite get its link's host?** It is C3, left open on 2026-11-12 and to be settled before `/build-task`. A stored record has no `originRequest`, so the facade falls back to `LUMENIZE_ORIGIN`. A local stack's is `http://lumenize.localhost` with no port, so a local link would likely name port 80. Two fixes are in view, neither checked: the local config writes the port into `LUMENIZE_ORIGIN`, or the origin is stored beside the post.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D4 | A turn's tools run under the claims recorded on its post, read from the Galaxy's storage (Larry, 2026-11-12, at the hand review; replaces D1, which had the Registry mint them). | **A token the Registry mints each turn**, this file's first draft: it reads the membership live, so a demotion is noticed by the next turn. It costs a new mint for local principals, a Mesh form that verifies a signature, a Registry read per turn, and a second when a 14-minute turn outlasts a 15-minute token. That mint also writes a flat actor, so an impersonating admin drops out of the chain. **Keep the held call**: it needs B1 to B6. **Tools under the agent's own claims**: the agent would need grants in tenant Stars, and Austen's request would run on the agent's authority. |
| D5 | A record's passage and dominion stay usable until its post is answered, with no limit from a token's lifetime or an eviction (Larry, 2026-11-12). This widens the archived file's D26, which the eviction bounded. Mitigation waits for a customer to ask. | **A cap on a post's age**, one comparison of the snapshot's moment: an old post would need a second ask, to stop work that is recorded and can be undone. **A live read of the membership per call**: it is D4's rejected mint again. |
| D6 | The first phase edits ADR-013 and ADR-016 to admit DI1, and Larry approves the wording before any code phase starts (Larry, 2026-11-12). The same phase drafts the rewording of ADR-025, `auth.md` § *When the agent acts* and `security.md`'s bullet on the wider bound, for his review. | **Reword the ADRs at close-out**: the code would be built against two ADRs that call it a security bug, and a reviewer panel would report it as one. |
| D2 | The agent may act for a person on the strength of a post they wrote, with no session of theirs open (Larry, 2026-11-12). The post is their request, on the record as theirs. | **A live person for every act**, the archived file's D8: after an eviction the agent can only ask someone to say yes, and the yes runs as whoever gives it. |
| D3 | The hold on a person's call goes, and the hold on a turn's model calls stays as it is: `ctx.waitUntil` and the 14-minute deadline (Larry, 2026-11-12). Something has to wait for the model, and an executor apart from the Galaxy would be a second Durable Object held awake in place of the first. Starting or resuming an evicted turn is fast-follow Item 15 and a backlog row. | **A callback from Cloudflare**: AI Gateway's background runs are best-effort and unsigned, Workers AI's async queue takes minutes, and neither streams. **An executor Worker or Durable Object behind `lmz.call`**: two more hops and a recovery row, to save about $0.00014 of Galaxy duration a turn. **No hold at all, with a restart from the post**: it brings the wake check and its bounds into this task. |
