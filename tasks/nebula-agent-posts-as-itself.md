# The agent posts to the chat as itself

**Status:** Pass 1, drafted 2026-10-11 for Larry's read and reshaped the same day to hold posts that arrive mid-turn; phases not written. Split out of [nebula-testing-with-personas.md](nebula-testing-with-personas.md) at its third Stage 1 gate; nothing gates it, and it gates personas. Drafted while its sibling [nebula-star-ontology.md](archive/nebula-star-ontology.md) was in review, a deliberate exception to writing one child task file at a time, because the design was worked out with Larry on 2026-10-10. Decided then: the agent posts as itself, and a turn a person's post starts acts as that person. Decided 2026-10-11: a post that arrives mid-turn is held with its poster's authority, built in two steps. Decided 2026-10-15: the agent holds `write` on a `chat` node in the Galaxy's tree, and nothing in the Registry.

## Objective

**Every message the agent puts in the chat is its own, and a post that arrives while the agent is busy keeps its poster's authority until the agent gets to it.**

## Context

**How a turn works today.** Studio posts a human `Message` to the Galaxy's chat node, and the Galaxy's post-commit hook, `#onChatCommitted`, starts a turn. The turn runs inside the poster's own call, so it reads, writes source and builds with that person's permissions. Its reply commits with the poster as the subject and the agent, `agent:lumenize`, as the actor, which is why Studio's byline reads *Lumenize for Jennifer*. One turn runs at a time: a post that arrives while one runs, behind the in-memory `#turnInFlight` flag, starts nothing and sits in the thread unanswered.

**Two people in one chat make that skipped post common, and the personas task needs two things it cannot do.**

- **A yes that arrives too soon is lost.** The agent asks before it provisions, and a quick yes can land while the asking turn is still committing its reply.
- **An outcome has nobody to post as.** Provisioning's result arrives in a Galaxy handler on a chain the Galaxy started, which carries nobody's claims. A write there throws in `Snapshots.#buildActingToken`, whose `projectActingToken` reads `claims.sub` off `undefined`.

**Where a held post's turn starts decides whose permissions it runs with.** A turn can do nothing without a human's permissions. Started from the ending turn's `finally`, a held post's turn runs inside the ending turn's call: Austen's held request to invite a Galaxy admin would run as Jennifer, and succeed. Started from a continuation attached inside Austen's own call when her post commits, it runs as Austen, the way every turn already keeps running as its poster after the poster's call has returned.

**On 2026-10-10 Larry decided the agent posts as itself, and on 2026-10-11 that a post arriving mid-turn is held.** The agent posts on a grant of its own in the Galaxy's tree rather than on a person's permissions, so it can post an outcome, or answer people from a turn of its own, with no person's call to post in. A held post keeps its poster's authority in memory, and its turn acts as that poster when it runs. `docs/vision/auth.md` § *When the agent acts* was amended on 2026-10-10: when the agent writes, it writes as the person whose post started the turn; when it talks, it posts as itself.

The rest of this file covers what changes, how a held post is run, the two steps the build comes in, catching up after a restart, and three questions still open.

## Goals

1. **A post never goes unanswered because the agent was busy, or because the Galaxy restarted.** Today it waits for someone to post again.
2. **A request made while the agent is busy acts on the first try.** Today it is never acted on unless its poster asks again.
3. **The agent can post when no person's call is there to post in:** an outcome from a result handler, or a message from a turn it started. Today such a write throws.
4. **A turn acts only as the person whose post started it.** Today that holds only because a late post starts nothing; a held post's turn started from the ending turn's call would break it.
5. **The chat still shows whom the agent answered.** Today the byline gets that from the reply's subject, which becomes the agent.

## Relationships

- **It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, whose provisioning outcome and admin-invite outcome are agent posts, and whose confirmation relies on a quick yes being acted on.
- **Nothing open gates it.** Its sibling, [nebula-star-ontology.md](archive/nebula-star-ontology.md), was built on 2026-10-12, so personas now waits on this task alone.
- **Personas' `asPersona` builds on what this task adds to Mesh**: running a block under claims Mesh builds for an identity with no Registry membership, which the agent needs first.
- **It replaces a decision of [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)**, built 2026-10-15: that a landing records its `ServedBuild` as the build's caller under `pinnedAtDoor`.

## What changes

**New:**

1. **The agent as a local principal of the Galaxy.** `agent:lumenize` holds `write` on the Galaxy's `chat` node, seeded when the tree is created, and has no Registry membership. Its posts and its own turn's reads run under claims Mesh builds for it, and pass the same DAG check as anyone's, against that grant.
2. **A `chat` node of its own.** `CHAT_NODE_ID` names a node under the root, created with the tree at a fixed id as the root is, instead of being the root itself. The agent's grant and every collaborator's chat-floor grant sit on it.
3. **Running a block under claims Mesh builds**, for an identity with no Registry membership. `runWithCallContext` is not exported from any of Mesh's subpaths, so the agent's claims need a Mesh helper, which personas' `asPersona` then reuses. A call made under them starts a fresh chain, so they never leave the node that built them.
4. **A held post.** When `#onChatCommitted` skips a post because a turn is running, it holds the post: a continuation attached inside the poster's own call, which runs the post's turn when the Galaxy resolves the promise it waits on. The hold lives in Galaxy memory only.
5. **Held posts run oldest first (step 1).** When a turn ends, the Galaxy releases the oldest held post, and its turn runs as its poster through the same latch.
6. **The agent's own turn (step 2).** When a turn ends and posts are held, the Galaxy instead starts a turn of its own, in memory and under the agent's claims. It reads the thread, posts what it has to say, and names the held posts to take up; the Galaxy releases those one at a time.
7. **Catching up when the Galaxy starts (step 2).** `onStart` looks for posts still pending, and if it finds any, schedules the agent's own turn. It covers what an eviction drops: the held posts, and the post whose turn the eviction killed.
8. **A message is the agent's when its subject is the agent**, or, as today, when its outermost `act` is. `deriveKind` in `participants.ts` reads only `act` today, so an agent post would read as human and get a turn that answers itself.

**Adapted:**

- **`commitAgentMessage`** writes under the agent's claims, without the `actor` and `pinnedAtDoor` options it passes today.
- **Every use of `CHAT_NODE_ID`** follows the constant to the new node: Studio's post, `requireChatWrite`, `#onChatCommitted`, the agent's posts, and the `ServedBuild` a landing records, which Studio hears through the chat's query.
- **`#onChatCommitted`** still starts one turn at a time; a post it skips is now held, and a turn's end releases one or starts the agent's own turn.
- **Studio's byline and avatar stack**, which `App.vue` builds from `deriveParticipants`' list of the subject and the `act` chain, joined with *for*.
- **What Studio shows under a post that waits.** `App.vue` resets a post's 90 s idle window only on chunks replying to that post, so a post waiting behind another person's turn shows *thinking…*, then *failed*. The comment there justifies it by saying a skipped post is never answered, which this task makes false. `deriveTurnDisplay` gains a waiting state, held while another post's turn streams. The change is Studio's alone; nothing on the server changes for it.
- **The tool contract in `codegen-loop.ts`**, which gains the rule that the agent addresses the person and asks before acting on anything it was not asked directly. The agent's own turn gets instructions of its own, since the contract's first rule tells the model to act with tools that turn is not offered.
- **`security.md`'s bullet on the verdict of the door that admitted the work.** Its reply and its `ServedBuild` become the agent's own writes and leave it; what stays is a turn's source writes running on its post's verdict, a held post's included through its wait.
- **`#recordServedBuild`** writes as the agent, under its grant on `chat`, and **`buildNow`** logs its caller's claims through `projectActingToken`, as `writeSource` logs each commit.
- **`auth.md` § *The data plane and fine-grained access control***, which says the tree gates resources, gains that a grant may gate an operation too, as `requireChatWrite` gates source by the chat node's `write`; `security.md`'s `requireChatWrite` bullet points there.
- **`docs/vision/auth.md` § *When the agent acts***, amended on 2026-10-10, whose sentence on the turn the agent starts gains taking up a held post, and whose post that passes no check becomes the agent's grant on the `chat` node, stated as a local principal.
- **`security.md`'s rule that no synthetic claims are written into a chain a node started** names the agent's claims, beside the persona's.
- **The ADRs.** [ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md), drafted at the gate on 2026-10-15, commits the orgTree as a node's one fine-grained access control and the local principal. ADR-015 gains a line on what its coarse-grained checks see of one; ADR-016's bullet on a server-composed actor stops saying the agent holds no authority; and ADR-010's index line notes `agent:lumenize`, a fixed self-describing id, beside the persona's. These, with `auth.md`'s edits and § *How the claims travel*'s second case of a node building claims, were drafted at the gate on 2026-10-15 for Larry's review.
- **What asserts the old attribution:** `four-party-chat`, which checks the reply's `act.sub` is the agent and its `sub` the poster; `child3-post.test.ts`; and `first-app-built`'s fourth limb. Each inverts, which `calibration.md` §3(b) says to expect.

