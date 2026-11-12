# The agent mints a person's claims from the post they wrote

**Status:** Pass 1, drafted 2026-11-12, waiting on Larry's hand review; no phases yet. It comes before the wipe and before [nebula-testing-with-personas.md](nebula-testing-with-personas.md), whose `provision` tool should be written against it. Decided by Larry on 2026-11-12, at the hand-off of the build it reworks.

## Conventions

A list that other sections cite gives each item a prefixed ID: `B` for a blocker in today's code, `DI` for an item of design intent, `C` for a checkable claim, `Q` for an open question and `D` for a decision. IDs follow the order items were raised, not the order shown, and are never reused, so D3 is the third decision made wherever its row sits, and a gap is an item removed or answered.

## Objective

**When Studio's agent acts for a person, it gets that person's claims by asking the Registry for them, using the post they wrote, and nothing keeps the Galaxy awake so that it can.**

Jennifer posts *"add a recently-bought list"* in the chat of `acme.crm`. The post is stored with her `sub` on its record. A turn that takes the post up reads it from Resources, asks the Registry for a token for that `sub` on `acme.crm` with `agent:lumenize` as actor, and runs its tools under it. If the Galaxy is evicted mid-turn, the post is still in storage and still unanswered, so the Galaxy starts the turn again when it wakes, and asks for the token again.

## Context

The agent posts as itself and acts for people. A tool call runs as *Jennifer + agent*, so a commit, a tenant Star's record and an invite's record each name both, and each check reads Jennifer's permission. The build that shipped this on 2026-11-11 took Jennifer's claims from the one place it had them: the call her post arrived in. It kept that call open in memory and stepped back into it for each tool call.

Keeping a call open is keeping a Durable Object awake, and `durable-objects.md` § *Wall-clock billing* now says a design must not depend on that to be correct. What the choice cost is in today's code:

- **B1. `#held`, a map from post to held call, in the Galaxy's memory.** An eviction empties it, so a post can be waiting with nothing the agent can act under, and the agent can then only ask someone to post again.
- **B2. `ctx.waitUntil` around every turn, and a 14-minute generation deadline under its 15-minute limit.** Both exist so the held call outlives the turn. The deadline frees the latch while the turn it cut off keeps running.
- **B3. `#takenUp`, and the rule that an edit to a post a running turn has taken up holds nothing.** Without it an edit swapped the claims under a running turn.
- **B4. Claims used long after they were issued.** A held call is never checked against its token's `exp`, so a person demoted after posting still acts until their post is answered.
- **B5. `lmz.holdCall()` and `lmz.actFor(held, …)` in Mesh,** with a marker that says a chain was already acted for. The marker does not survive a result handler that runs after a call to another node.
- **B6. A decision may pick only a post whose call is held,** and the model is told which those are in a block of its own (`renderHeldBlock`).

The rest of this file says what replaces the held call, what that lets us delete, and what an evicted turn does instead. The questions that are still Larry's are at the end.

## Goals

1. **A waiting post is enough to act on.** Today a post is actionable only while the isolate that received it lives (B1, B6).
2. **A person's authority is read when it is used.** Today it is read once, when they post, and used for as long as the post waits (B4).
3. **An eviction mid-turn costs a restart of that turn and nothing else.** Today it costs the turn, and the post waits for another post (B1, B2).
4. **Mesh has no way for a node to hold a caller's claims.** Today it has one, with a guard for each way a held call can go stale (B3, B5).

## Relationships