**Removed:** `pinnedAtDoor` in `TransactionOpts`, and the check Snapshots skips for it.

**Kept, with new callers:** the `actor` a write carries. The loop stamps the agent as actor once, where it dispatches a tool, so every write a tool makes for the poster reads *Jennifer, via the agent*: here, the record each source commit logs; from personas on, the `invite` tool's resource writes, through a transaction path that then takes an actor.

**Kept as they are:** a turn a person's post starts, which runs inside their call exactly as today; one turn at a time; the generation deadline; and `#historyBundle`, which reads under whatever claims the turn runs with, the agent's included.

## Design intent

**A message's author is whoever wrote it, and the agent writes its own.** Jennifer asks the agent to add due dates to deals. The turn her post starts runs as her: its source edits and its build are hers. Its reply is the agent's own message, with `replyTo` naming her post.

**A post that arrives mid-turn keeps its poster's authority until a turn runs it.** Jennifer's turn is building when Austen posts *"can the due date default to next Friday?"*.

1. **Austen's post starts no turn, because one is running, so `#onChatCommitted` holds it.** The hold is a continuation attached inside Austen's own call, so whatever it later runs, runs as Austen. Her Studio shows the post waiting its turn, for example *"Lumenize will get to this after the current turn"*, rather than *thinking…*, and shows no *failed* while Jennifer's turn is still streaming.
2. **When Jennifer's turn ends, the Galaxy decides what runs next.** In step 1 it releases the oldest held post, Austen's. In step 2 it starts the agent's own turn in memory, under the agent's claims, which replace Jennifer's call context, so the turn carries none of her authority and nothing is written to start it.
3. **In step 2, the agent's own turn reads the recent messages, its own included, and decides what to address first.** It sees that Jennifer's turn ended by asking her whether a due date is required, and that Austen's change does not depend on the answer. So it tells Jennifer it is starting on Austen's change while it waits, and takes Austen's post up. It could as well answer Austen in prose and leave her post held until Jennifer replies.
4. **Austen's post's turn runs as Austen**, through the latch like any turn: its source edits and its build are hers, and its reply's `replyTo` names her post.

- **A held post's turn runs in the call its continuation was attached in, whoever releases it.** `#onChatCommitted` attaches the continuation that runs Austen's turn while it is still inside her call, and the end of Jennifer's turn only resolves the promise it waits on, so her turn still runs as Austen. A continuation attached at the release instead would run as Jennifer. Every turn already rests on the same property: its awaits resume as the poster, though the I/O that resumes them belongs to no call.
- **Taking up a held post needs no further yes**, because the post is its poster's own request. The agent asks only when a post was not a request to it, such as a remark to another person. That is guidance in the tool contract, not a check.
- **The agent's own turn writes nothing but its message.** It is not offered the loop's tools, which run in-process past their decorators and check no claims. Its one power is taking up a held post, which runs as that post's poster. Its record names the posts it took up and the posts it left held, which is how a test sees what it did.
- **A post stays held until a turn takes it up**, so the agent can leave one for a later turn's end, after Jennifer answers, say. In step 1 each is taken up in turn.
- **What is held lives in memory, and nothing is stored to run it.** Only catching up after a restart schedules anything. The running turn holds the Galaxy in memory while posts wait behind it (`ctx.waitUntil`, up to 15 minutes from the turn's start). An eviction drops the held posts together with that turn, so holding adds no failure of its own.
- **When the Galaxy starts again, it catches up** (Larry, 2026-10-11 and 2026-10-15). Resets are common under load: the 2026-10-14 deployed sweep hit three in 65 scenarios. `onStart` finds the posts still pending, Austen's held one and Jennifer's, whose turn died with the reset, and schedules the agent's own turn through Mesh's `svc.alarms`. That turn speaks only for itself, so it reads the recent messages, decides what to address first, and asks whether to proceed: it might tell Jennifer her turn was interrupted and what landed, and ask Austen *"Should I proceed?"*. A yes runs as whoever sends it, so if the agent asked Jennifer and Austen answers *"yes, go ahead"*, the work runs as Austen. A reset is the one case where a request made mid-turn costs a second yes.
- **A held post's turn acts on the verdict its post's door check gave**, as every turn does (`security.md`). A grant revoked while Austen waits does not stop her turn, just as one revoked mid-turn does not stop a running one.

**The build comes in two steps, both in this file.** Step 1 holds skipped posts and runs them oldest first, each as its poster, with no turn of the agent's own. Step 2 adds the agent's own turn, which chooses the held posts to take up and answers in prose where nothing should run yet. Step 2 is step 1 plus that choice, and it carries catching up after a restart too, since only the agent's own turn can answer a post whose authority is gone.

**The agent is a local principal of the Galaxy: an identity that holds grants in one node's tree and nothing in the Registry.** In the Galaxy `acme.crm`, `agent:lumenize` holds `write` on the `chat` node, seeded with the tree, and nothing in the Registry: no membership, which is a grant in the Registry, so no token, and so no passage or dominion anywhere. Mesh builds its claims on the server, only server code runs under them, and its reads and posts pass the same check as anyone's, against that grant.

- **The agent's own turn reads the thread through `#historyBundle` unchanged.** Each `doRead` checks the agent's grant as it would a person's, and grants roll down, so the grant on `chat` covers every node beneath it and nothing beside it.
- **The grant is visible and revocable.** Every member sees it in the tree (ADR-008), shown as Lumenize, and an admin who revokes it stops the agent reading and posting.
- **No client can post as the agent.** A client's transaction has no argument naming its subject or actor, and the claims Mesh builds for the agent never leave the Galaxy.
- **An outcome from a result handler**, such as provisioning's, is an agent message whose `replyTo` is the post that confirmed it, carried through the continuation as data.
- **A landing is the platform's act.** The `ServedBuild` it records is the agent's write, under its grant on `chat`, so nothing refuses it but a revoked grant. Who asked is on the post that started the turn, or in `buildNow`'s log line.

**The chat sits on a node of its own, under the root.** The tree is access control, not an org chart: a node holds resources and the nodes beneath it, and the grants on it define an audience. Today the chat node is the root, so a collaborator's chat-floor `write` would cover every node the Galaxy's tree ever holds. With `chat` beside the root's later children, a grant on it covers the conversation and what hangs off it, the `Message`s and each landing's `ServedBuild`. Anything with a different audience goes in a node beside `chat`, granted on purpose.

**`deriveKind` reads the subject in the same change that makes the agent one.** Otherwise the agent's first post as itself reads as human, gets a turn of its own, and the agent answers itself forever.

## Constraints

- **`docs/vision/auth.md` § *When the agent acts***: the agent writes as the person whose post started the turn, and talks as itself.
- **[ADR-003](../docs/adr/003-continuation-messaging.md)**: the agent's own turn starts on a chain of its own, and a result handler's outcome travels as data in a continuation. A held post waits on the Galaxy's own latch, never across a hop, so no node holds a reply open for another.
- **`durable-objects.md` § *No mutable instance state***: a held post is an ephemeral cache whose loss is acceptable, since losing it leaves the post in the thread for `onStart` to find.
- **`durable-objects.md` § *Initialization***: a Mesh node's `onStart` runs inside `blockConcurrencyWhile` on every wake, a hibernation wake included, so the check there only reads and schedules. It schedules the agent's own turn through Mesh's `svc.alarms` with a fixed id, so repeated wakes do not stack turns, and that turn takes the latch like any other.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: an agent message changes no authority and destroys nothing, so it owes no record; what a turn does as a person still records that person.
- **`security.md`**: a turn's authority is pinned at the post that started it, a held post's included, and no client can name an actor or a subject.
- **`calibration.md` §14**: least privilege belongs to the fine-grained layer, so the agent's authority is a grant in the tree, never a membership in the Registry.
- **`studio-guidance.md`**: asking before acting on what the agent was not asked directly is cross-turn policy, so it lives in the tool contract.
- **`live.md`**: a `/live` scenario first. Holding a post and running its turn as its poster are deterministic and gate; which held posts the agent's own turn takes up is the model's judgment, and rides a limb that does not.
- **`calibration.md` §12**: whatever decides when Studio stops showing *thinking* lives in a named function, as `deriveTurnDisplay` does.
- **Milestone:** pre-alpha, before the personas task.

## Future state

- ⚠️ Design consideration: **a discriminator decides whether the agent answers at all.** Fast-follow Item 6 starts it with Cloudflare's Clef. It plugs in at two points, a post arriving and a turn ending, and this task builds the second as the agent's own turn.
- ⚠️ Design consideration: **the agent hands long work to sub-agents and stays the chat's supervisor** (Larry, 2026-10-10). Its turns then stay short, so a held post waits seconds rather than minutes, and each sub-agent runs under the authority of the held post it serves.
- ⚠️ Design consideration: **when exactly one post is held, step 2's turn is an extra model call before it.** If that latency shows, the Galaxy can release a lone held post directly, as step 1 does.
- ⚠️ Design consideration: **catching up after a restart is the first half of fast-follow Item 6's lease per turn.** Item 6 keeps the attempt cap, for an agent turn that dies before it answers and so finds the same posts pending on every wake.
- **Steering a turn while it generates** stays in fast-follow Item 6.

## Open questions

1. **What may the agent's own turn read?** Settled 2026-10-15: what the agent's own grant reads, through the same check as anyone's (§ *Decisions*).
2. **One reply from the agent's own turn, or one per post it answers? (step 2)** A post the agent takes up gets its own turn's reply. Studio stops showing a post as waiting when a reply whose `replyTo` is that post lands (`replyLanded` in `App.vue`), so one combined reply settles only one poster's Studio.
   - **Recommendation:** one reply, with `replyTo` the latest post it answers, and Studio stops waiting for a post when an agent message lands whose `replyTo` is that post or a later one. Jennifer's reply, whose `replyTo` is her own earlier post, then leaves Austen waiting. One reply reads like a person answering two people at once, and nothing about `Message`'s stored shape changes.
3. **What does the byline say once the agent is the subject?** Today *Lumenize for Jennifer*, built from the subject and the `act` chain.
   - **Recommendation:** *Lumenize, re: Jennifer*, naming the author of the post in `replyTo`, so the chat keeps showing whom the agent answered. Beat: *Lumenize* alone, which drops it.
4. **Does a write the agent makes for a person still name the agent?** Settled 2026-10-15: yes, and this task makes it true (§ *Decisions*).
5. **How does the Galaxy know which posts are still pending? (step 2)** `onStart`'s check needs it, and so does Studio, to know when to stop showing a post as waiting.
   - **(a) Derive it from the thread.** A human post is pending while no agent message's `replyTo` is that post or a later one, the rule question 2 recommends, and also while the agent's latest message names it as left held. One rule then serves `onStart`, the end of a turn, and Studio.
   - **(b) Store which posts have been processed**, a set the Galaxy writes as it takes up or answers each post.
   - **Recommendation: (a).** The thread already records every reply and, through the agent's own message, every post it left held, so a stored set would be a second copy of what the thread says, owing a way to stay in step with it ([ADR-010](../docs/adr/010-random-opaque-keys.md)'s replication rule).
6. **Should the agent meet every gate the chat floor guards?** Settled 2026-10-15: yes, bounded by what runs as it (§ *Decisions*).
7. **Does the agent's grant retire `pinnedAtDoor`?** Settled 2026-10-15: yes (§ *Decisions*).
8. **Where is the local principal committed?** Settled 2026-10-15: a new ADR of its own (§ *Decisions*).
9. **May a grant in the tree gate an operation that touches no resource?** Settled 2026-10-15: yes, and `auth.md` says so (§ *Decisions*).

## Decisions

Started at the Pass 1 gate; only settled rows.