- **Reworks** [archive/nebula-agent-posts-as-itself.md](archive/nebula-agent-posts-as-itself.md), by its D30. That file's design intent stands except where § *Design intent* below says otherwise.
- **Gates** [nebula-testing-with-personas.md](nebula-testing-with-personas.md): `provision` is a loop tool, and it should be written once, against DI1.
- **Changes** [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*, whose turn can run the work where today it can only ask (Q3 decides how much of it moves here).

## Current state

Built already, with what becomes of each part:

- **The agent as a local principal** (`lmz.asLocalPrincipal`, `NEBULA_SUB`, its protected `write` on `chat`): carried over unchanged. Posting, reading the thread, the decision and the closing step already run under claims the Galaxy builds from nothing.
- **`waitingPosts` in `apps/nebula/src/participants.ts`,** the one function that decides whether a post is answered: carried over unchanged. It becomes the only thing that says a post can be acted on.
- **`recordedClaims` on every snapshot,** stamped by the server from the verified claims of the write: carried over unchanged. Its `sub` is what a mint is asked for. Its `access` and `aud` stay history and are never read as authority (ADR-016).
- **`mintImpersonationToken` in `packages/mesh/src/auth/worker-token.ts`:** adapted. It already mints a subject's token from their accepted membership, read live, with the caller as `act`. Today its caller must be an admin holding dominion over the subject.
- **A tool call's record,** `post` and `claims` on each `codegen.toolCalls` entry, and Studio's marks: carried over unchanged.
- **The single-flight latch `#turnInFlight`:** carried over. It is in memory by design, and an eviction clearing it is correct.
- **`lmz.holdCall`, `lmz.actFor`, `HeldCall`, `#held`, `holdPost`, `heldCallFor`, `#takenUp`, `renderHeldBlock`, each turn's `ctx.waitUntil`, `#underDeadline` and `generationDeadlineMs`:** left behind (B1 to B6).

Missing:

1. A mint a node's local principal may ask for, for a member of that node's own scope.
2. A way for a node to run code under claims the Registry signed.
3. Something that starts an evicted turn again.
4. A bound on a turn that dies every time it runs.
5. A bound on one model call, now that no deadline bounds the turn.

## Design intent

- **DI1. A turn's tools run under claims minted for the author of the post it took up.** The author is the `sub` on the record of the snapshot the turn read. The Galaxy, acting as `agent:lumenize`, asks the auth facade for that `sub`. The Registry answers from the membership as it stands: the same `sub`, `authScope` and `scopeAdmin` a refresh would give that person on the Galaxy's host, `aud` the Galaxy's own scope, and `act` the agent. A person with no accepted membership covering the Galaxy gets a refusal, which the agent posts.
- **DI2. A local principal mints only for its own node.** The facade reads the asking node's name from the caller's `aud`, which for a local principal is the node it runs in, and mints with that `aud` and no other. So the Galaxy `acme.crm` can act for a member of `acme.crm` or of `acme` within `acme.crm` and below, and for nobody in `acme.sales`.
- **DI3. The Galaxy cannot compose a person's claims.** It can ask for them and it can run under what it is given, and what it is given carries the Registry's signature (Q1). This keeps the property the held call had: no code path in the Galaxy builds a claims object naming a person.
- **DI4. Nothing is kept so that it stays in memory.** No `ctx.waitUntil` wraps a turn and no deadline races it. A token held for the length of a turn is a saving, and the turn mints another when it lapses or after a restart.
- **DI5. A turn that an eviction cuts off starts again from its post.** What the turn wrote to the Workspace is already stored. Its transcript with the model is not, so the model reads the source again. The agent says in the chat that it was interrupted (Q4).
- **DI6. Every waiting post can be taken up.** A decision picks among the posts `waitingPosts` returns, with no second test. A mint that refuses is how the agent learns a poster has lost their standing.
- **DI7. An edit changes whom the next mint is for, and never a running turn.** A turn mints for the author of the snapshot it read and keeps that `sub` to the end. An edit lands as a new snapshot, whose author a later turn mints for.
- **DI8. A call that reads or changes a tenant Star's data, or changes who can do what, still runs under the claims of the post its turn took up,** chosen by the Galaxy and never by the model. This is the archived file's DI5, unchanged. Austen's turn mints Austen's claims, and a tenant Star refuses them as it does today.

Claims this rests on, each to be checked before the phases are written:

- **C1. A minted token's reach is what the person's own token on the Galaxy's host would have.** `mintImpersonationToken` mirrors the subject's `authScope` and `scopeAdmin` and takes `aud` from the caller, and dominion reads `aud`.
- **C2. No client can make the facade take it for a local principal.** A client's claims come from a verified token, and no token is minted with `agent:lumenize` as its `sub`. A persona's `sub` is not a random id either, so the facade's test has to be more than the shape of the `sub`.
- **C3. An invite link names the right host with no caller's request behind it.** Today the facade takes the host from `callContext.originRequest`, which a held call carried, and otherwise from `deploymentOrigin(env)`. On a local stack those differ.
- **C4. A turn completes with no `ctx.waitUntil`.** At compatibility date 2026-10-01 a pending binding call holds a Durable Object as `waitUntil` does, and a turn is nearly always inside a model call or a build's exec. To be measured deployed, on a turn of two minutes or more.
- **C5. The Registry read a mint makes is one per turn, or one per token lifetime on a long turn.** That is the rate ADR-018 has to accept (Q6).

## Constraints

- **ADR-013:** authority resolves live, and a stored scope set is a security bug. The mint reads the membership each time.
- **ADR-016:** the stored `access` and `aud` on a record are never an authorization input. Only the record's `sub` is used, as the name of whom to ask about. Whether the mint itself is recorded is Q2.
- **ADR-018:** the Registry is a singleton. See C5 and Q6.
- **ADR-023:** the Galaxy reaches the Registry through the auth facade, over `lmz.call`.
- **ADR-025:** the agent stays a local principal with no membership. The mint gives it nothing of its own.
- **`durable-objects.md` § *Wall-clock billing*:** correctness must not depend on the Galaxy staying awake.
- **No ADR is ratified by this task.** `docs/vision/auth.md` § *When the agent acts* and ADR-025 need rewording, and those edits are Larry's to review.

## Beyond this task

- ⚠️ Design consideration: a turn whose rounds are stored could resume where it stopped, where DI5 starts over. Nothing here should make the model's transcript depend on memory in a new way.
- ⚠️ Design consideration: the same mint serves any node's local principal. A Star's agent, or a scheduled job acting for the person who set it up, would ask the same way.
- ⚠️ Design consideration: the structured yes that the archived file's D2 defers to the first call that discloses tenant data is unchanged, and still waits for that call.

## Open questions

- **Q1. How do minted claims enter the Galaxy?**
  - *A signed token.* The facade returns an access token, and a new Mesh form verifies its signature and runs a function under its claims. The Galaxy cannot forge one. It costs a signature check per mint.
  - *A claims object.* The facade returns claims as a call's result and Mesh runs under whatever object it is handed. This is simpler, and any node could then build a person's claims, which gives up DI3.
  - *A call back.* The Galaxy asks the facade to call it under the minted claims. Nothing enters as data, but a Worker starting a chain under claims it chose is itself a new Mesh power.
  - **Recommendation:** the signed token.
- **Q2. Is each mint recorded under ADR-016?** An impersonation mint is recorded today, as establishing a session. Recording the agent's would be a Registry write per turn. The actions taken under the token are each recorded with both names already. **Recommendation:** no record at the mint, with ADR-016 saying why, which needs your wording.
- **Q3. What starts an evicted turn again when nobody posts?**
  - *An alarm set when a turn takes a post up, and cleared when it ends.* If it fires on a fresh isolate with the post still waiting, a turn starts. It costs an alarm write and a delete per turn, and it is fast-follow Item 15 moved here in full.
  - *The next wake, whatever causes it.* No write, and a post can wait overnight, as today.
  - **Recommendation:** the alarm. Under DI4 an eviction is an ordinary event, and the turn it cuts should not wait for a person.
- **Q4. What bounds a turn that dies every time?** Each restart could post a short agent message, *"I was interrupted and am starting again"*, naming the post in `replyTo`. The count of those after the post is then the attempt count, read from the chat with no counter of its own. After two, the agent posts that it stopped and answers the post. **Recommendation:** that, with the limit at two.
- **Q5. What bounds one model call?** With no deadline around the turn, a call that never returns holds the latch until eviction. **Recommendation:** a timeout on `callModel` itself, which the backlog already asks for, set from the longest healthy call we have measured.
- **Q6. Is a Registry read per turn acceptable?** It is one read, at the pace of a person's requests, and the token it returns serves the whole turn. The alternative is a copy of each membership in Workers KV, kept current by the Registry. **Recommendation:** accept the read, and state its rate in the mint's JSDoc as ADR-018 asks.
- **Q7. The names.** The facade entry and the Mesh form each need one, and a new term is yours to approve. Offered: `AuthFacade.actFor(sub)`, which says what the caller asks for, and `lmz.actUnder(token, fn)`. The freed name `actFor` would then mean the mint, where today it is the Mesh form being deleted.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | A turn's tools run under claims minted live for the author of its post, read from the stored record (Larry, 2026-11-12). | **Keep the held call**: it needs B1 to B6. **Tools under the agent's own claims**: the agent would need grants in tenant Stars, and Austen's request would run on the agent's authority. |
| D2 | The agent may act for a person on the strength of a post they wrote, with no session of theirs open (Larry, 2026-11-12). The post is their request, on the record as theirs. | **A live person for every act**, the archived file's D8: after an eviction the agent can only ask someone to say yes, and the yes runs as whoever gives it. |
| D3 | No design here depends on the Galaxy staying awake (Larry, 2026-11-12). | **Keep `ctx.waitUntil` as the turn's guarantee**: it is a hold standing in for storage, and it caps a turn at 15 minutes. |