| Decision | Why, and what it beat |
|---|---|
| **The agent posts to the chat as itself.** Every agent message names `agent:lumenize` as its subject, with no `act`, and only server code runs under the agent's claims. | 2026-10-10 (Larry), amending `docs/vision/auth.md` § *When the agent acts*, which had the agent only ever an actor. That section's objection was to a login, which grants authority that then has to be confined; this confines one thing, a chat post. Beat: the poster as every agent message's subject, as today, which leaves an outcome and the agent's own turn nobody to post as; and the agent as subject only in its own turns, which makes two shapes of agent message. |
| **The agent is a local principal of the Galaxy, with no Registry membership.** `agent:lumenize` holds `write` on a `chat` node of its own, under the root, and its reads and posts pass the same DAG check as anyone's against that grant. | 2026-10-15 (Larry): reading as itself is the other half of posting as itself. The grant goes through the one read path everyone uses, so a rule added there later applies to the agent too; it shows in the tree, and an admin can revoke it; and a node cut off from the root, which a read with no check would have reached, is out of its reach as it is for anyone granted above it. The `chat` node keeps that grant, and every collaborator's chat-floor grant, off whatever the tree holds later. Beat: a server read with no check, confined to the chat node by hand, which is a second read path every later rule skips and the first read on behalf of nobody whose output is then posted; reading under a held post's authority, which nothing holds after a restart; a Registry membership, which is the login `auth.md` objects to; and `read` alone, which leaves the post's skipped check in place. |
| **An identity that holds grants only in one node's tree, with no Registry membership, is a *local principal*: a pattern to expect, not an exception.** Mesh builds its claims on the server, only server code runs under them, and they pass the node's ordinary checks. | 2026-10-15 (Larry). The agent is the first case, and an app's own assistant, fast-follow Item 2, a likely next. Where it is committed is question 8. Beat, as names: *service principal*, the Azure term, whose identity signs in with a secret; and *tree principal*. |
| **The local principal gets an ADR of its own, the fine-grained counterpart to ADR-015, committing two things.** A node's tree is its one fine-grained access control, for its resources and for any operation it gates. A local principal holds grants in that tree and no membership, a membership being a grant in the Registry. ADR-015 gains one line on what its coarse-grained checks see of a local principal, and ADR-016's bullet on a server-composed actor is corrected. | 2026-10-15 (Larry). It meets the bar in `docs/adr/README.md`: Mesh builds the claims, the Resources plane checks the grant and Nebula seeds it; the commitment is grants in one tree and never a membership in the Registry, whatever builds the claims; and this file's first draft of question 1 proposed violating it. Beat: ADR-015, whose predicate-pair section already rules on the claims a node's own chain carries, but which is the coarse-grained ADR a local principal holds none of, and sits on the ADR size budget; and ADR-023, which commits how our own code meets the mesh's checks, but whose subject is crossing the mesh boundary, which a local principal never does. |
| **A landing's `ServedBuild` is the agent's write, and `pinnedAtDoor` goes.** `buildNow` logs its caller's claims, as `writeSource` does. | 2026-10-15 (Larry). `ServedBuild` is how every Studio on the app hears a landing, so a refused record leaves the others on the old build; written under the agent's grant, only a revoked grant refuses it. The landing is the platform's act, and who asked is recorded where they asked. It deletes a check the Resources plane skipped on our own server's say-so, which `pinnedAtDoor` was. Beat: keeping it, as [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) decided on 2026-10-13; and writing the record as the caller under their grant at landing, which a grant revoked mid-build refuses. |
| **A grant in a node's tree may gate an operation as well as a resource.** A node's grants define an audience, and the operation names the node and tier it requires, as `requireChatWrite` gates source by the chat node's `write`. | 2026-10-15 (Larry): one grant cannot diverge from itself, so whoever can post can change source by construction. `auth.md` says it, and the local principal's ADR commits it. Beat: a parallel permission for operations kept equal to the chat grant, which every invite, revoke and promotion would have to write twice. |
| **A write the agent makes for a person names the agent as actor**, stamped once where the loop dispatches a tool. | 2026-10-15 (Larry). A record carrying only the person names the one acted upon as the one who acted, which `auth.md` § *Attribution* calls worse than no record; and the undo `_ai-security.md` plans finds a bad turn's writes through their attribution, which needs the agent's writes told apart from the person's own. Beat: deleting `actor` and recording the agent's part once per turn, on its reply, which no write points to; and keeping `actor` with no caller. |
| **The agent meets every gate the chat floor guards, bounded by what runs as it.** | 2026-10-15 (Larry). Source lives in the Workspace's git tree, not in the org tree; `requireChatWrite` only uses the chat node's grant as the floor for reaching it, so source has no node of its own to move. Only server code runs as the agent, and its own turn is offered no tools; a source write or a `.dev` wipe under its claims would be traceable and reversible, which `calibration.md` §15 says needs no gate. Beat: a node of its own for source, with nothing in the tree to hang it from. |
| **A turn a reset kills is answered after the restart, not run again.** The agent's own turn reads the recent messages, its own included, decides what to address first, and asks whether to proceed; a yes runs as whoever sends it. The turn starts in memory when a turn ends, and only catching up after a restart schedules a Mesh alarm. | 2026-10-15 (Larry), replacing the master plan's 2026-10-14 design, which ran the killed turn again once but never said whom it acted as: a reset leaves no person's call to act in. The agent speaks only for itself, so anything more waits for a person's yes. Starting the turn in memory writes nothing, where an alarm at every turn's end would write a row each time, and storage writes are the dominant cost. Beat: running the turn again as the agent, on the verdict of the door the post passed, which acts on source with no live person; running it again as the poster from stored claims, which ADR-016 forbids; running it again under the poster's live token when her Studio reconnects, which needs a Studio entry and still asks when no tab is open; and a marker and alarm written when every turn starts. |
| **A post that arrives during a turn is held in memory with its poster's authority, and its turn runs as that poster.** A turn a person's post starts acts as that person; the agent's own turn writes nothing but its message. | 2026-10-11 (Larry), replacing 2026-10-10's turn that only talks. The hold is a continuation attached inside the poster's own call, the mechanism that already carries every turn past the end of its poster's call, so it borrows nobody's permissions. A request made mid-turn then acts on the first try, where a turn that only talks answered a quick yes by asking again. An eviction drops what is held, but it drops the running turn too, so holding adds no failure of its own. Beat: a turn the agent starts that only talks, which needs a second yes and acts for nobody; starting a held post's turn from the ending turn's `finally`, which runs it as the ending turn's poster; storing the held post's id, whose turn ran as the previous poster; replaying its stored acting token, which ADR-016 forbids as an authz input; and skipping the post, as today. |
| **The build comes in two steps, both in this file.** Step 1 runs held posts oldest first; step 2 adds the agent's own turn choosing the held posts to take up. | 2026-10-11 (Larry). Step 1 stands alone if step 2 proves fiddly, and step 2 is step 1 plus a choice, so nothing step 1 builds is unlearned. Beat: step 1 alone, which loses the agent choosing the order and answering several posts in one message, the way Larry describes the agent working; and step 2 alone, which builds the choice before the holding it chooses among is proven. |
| **Whether the agent answers at all is decided later, by a discriminator.** Until then every human post that arrives while no turn runs starts one, and every one that arrives during a turn is held. | 2026-10-10 (Larry): with pre-alpha's few users a turn per post is affordable, and the discriminator is a cost optimization. Fast-follow Item 6 holds it. |

## Review progress

Recorded as it happens, so a later session can pick up where this one stopped.

- **2026-10-15, `/review-task` Stage 1 launched** as workflow run `wf_14464a96-76d`, at Larry's request while he ran experiments, before his hand review of the Pass-1 prose. Its brief: rank premise and framing findings first and wording last; inform open questions 2, 3 and 5 without deciding them; challenge a settled decision only on a premise the code falsifies. The drafts made at this gate (ADR-025, the ADR-015 and ADR-016 edits, `auth.md`, two `workflow.md` index lines) were part of the review surface. Its synthesis lands below when it returns. If it never does, re-run Stage 1 from scratch: a workflow's cached results do not cross sessions.

- **2026-10-15, Stage 1 returned** (run `wf_14464a96-76d`): 57 raised, 56 survived, and all four lenses ran, none erroring. The one dropped finding was the two links to the archived build task, repointed while the run was going. A refutation rate this low means the reviewers checked against source, so the list is worth working item by item at the gate. Two items were applied at once, since each corrected a false statement and decided nothing: M1's wording in five places, and m3's two *Today's code differs* blocks, in ADR-016 and `auth.md`. Everything else waits for Larry's hand review and then the gate, S1 to S5 first, one per turn (`workflow.md` § *Teeing up decisions for Larry*).
- **2026-10-15, gate item 1 resolved (Larry): a turn a reset kills is answered after the restart, not run again** (§ *Decisions*). It settles S2's conflict with the master plan's 2026-10-14 design, which now points here. Larry also had `durable-objects.md`'s alarm rule qualified: counting attempts in storage is a situational option, not a default, since storage writes dominate the bill; so the agent's own turn starts in memory, and only catching up after a restart schedules a Mesh alarm. Gate order, re-evaluated: S1, M2, S3, M3, M8, then open questions 2, 5 and 3. S4's sequencing is the author's: personas waits on step 1, the local principal, the `chat` node and the claims helper, and step 2 builds after personas.
- **2026-10-15, the framing restarts as an `-alt`** ([nebula-agent-posts-as-itself-alt.md](nebula-agent-posts-as-itself-alt.md)). Working gate item 2, Larry rejected the premise that running a request under another person's token is itself a defect, a premise that entered as personas' second-pass blocker B1. He wants the agent to run a codegen turn under any token it holds and say whose, with one fence: an action that changes who can do what runs only under the token of someone who asked for it or said yes to it, so an Austen never reaches tenant Star data. The gate pauses here; this file is mined into the `-alt` once its prose is settled.

### Stage 1 findings, 2026-10-15

The 56 verified findings (26 major, 29 minor, 1 nit, no blockers) dedup to 35 items. The S items are framing or scope decisions to settle first. Some of them remove M items outright, and each M item says which S item affects it.


#### Structural decisions: rewrite, cut or defer

**S1. Decide whether a post can stay "left held" after every turn has ended. This one state causes most of the majors.**
- **Where:** § *Design intent* step 3 ("leave her post held until Jennifer replies"), the bullets "A post stays held until a turn takes it up" and "What is held lives in memory…", and open question 5(a).
- **What it costs if kept:**
  - Paid model calls repeat with no end (M4, and the left-held loop in S2).
  - Nothing keeps the hold in memory, so it is lost (M12).
  - The state has no stored home (M13).
  - Studio shows *failed* for a post that is only waiting (M14).
  - Open question 5(a) misjudges which posts are pending (M11).
- **(a) Delete it.** The agent's own turn answers in prose and holds nothing across an idle gap. A post that outlives every turn becomes pending only through catch-up. That costs a second yes. Per M12 the second yes is already paid whenever the wait passes the ~15-minute hold, so this is the honest trade.
- **(b) Pin all of it:**
  - where "left held" is stored, and the version bump that goes with it;
  - what keeps the Galaxy in memory while the post waits, and for how long;
  - that an agent turn's end never starts another agent turn;
  - that catch-up skips a left-held post;
  - what Studio shows for it;
  - an attempt bound.
- **Recommendation:** (a), per calibration §2, unless Larry values the "wait for Jennifer" case enough to pay for (b). Option (b) only keeps that case alive within the hold bound. Tee this up for Larry on its own.

**S2. Catch-up: one design in one home with a retry bound, or cut it.**
- **Sources:** scope-discipline ×2, spec-hygiene, prose-voice, product-vision.
- **Where:** § *What changes* New item 7; the § *Constraints* bullet on `durable-objects.md` § *Initialization*; the fourth bullet of § *Future state*; `tasks/nebula-pre-alpha.md` § *What remains*.
- **It loops with no bound, in three ways:**
  - A throw: `triggerAlarms`' catch deletes the row, the posts stay pending, and the next `onStart` schedules the turn again. That is one model call per wake.
  - A kill: if the job awaits the turn, the row survives, and `onStart`'s re-arm resets `retryCount`. That is the "loops forever" case in `durable-objects.md` § *A failed `alarm()` retries by one rule*, which says the handler MUST count attempts in storage before the work runs.
  - Under 5(a), a post left held stays pending, so it is retried on every wake.
- **The deferral is wrong.** § *Future state* says "Item 6 keeps the attempt cap", but fast-follow Item 6 has the cap only as a "Consider" bullet. The backlog row in § *Lumenize Mesh*, "Add retry + skip logic for alarm handler failures", is tripped by this task and has no disposition.
- **It conflicts with Larry's own row.** The 2026-10-14 row in the master plan (commit a3849d8), "A turn its Galaxy's reset cuts off runs again once, then says it stopped", designed under § *Turn-liveness heartbeat*, disagrees on three points:
  - It runs the killed turn again and acts. This file says the restarted turn "can only answer and ask", and under this file's model a re-run has nobody's claims to act under.
  - It arms an alarm when the turn starts. This file stores nothing until a turn ends.
  - It brings the cap into pre-alpha.
- **Fix:**
  - Fold the 2026-10-14 row into step 2 and reduce the master-plan row to a one-line pointer here.
  - Tee up one question for Larry: does a killed turn run again and act (and if so, as whom), or does it only answer and ask?
  - Count catch-up attempts durably, before each run, and after N attempts post an agent message saying it stopped.
  - Alternatively, fence catch-up out of this task until the cap exists.
  - Rewrite the § *Future state* bullet, and cite the backlog alarm row in § *Relationships*.

**S3. Release a lone held post directly instead of sending it through the agent's model judgment.**
- **Source:** product-vision.
- **Where:** § *Design intent* steps 2–3; the third bullet of § *Future state*; the `live.md` bullet in § *Constraints*; Goal 2.
- **Problem:**
  - A post that lands one second before a turn ends goes through the agent's judgment. The same post landing one second after starts its own turn directly.
  - Personas' quick yes is almost always the only held post, so it becomes probabilistic, and it sits on a `/live` limb that does not gate.
  - The post's own turn already reads the thread, Jennifer's open question included, and gets the new "ask before acting on what you were not asked" rule. One model call could do what currently takes two.
- **Fix:** make releasing a lone held post directly part of step 2, and keep the agent's own turn for two or more held posts and for catch-up. Otherwise, argue the timing difference in § *Decisions* and say how personas' quick-yes limb gates. If this is adopted, the drafted auth.md § *When the agent acts* needs the same edit.

**S4. Split what personas waits on, and mark the data-gated half.**
- **Source:** scope-discipline.
- **Where:** the first bullet of § *Relationships*; "Milestone" in § *Constraints*; New items 2, 6 and 7; row ② of the master plan.
- **Problem:**
  - Personas needs only step 1 plus items 1–3 and 8: the local principal, the claims helper, a held post run as its poster, and `deriveKind`.
  - It still waits on all of step 2, including open questions 2 and 5, which it never uses.
  - Moving `CHAT_NODE_ID` off the root and seeding the agent's grant are data-gated: existing Messages, root grants and `ServedBuild`s sit on the root. Row ② says `deploy`, and personas says it "rides the deploy, not the data".
- **Fix:**
  - In § *Relationships*, say that personas waits on step 1 plus items 1–3 and 8, and that step 2 may build after personas.
  - Mark the chat-node move and the grant seed as data-gated, before the ⑥ wipe, here and on row ②.

**S5. Rewrite the framing for the 2026-10-15 half.**
- **Source:** prose-voice.
- **Where:** § *Objective*; § *Context* ¶4 and its roadmap sentence; § *Goals*; the § *Design intent* paragraphs on the local principal and the chat node.
- **Problem:**
  - Objective, Context and Goals were written for the 10-11 design. No problem statement sits above several changes: the agent reading under a grant rather than with no check, retiring `pinnedAtDoor`, `ServedBuild` written as the agent, the actor stamp, and the chat node leaving the root.
  - The no-check-read story appears only in the Decisions "Beat:" column and in ADR-025.
- **Fix:**
  - Add a Context paragraph built on one literal: today `#recordServedBuild` passes `{ pinnedAtDoor: true }`, Snapshots skips `requirePermission`, the first fix proposed was a read with no check, and a grant on the root covers the whole tree.
  - Add a Goal for it and extend the Objective.
  - Name the local principal and the chat node in the roadmap sentence.
  - Lead the Design intent paragraph with the failed first attempt.


#### Major

✅ **Applied 2026-10-15.** **M1. The Goal 4 security property names the wrong moment: AsyncLocalStorage binds where a continuation is attached, not where the promise is created.**
- **Sources:** spec-hygiene, prose-voice, product-vision.
- **Where:** § *Context* ¶3 (~line 18), New item 4 (~46), § *Design intent* step 1 (~80), the § *Decisions* row on held posts (~160). The bullet at ~85 is ambiguous.
- **Problem:**
  - Verified in Node 24 and on workerd with compat date 2026-10-01: a `.then` attached at the release site runs as the releaser. So queueing `{ resolve, id }` and calling `runTriggeredTurn` from Jennifer's `finally` runs Austen's turn as Jennifer, while every sentence in the file is still satisfied.
  - Separately, if the held chain goes to `ctx.waitUntil` at post time, a turn released after a long wait gets only part of the 15-minute hold.
- **Fix:**
  - Reword all four places: "the continuation that runs the post's turn is attached inside the poster's call (in `#onChatCommitted`); the release site only resolves it." Show the three-line shape.
  - Add a criterion: Austen's held turn's `writeSource` commit line names Austen's `sub`. Mutation: attach at release, and the line names Jennifer.
  - Pin that a released turn gets its own `ctx.waitUntil` at release.

**M2. The claims helper's fresh-chain rule does not exist in Mesh, and it is wrong for personas.**
- **Sources:** spec-hygiene, scope-discipline, prose-voice.
- **Where:** New item 3; the asPersona bullet in § *Relationships*; § *Design intent*, "No client can post as the agent"; ADR-025's persona paragraph; ADR-015's added clause; auth.md § *How the claims travel*.
- **Problem:**
  - `buildOutgoingCallContext` (`packages/mesh/src/lmz-api.ts`) passes `originAuth` on unless `newChain` is set or no context exists. So "never leave the node" is unbuilt, and nothing tests it.
  - Personas needs its claims to travel. Its name writes go through Profile's `#requireOwnerOrAdmin` on another node, and the mutation on its criterion "A persona's claims stop at its own .dev Star" could never fail under a forced fresh chain.
- **Fix:**
  - The helper runs a block under claims it builds, and the caller chooses how the chain behaves. The agent's wrapper marks a fresh chain, enforced in `buildOutgoingCallContext`, which is listed under Adapted. `asPersona` carries its claims the way a tab's do.
  - Add a criterion: an `lmz.call` made under the agent's claims arrives with no `originAuth`.
  - Cite the backlog row "Mesh has no public seam for running in-DO code under a call context (2026-10-15)".

**M3. The deadline counts as a turn's end, so a hung turn starts a second turn beside it.**
- **Sources:** product-vision, prose-voice.
- **Where:** New items 5–6; § *What changes*, "Kept as they are: one turn at a time; the generation deadline".
- **Problem:**
  - `runTriggeredTurn` races `#chatTurn` against the 840 s deadline. Its `finally` clears `#turnInFlight` while `#chatTurn` keeps running.
  - If release hangs off that `finally`, posters' source writes interleave, and the abandoned turn's reply commits late.
- **Fix:**
  - Say which event releases a held post: the turn body settling, or the deadline.
  - If it is the deadline, say that the abandoned turn may still write and land.
  - If it is settling, say what bounds a hang: the 15-minute hold, or the backlog row "`callModel` has no timeout".
  - Move "the generation deadline" out of "Kept".

**M4. The trigger at a turn's end never stops.** (S1(a) removes most of this.)
- **Source:** spec-hygiene.
- **Where:** New items 5–7; the bullet "A post stays held until a turn takes it up"; open question 5.
- **Problem:**
  - The agent's own turn takes the latch, so its own end counts as "a turn ends and posts are held". With a post left held, that means one more model call per pass until Jennifer posts, plus one per wake through 5(a) and item 7.
  - A catch-up turn that finds the latch taken is dropped at `if (this.#turnInFlight) return`.
  - Item 6 does not say whether "release a named post" or "start the agent's turn" wins.
- **Fix:** one ordered rule in a named function, calibration §12 style:
  1. Release a post the latest agent turn named and has not yet released.
  2. Start the agent's turn for a held or pending post no agent turn has seen.
  3. Otherwise do nothing. An agent turn's own end never starts another.
- Add a criterion with a mutation: the agent leaves a post held; exactly one agent turn runs, and none after a forced rebuild.
- Do not copy "only posts newer than the agent's latest message": it strands a left-held post after an eviction, so derive that clause instead.

**M5. Alarm mechanics are unpinned, and the stated reason for the alarm is false.**
- **Source:** spec-hygiene.
- **Where:** § *Design intent* step 2 ("scheduled as an alarm due at once") and the bullet "When the Galaxy starts again".
- **Problem:**
  - "So that turn carries no one's claims" is false. The helper replaces the store under `AsyncLocalStorage.run`, and an alarm job has no call context, so it would need the helper anyway.
  - If the job awaits the turn, `triggerAlarms` runs jobs one at a time, so a 14-minute turn blocks every later job, the certificate alarm included.
  - `beforeTeardown` cancels only `CERTIFICATE_ALARM_ID`, and a deletion constructs every Galaxy it tears down.
- **Fix:**
  - At a turn's end, start the agent's turn in memory under the helper (`ctx.waitUntil`, the latch, the deadline).
  - Use the alarm only for catch-up: `onStart` only schedules it, and the job starts the turn detached and returns.
  - Cancel the catch-up alarm in `beforeTeardown`.

**M6. `onStart`'s pending check has no claims, and as worded it scans the whole thread on every wake.**
- **Sources:** product-vision, spec-hygiene.
- **Where:** New item 7; § *Design intent*, "When the Galaxy starts again, it catches up". This informs open question 5.
- **Problem:**
  - `doRead` → `Snapshots.read` → `requirePermission` reads `callContext`, which throws outside a call.
  - `#historyBundle` returns `{}` when there are no claims, so reusing it finds nothing pending and catch-up never runs.
  - A read with no check is what Decisions row 2 rejected and what ADR-025's tripwire forbids.
  - Option (a) parses every current Message, whose `codegen.toolCalls` carry whole files, inside `blockConcurrencyWhile` on every wake, teardown wakes included.
- **Fix:**
  - State that the check runs under the agent's built claims, through the same read path as its own turn.
  - Bound the scan to walk back from the newest Message to the last point where nothing was pending. Under 5(b), a stored set needs no claims.

**M7. Seeding the grant "as the root is" undoes every revoke.**
- **Sources:** spec-hygiene, scope-discipline.
- **Where:** New items 1–2; § *Design intent*, "The grant is visible and revocable".
- **Problem:**
  - `#ensureRoot` (`packages/resources/src/org-tree.ts:88`) is an `INSERT OR IGNORE` that runs on every construct, and Galaxy builds Resources on every wake. A grant seeded that way comes back on the next wake after `revokePermission` deletes it.
  - `setPermission` and `createNode` need admin under a call context, and `onStart` has none.
  - Seeding once behind a marker never reaches trees that already exist.
  - `chat` is not protected the way root is: delete, undelete and rename refuse only `ROOT_NODE_ID`, and `reparentNode` can move it.
- **Fix:**
  - Seed once at tree creation, behind a stored marker, and never ensure-on-construct for the grant.
  - Rely on the data gate (the wipe) for trees that already exist; see S4.
  - Say whether `chat` refuses delete, move and rename as root does.
  - Name tree initialization as the unchecked write in ADR-025; see m4.

**M8. A revoked agent grant leaves Studio half working, and nobody designed that state.**
- **Sources:** prose-voice, product-vision, spec-hygiene.
- **Where:** the bullets "The grant is visible and revocable" and "A landing is the platform's act"; the Decisions row "The agent is a local principal…"; ADR-025 § *Consequences*.
- **Problem:**
  - After a revoke, `#onChatCommitted` still starts turns, and each turn still edits source and lands builds as its poster.
  - `commitAgentMessage` throws, so the poster sees *failed* over work that landed.
  - The `ServedBuild` refusal is only logged, so other Studios stay on the old build.
  - No Studio surface reads `orgTree`, so "visible" is true only through the API.
- **Fix:**
  - Treat a revoked grant as "the agent is off": `#onChatCommitted` checks the agent's grant before starting a turn, and Studio says the agent is off for this app. That fits CLAUDE.md's "no foot-guns" and ADR-015's warning-not-refusal.
  - Alternatively, drop "revocable" as a selling point in the file and in ADR-025 until a surface and a defined behavior exist.
  - Either way, the bullet should name everything a revoke stops.

**M9. The agent's claims are never shown as a literal value, and the dominion check does read them.**
- **Source:** prose-voice.
- **Where:** New items 1 and 3; the local-principal paragraph in § *Design intent*; "Kept, with new callers".
- **Problem:**
  - `AuthClaims` requires `aud` and `access`.
  - `OrgTree.requirePermission` (`org-tree.ts:189`) runs `hasDominionOver(claims, hostName)` on every check, and it refuses the agent only because of `scopeAdmin: false`, a value the file never states.
  - `projectActingToken` records `access` and `aud` on every agent post.
- **Fix:**
  - Add one literal claims object for `agent:lumenize` in `acme.crm`, and say which fields are fixed and why.
  - Show the record on an agent post, and Jennifer's turn's commit line after the change.
  - Reword ADR-025's "Coarse-grained checks never see it" to "sees `scopeAdmin: false`".

**M10. The agent's own turn has no way to name a post, and `#historyBundle` cannot serve it unchanged.**
- **Sources:** spec-hygiene, product-vision.
- **Where:** "Kept as they are" (`#historyBundle`); the § *Design intent* bullet on reading the thread; item 6.
- **Problem:**
  - `posterLabel: labelFor(claims.sub)` labels `agent:lumenize` as "human N".
  - `renderHistoryBundle` prints no ids and no held state.
  - The turn is offered no tools, yet it must "name the held posts to take up".
- **Fix:**
  - Move `#historyBundle` to Adapted: no `posterLabel` for the agent's turn, plus a list of the held posts with ids.
  - Pin the take-up mechanism, for example one tool offered only to that turn, taking post ids and checked against the held set.
  - Alternatively, mark that limb exploratory with a concrete deliverable. Note the README's Exploratory tag is defined for vN phases.

**M11. Option 5(a)'s pending rule breaks when posts are taken up out of order.** This informs open questions 2 and 5 without deciding them.
- **Source:** product-vision.
- **Where:** open questions 2 and 5(a).
- **Problem:**
  - Austen's post B is held, and the agent asks Jennifer. Jennifer's answer C runs directly, and its reply, an agent message naming nothing, makes B stop counting as pending. Studio stops waiting, and catch-up never picks B up.
  - `replyOf` pairs one reply per `replyTo`, so open question 2's combined reply leaves the earlier posts looking unanswered.
- **Fix:**
  - Test the rule against out-of-order take-up before choosing (a), for example by counting only "named by a later agent message's `replyTo` or take-up list".
  - Give `#historyBundle` whatever pairing question 2's answer needs.

**M12. Nothing keeps a left-held post in memory.** (S1(a) removes this.)
- **Sources:** prose-voice, product-vision.
- **Where:** § *Design intent* step 3; the bullets "What is held lives in memory…" (~88–90); the Decisions row on held posts; Goal 2.
- **Problem:**
  - Only the running turn's `waitUntil` holds the Galaxy. The Clients' sockets are hibernatable, and idle eviction comes after roughly 70–140 s with no incoming event.
  - So three claims are false: "holding adds no failure of its own", "an eviction is the one case where a request made mid-turn costs a second yes", and Goal 2 as worded.
- **Fix:** limit the claim to posts held behind a running turn. Then either say what keeps a left-held post in memory and for how long, or accept the second yes.

**M13. "Took up" and "left held" have no stored home.** (Only matters under S1(b).)
- **Sources:** spec-hygiene, prose-voice.
- **Where:** the § *Design intent* bullet "Its record names … the posts it left held"; open questions 2 and 5.
- **Problem:**
  - `CHAT_MESSAGE_TYPES` has no field for either.
  - A named field means a `CHAT_MESSAGE_ONTOLOGY_VERSION` bump, which contradicts open question 2's "nothing about Message's stored shape changes". The values could instead ride `codegen.toolCalls[].args`.
- **Fix:** pin the home, show one literal agent message carrying it, and list the bump under Adapted if it is a field.

**M14. The waiting state shown in Studio depends on open question 5, so it is not "Studio's alone".**
- **Sources:** prose-voice, scope-discipline.
- **Where:** Adapted, "What Studio shows under a post that waits"; open question 5.
- **Problem:**
  - `App.vue` re-arms the idle window only on chunks whose `replyTo` is the viewer's post.
  - So a left-held post, or the agent's own turn, shows *failed* after `TURN_IDLE_MS` (90 s).
- **Fix:**
  - Limit "nothing on the server changes" to step 1.
  - Derive step 2's waiting state from the pending rule open question 5 settles.
  - Add a left-held post to the `/live` limb that asserts no *failed*.


#### Minor

**m1. The actor stamp has no named carrier, and `turnContext` loses its only reader.**
- **Sources:** spec-hygiene, scope-discipline, product-vision.
- **Where:** "Kept, with new callers"; "Removed".
- **Problem:**
  - `writeSource` is `@mesh(requireChatWrite)` and logs `projectActingToken(origin.claims)` with no actor, so an actor parameter there would reach the wire and could be forged.
  - `turnContext` (`galaxy.ts:152`) has one reader, at line 948, and this task makes that write unconditional.
- **Fix:** move the stamp to New. Name `turnContext` as its carrier and rewrite the JSDoc, or delete `turnContext`. Add a criterion: a turn's commit line carries `act: agent:lumenize`, and a direct `writeSource`'s line does not.

**m2. "A turn's authority is pinned at its post" overstates it.**
- **Source:** spec-hygiene.
- **Where:** the security.md bullet in § *Constraints*; § *Design intent*, "A held post's turn acts on the verdict…".
- **Problem:** Resources writes inside a turn, such as personas' invite tool, are checked live at Snapshots step 8.
- **Fix:** say that source writes and builds run on the post's verdict, and Resources writes are checked live.

✅ **Applied 2026-10-15.** **m3. The "Today's code differs" blocks in ADR-016 and auth.md are false.**
- **Sources:** spec-hygiene, scope-discipline.
- **Problem:** `#recordServedBuild` (`galaxy.ts:944–948`) already stamps `actor: NEBULA_SUB` on a turn's landing, and `served-build.test.ts:151` asserts it.
- **Fix:** "today the reply and a turn's landing `ServedBuild` carry the agent as actor; source commits do not."

**m4. ADR-025 claims more than the code does.**
- **Sources:** product-vision, scope-discipline.
- **Where:** ADR-025 § *Decision*, and its index line in `.claude/rules/workflow.md`.
- **Problem:**
  - Profile gates its writes with `#requireOwnerOrAdmin` and has no orgTree.
  - `Snapshots.liveValues`, `currentTypeName`, `findCurrentByField` and the grant seed (M7) are all unchecked reads or writes, so the tripwire "never skips the check on its own say-so" is already broken.
- **Fix:**
  - Limit the commitment to nodes that compose a Resources plane.
  - Limit the tripwire to reads and writes made on someone's behalf whose result reaches a person.
  - Name tree initialization and `liveValues` as the deliberate exceptions.

**m5. The test inventory is hand-written and incomplete.**
- **Sources:** all four lenses.
- **Where:** Adapted, "What asserts the old attribution"; Removed, `pinnedAtDoor`.
- **Missing:**
  - `chat-trigger.test.ts` T1, line 91 (`act` is `NEBULA_SUB`).
  - `chat-trigger.test.ts` T2: exactly one reply, which is the single-flight skip Goal 1 removes.
  - `child3-e2e.test.ts:81`.
  - `served-build.test.ts`, its record and verdict cases.
  - `source-chat-floor.test.ts` F5.
  - `resources-door.test.ts:382`.
- F5 and the verdict case would stay green on the agent's grant, so they need re-deriving rather than inverting.
- **Fix:**
  - Use a structural inventory per tasks/README § *Inventories*: `grep -rnE 'NEBULA_SUB|pinnedAtDoor|actingToken\.(sub|act)|deriveKind|deriveParticipants|single-flight' apps/nebula/test apps/nebula/harness`, saying which hits invert and which need re-deriving.
  - What they should prove after the change: revoke the poster mid-turn and the reply still lands; revoke the agent's grant and the record is refused.

**m6. § *Relationships* is missing links, and two backlog triggers are tripped.**
- **Sources:** spec-hygiene, scope-discipline.
- **Missing:**
  - The backlog row on Mesh's missing call-context seam: say whether this task absorbs it.
  - `apps/nebula/test/test-apps/dev-studio/as-caller.ts`: its reason for importing `runWithCallContext` dies with this task. Re-derive it under Adapted.
  - The archived `nebula-build-reaches-every-studio.md` owes a dated superseded banner. Assign it to the phase that removes `pinnedAtDoor`.
  - The backlog row "`Resources.ensureResource`'s create-if-absent guard has a live caller and no test" is tripped by the `opts` change and the rewrite of `commitAgentMessage`.
  - The alarm-retry row from S2.
- **Fix:** either fold in the `ensureResource` test (the message-commit path driven twice with one id) or record it as a residual and update the row.

**m7. Open question 3 is missing two inputs.**
- **Source:** spec-hygiene.
- **The two inputs:**
  - `participants.ts`'s invariant says display derives only from `meta.actingToken`. "Lumenize, re: Jennifer" reads `replyTo` from the value, which is safe only because no client can write an agent message.
  - In `child3-post.test.ts`'s depth-2 case, does "re:" still show the coach? Under open question 2's combined reply, "re:" names only the last poster.
- **Fix:** add both to the analysis without choosing an option.

**m8. The agent's own instructions have no home.**
- **Source:** product-vision.
- **Where:** the tool-contract bullet in Adapted.
- **Problem:**
  - `studio-guidance.md` gives each kind of guidance exactly one home. The Identity line and the new cross-turn rule live in `TOOL_CONTRACT` (`codegen-loop.ts:187`).
  - The file contradicts itself: take-up guidance is "in the tool contract", but the agent's own turn gets separate instructions.
- **Fix:** name the home (a section of `TOOL_CONTRACT` keyed by turn kind, or a new row in the table), and add a `studio-guidance.md` row to Adapted.

**m9. Some sites spell the root id directly, so following `CHAT_NODE_ID` misses them.**
- **Source:** prose-voice.
- **Problem:**
  - `message-roundtrip`, `broadcast-120-subscribers`, `claim-lifecycle` and `scope-teardown` post Galaxy Messages at `nodeId: ROOT_NODE_ID`, a placement production will no longer use.
  - The `CHAT_NODE_ID` JSDoc in `chat-constants.ts` goes stale.
- **Fix:** add `grep -rn ROOT_NODE_ID apps/nebula/harness`, say whether a Message posted off `chat` is refused or simply ignored, and add the JSDoc to Adapted.

**m10. Open question 6 and its Decisions row rest on a false clause.**
- **Source:** prose-voice.
- **Problem:**
  - The only `.dev` wipe, `Star.resetDevData` (`star.ts:110`), is behind `@mesh(requireDominionHere)`, not the chat floor, and the agent never holds dominion.
  - "Bounded by what runs as it" names a list the file never gives.
- **Fix:** drop the wipe clause, and list what runs under the agent's claims: `commitAgentMessage`, `#recordServedBuild`, its own turn's `#historyBundle` reads, and a result handler's outcome post.

**m11. Standing guidance the task contradicts is not on Adapted.**
- **Sources:** scope-discipline, product-vision.
- **Problem:**
  - `docs/vision/_ai-security.md` § *Level 2* ("stores who asked") and § *Attribution* ("Every read rides the asking human's token", which also appears in the ADR-019 index line).
  - `strategy.md` check 1 ("never broader default access").
  - Fast-follow Item 6 still describes the 10-10 turn that had no tools.
- **Fix:**
  - List the vision passages under Adapted. They are rough drafts, so this does not block.
  - Edit fast-follow Item 6 directly at this gate.

**m12. Six settled open questions are still listed.**
- **Sources:** spec-hygiene, product-vision.
- **Problem:** questions 1, 4, 6, 7, 8 and 9 read "Settled 2026-10-15". Two Decisions rows cite "question 8" and "this file's first draft of question 1".
- **Fix:**
  - Delete the six, and do not renumber 2, 3 and 5: the archived file at `nebula-build-reaches-every-studio.md:290` cites "open question 4", and this review cites 2, 3 and 5.
  - Make the two Decisions rows stand alone.

**m13. Archaeology, and drafted edits that read as work still to do.**
- **Sources:** spec-hygiene, prose-voice.
- **Problem:**
  - § *Context* ¶4 retells the 10-10 → 10-11 sequence.
  - Adapted's auth.md bullets say "gains", but the uncommitted diff already has those edits, and one bullet does not parse on a first read.
- **Fix:**
  - State the model without dates.
  - Point at the existing dated line in § *Review progress* for the drafted doc edits.
  - Keep under Adapted only what a phase changes.

**m14. The rejected names for "local principal" are not recorded where the term lives.** ADR-025 § *Terminology* already names both; what remains is a do-not-reintroduce line.
- **Source:** prose-voice.
- **Problem:** *service principal* and *tree principal* appear only in the Decisions row, which archives with the task file.
- **Fix:** carry them into ADR-025 § *Terminology* with a do-not-reintroduce line, as ADR-015 does.

**m15. The same points are restated several times.**
- **Source:** prose-voice.
- **Problem:** the local principal is stated in item 1, Design intent and two Decisions rows. "Started from `finally` runs as Jennifer" appears in four places. The catch-up appears twice, the auth.md summary twice, and the gating twice.
- **Fix:**
  - Give each point one home, per `/write-task` Pass 1.
  - Keep the Design intent bullet on the held continuation, reworded per M1.


#### Nit

**n1. The Status line carries an expired note.**
- **Source:** prose-voice.
- **Problem:** the note "Drafted while its sibling … was in review" and three dates.
- **Fix:** cut them. Keep the one-line gating verdict in Status, and shrink the § *Relationships* row instead.


#### Biggest risks

1. Goal 4 is worded so that the natural implementation runs Austen's held turn as Jennifer (M1). The shared helper's fresh-chain rule is both missing from Mesh and wrong for personas (M2).
2. Step 2's "left held" state and the uncapped catch-up cause most of the majors: model calls paid on every wake, a hold that is silently lost, and Studio showing *failed*. Personas currently waits on all of it (S1, S2, S4).
3. Two ways to grant the agent, both wrong: seeded on construct, a revoke never sticks; once revoked, Studio keeps changing the app with no reply and no landing record (M7, M8).
