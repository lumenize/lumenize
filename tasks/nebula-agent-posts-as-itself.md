# The agent posts to the chat as itself

**Status:** Pass 1, drafted 2026-10-11 for Larry's read and reshaped the same day to hold posts that arrive mid-turn; phases not written. Split out of [nebula-testing-with-personas.md](nebula-testing-with-personas.md) at its third Stage 1 gate; it builds after [nebula-star-ontology.md](nebula-star-ontology.md) and gates personas. Drafted while that file is in review, a deliberate exception to writing one child task file at a time, because the design was worked out with Larry on 2026-10-10. Decided then: the agent posts as itself, and a turn a person's post starts acts as that person. Decided 2026-10-11: a post that arrives mid-turn is held with its poster's authority, built in two steps.

## Objective

**Every message the agent puts in the chat is its own, and a post that arrives while the agent is busy keeps its poster's authority until the agent gets to it.**

## Context

**How a turn works today.** Studio posts a human `Message` to the Galaxy's chat node, and the Galaxy's post-commit hook, `#onChatCommitted`, starts a turn. The turn runs inside the poster's own call, so it reads, writes source and builds with that person's permissions. Its reply commits with the poster as the subject and the agent, `agent:lumenize`, as the actor, which is why Studio's byline reads *Lumenize for Jennifer*. One turn runs at a time: a post that arrives while one runs, behind the in-memory `#turnInFlight` flag, starts nothing and sits in the thread unanswered.

**Two people in one chat make that skipped post common, and the personas task needs two things it cannot do.**

- **A yes that arrives too soon is lost.** The agent asks before it provisions, and a quick yes can land while the asking turn is still committing its reply.
- **An outcome has nobody to post as.** Provisioning's result arrives in a Galaxy handler on a chain the Galaxy started, which carries nobody's claims. A write there throws in `Snapshots.#buildActingToken`, whose `projectActingToken` reads `claims.sub` off `undefined`.

**Where a held post's turn starts decides whose permissions it runs with.** A turn can do nothing without a human's permissions. Started from the ending turn's `finally`, a held post's turn runs inside the ending turn's call: Austen's held request to invite a Galaxy admin would run as Jennifer, and succeed. Started from a promise created inside Austen's own call when her post commits, it runs as Austen, the way every turn already keeps running as its poster after the poster's call has returned.

**On 2026-10-10 Larry decided the agent posts as itself, and on 2026-10-11 that a post arriving mid-turn is held.** The agent's messages need nobody's permissions, so it can post an outcome, or answer people from a turn of its own, with no person's call to post in. A held post keeps its poster's authority in memory, and its turn acts as that poster when it runs. `docs/vision/auth.md` § *When the agent acts* was amended on 2026-10-10: when the agent writes, it writes as the person whose post started the turn; when it talks, it posts as itself.

The rest of this file covers what changes, how a held post is run, the two steps the build comes in, catching up after a restart, and five questions still open.

## Goals

1. **A post never goes unanswered because the agent was busy, or because the Galaxy restarted.** Today it waits for someone to post again.
2. **A request made while the agent is busy acts on the first try.** Today it is never acted on unless its poster asks again.
3. **The agent can post when no person's call is there to post in:** an outcome from a result handler, or a message from a turn it started. Today such a write throws.
4. **A turn acts only as the person whose post started it.** Today that holds only because a late post starts nothing; a held post's turn started from the ending turn's call would break it.
5. **The chat still shows whom the agent answered.** Today the byline gets that from the reply's subject, which becomes the agent.

## Relationships

- **It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, whose provisioning outcome and admin-invite outcome are agent posts, and whose confirmation relies on a quick yes being acted on.
- **Nothing open gates it.** It builds after [nebula-star-ontology.md](nebula-star-ontology.md) in the order personas' § *Relationships* gives.

## What changes

**New:**

1. **The agent as a message's subject.** Snapshots takes a subject the server supplies, `agent:lumenize` with no `act`, beside the actor it supplies today. Only `commitAgentMessage` can supply it, and the message it writes passes no permission check.
2. **A held post.** When `#onChatCommitted` skips a post because a turn is running, it holds the post: a promise created inside the poster's own call, which runs the post's turn when the Galaxy releases it. The hold lives in Galaxy memory only.
3. **Held posts run oldest first (step 1).** When a turn ends, the Galaxy releases the oldest held post, and its turn runs as its poster through the same latch.
4. **The agent's own turn (step 2).** When a turn ends and posts are held, the Galaxy instead starts a turn of its own on a fresh chain. It reads the thread, posts what it has to say, and names the held posts to take up; the Galaxy releases those one at a time.
5. **Catching up when the Galaxy starts (step 2).** `onStart` looks for posts still pending, and if it finds any, schedules the agent's own turn. It covers what an eviction drops: the held posts, and the post whose turn the eviction killed.
6. **A message is the agent's when its subject is the agent**, or, as today, when its outermost `act` is. `deriveKind` in `participants.ts` reads only `act` today, so an agent post would read as human and get a turn that answers itself.

**Adapted:**

- **`commitAgentMessage`** writes the agent as the subject, without the `actor` and `pinnedAtPost` options it passes today.
- **`#onChatCommitted`** still starts one turn at a time; a post it skips is now held, and a turn's end releases one or starts the agent's own turn.
- **Studio's byline and avatar stack**, which `App.vue` builds from `deriveParticipants`' list of the subject and the `act` chain, joined with *for*.
- **What Studio shows under a post that waits.** `App.vue` resets a post's 90 s idle window only on chunks replying to that post, so a post waiting behind another person's turn shows *thinking…*, then *failed*. The comment there justifies it by saying a skipped post is never answered, which this task makes false. `deriveTurnDisplay` gains a waiting state, held while another post's turn streams. The change is Studio's alone; nothing on the server changes for it.
- **The tool contract in `codegen-loop.ts`**, which gains the rule that the agent addresses the person and asks before acting on anything it was not asked directly. The agent's own turn gets instructions of its own, since the contract's first rule tells the model to act with tools that turn is not offered.
- **`security.md`'s bullet on a turn's authority**, which says the reply commits under the verdict pinned at the post. The reply no longer needs it, and a held post's turn carries the verdict pinned at its post through the wait.
- **`docs/vision/auth.md` § *When the agent acts***, amended on 2026-10-10, whose sentence on the turn the agent starts gains taking up a held post.
- **What asserts the old attribution:** `four-party-chat`, which checks the reply's `act.sub` is the agent and its `sub` the poster; `child3-post.test.ts`; and `first-app-built`'s fourth limb. Each inverts, which `calibration.md` §3(b) says to expect.

**Removed:** `pinnedAtPost` in `TransactionOpts`, whose only production caller is `commitAgentMessage`.

**Kept as they are:** a turn a person's post starts, which runs inside their call exactly as today; one turn at a time; and the generation deadline.

## Design intent

**A message's author is whoever wrote it, and the agent writes its own.** Jennifer asks the agent to add due dates to deals. The turn her post starts runs as her: its source edits and its build are hers. Its reply is the agent's own message, with `replyTo` naming her post.

**A post that arrives mid-turn keeps its poster's authority until a turn runs it.** Jennifer's turn is building when Austen posts *"can the due date default to next Friday?"*.

1. **Austen's post starts no turn, because one is running, so `#onChatCommitted` holds it.** The hold is a promise created inside Austen's own call, so whatever it later runs, runs as Austen. Her Studio shows the post waiting its turn, for example *"Lumenize will get to this after the current turn"*, rather than *thinking…*, and shows no *failed* while Jennifer's turn is still streaming.
2. **When Jennifer's turn ends, the Galaxy decides what runs next.** In step 1 it releases the oldest held post, Austen's. In step 2 it starts the agent's own turn on a fresh chain, scheduled as an alarm due at once, so that turn carries no one's claims; the ending turn's `finally` still runs inside Jennifer's call, which is why it is not started there.
3. **In step 2, the agent's own turn reads the thread and decides.** It sees that Jennifer's turn ended by asking her whether a due date is required, and that Austen's change does not depend on the answer. So it tells Jennifer it is starting on Austen's change while it waits, and takes Austen's post up. It could as well answer Austen in prose and leave her post held until Jennifer replies.
4. **Austen's post's turn runs as Austen**, through the latch like any turn: its source edits and its build are hers, and its reply's `replyTo` names her post.

- **A held promise's continuation runs in the call it was created in, whoever releases it.** The Galaxy releases Austen's held post from the end of Jennifer's turn, inside Jennifer's call, and her turn still runs as Austen. Every turn already rests on the same property: its awaits resume as the poster, though the I/O that resumes them belongs to no call.
- **Taking up a held post needs no further yes**, because the post is its poster's own request. The agent asks only when a post was not a request to it, such as a remark to another person. That is guidance in the tool contract, not a check.
- **The agent's own turn writes nothing but its message.** It is not offered the loop's tools, which run in-process past their decorators and check no claims, so in a turn with nobody's authority they would write as nobody. Its one power is taking up a held post, which runs as that post's poster. Its record names the posts it took up and the posts it left held, which is how a test sees what it did.
- **A post stays held until a turn takes it up**, so the agent can leave one for a later turn's end, after Jennifer answers, say. In step 1 each is taken up in turn.
- **What is held lives in memory, and the only thing stored is the alarm that starts the agent's own turn.** The running turn holds the Galaxy in memory while posts wait behind it (`ctx.waitUntil`, up to 15 minutes from the turn's start). An eviction drops the held posts together with that turn, so holding adds no failure of its own.
- **When the Galaxy starts again, it catches up** (Larry, 2026-10-11). `onStart` finds the posts still pending, Austen's held one and Jennifer's, whose turn died with the eviction, and schedules the agent's own turn. Their authority went with the memory, so that turn can only answer and ask: it tells Jennifer her turn was interrupted and what landed, and asks Austen *"Should I proceed?"*. An eviction is the one case where a request made mid-turn costs a second yes.
- **A held post's turn acts on the verdict its post's door check gave**, as every turn does (`security.md`). A grant revoked while Austen waits does not stop her turn, just as one revoked mid-turn does not stop a running one.

**The build comes in two steps, both in this file.** Step 1 holds skipped posts and runs them oldest first, each as its poster, with no turn of the agent's own. Step 2 adds the agent's own turn, which chooses the held posts to take up and answers in prose where nothing should run yet. Step 2 is step 1 plus that choice, and it carries catching up after a restart too, since only the agent's own turn can answer a post whose authority is gone.

**An agent message needs no permissions, and only server code can write one.** A client's transaction has no argument naming its subject or actor, so no client can post as the agent; `commitAgentMessage` is the one writer. An outcome from a result handler, such as provisioning's, is an agent message whose `replyTo` is the post that confirmed it, carried through the continuation as data.

**`deriveKind` reads the subject in the same change that makes the agent one.** Otherwise the agent's first post as itself reads as human, gets a turn of its own, and the agent answers itself forever.

## Constraints

- **`docs/vision/auth.md` § *When the agent acts***: the agent writes as the person whose post started the turn, and talks as itself.
- **[ADR-003](../docs/adr/003-continuation-messaging.md)**: the agent's own turn starts on a chain of its own, and a result handler's outcome travels as data in a continuation. A held post waits on the Galaxy's own latch, never across a hop, so no node holds a reply open for another.
- **`durable-objects.md` § *No mutable instance state***: a held post is an ephemeral cache whose loss is acceptable, since losing it leaves the post in the thread for `onStart` to find.
- **`durable-objects.md` § *Initialization***: a Mesh node's `onStart` runs inside `blockConcurrencyWhile` on every wake, a hibernation wake included, so the check there only reads and schedules. It schedules the agent's own turn as an alarm with a fixed id, so repeated wakes do not stack turns, and that turn takes the latch like any other.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md)**: an agent message changes no authority and destroys nothing, so it owes no record; what a turn does as a person still records that person.
- **`security.md`**: a turn's authority is pinned at the post that started it, a held post's included, and no client can name an actor or a subject.
- **`studio-guidance.md`**: asking before acting on what the agent was not asked directly is cross-turn policy, so it lives in the tool contract.
- **`live.md`**: a `/live` scenario first. Holding a post and running its turn as its poster are deterministic and gate; which held posts the agent's own turn takes up is the model's judgment, and rides a limb that does not.
- **`calibration.md` §12**: whatever decides when Studio stops showing *thinking* lives in a named function, as `deriveTurnDisplay` does.
- **Milestone:** pre-alpha, after [nebula-star-ontology.md](nebula-star-ontology.md) and before the personas task.

## Future state

- ⚠️ Design consideration: **a discriminator decides whether the agent answers at all.** Fast-follow Item 6 starts it with Cloudflare's Clef. It plugs in at two points, a post arriving and a turn ending, and this task builds the second as the agent's own turn.
- ⚠️ Design consideration: **the agent hands long work to sub-agents and stays the chat's supervisor** (Larry, 2026-10-10). Its turns then stay short, so a held post waits seconds rather than minutes, and each sub-agent runs under the authority of the held post it serves.
- ⚠️ Design consideration: **when exactly one post is held, step 2's turn is an extra model call before it.** If that latency shows, the Galaxy can release a lone held post directly, as step 1 does.
- ⚠️ Design consideration: **catching up after a restart is the first half of fast-follow Item 6's lease per turn.** Item 6 keeps the attempt cap, for an agent turn that dies before it answers and so finds the same posts pending on every wake.
- **Steering a turn while it generates** stays in fast-follow Item 6.

## Open questions

1. **What may the agent's own turn read? (step 2)** Today `#historyBundle` returns nothing when the call carries no claims, and every read of a `Message` checks a permission by `sub`, so the turn as specified cannot read the thread it is meant to answer.
   - **(a) The chat thread only, read by the server with no permission check.** Every `Message` sits on the one chat node, so anyone who can read one can read them all, and the reply lands in that same thread: it shows nobody anything they could not already read. It reads no app data and no source, so its proposals rest on the conversation alone.
   - **(b) Read under a held post's authority.** Every agent read then stays on a person's token. A held post is at hand when a turn ends, but not when the Galaxy catches up after a restart, when nothing is held, so that turn needs (a) anyway. The hold also has to run a read as well as a turn, and it reads exactly what (a) reads.
   - **(c) Read nothing.** Post a fixed message asking each waiting poster to repeat themselves or say go.
   - **Recommendation: (a).** Catching up after a restart needs it either way, and it reads what (b) reads with no mechanism. It is the first agent read with no person's token, which the consent model in `docs/vision/_ai-security.md` otherwise rules out; the thread being its own audience is what makes it the exception, and that rests on every `Message` sitting on one chat node, to be checked again if threads ever get nodes of their own.
2. **One reply from the agent's own turn, or one per post it answers? (step 2)** A post the agent takes up gets its own turn's reply. Studio stops showing a post as waiting when a reply whose `replyTo` is that post lands (`replyLanded` in `App.vue`), so one combined reply settles only one poster's Studio.
   - **Recommendation:** one reply, with `replyTo` the latest post it answers, and Studio stops waiting for a post when an agent message lands whose `replyTo` is that post or a later one. Jennifer's reply, whose `replyTo` is her own earlier post, then leaves Austen waiting. One reply reads like a person answering two people at once, and nothing about `Message`'s stored shape changes.
3. **What does the byline say once the agent is the subject?** Today *Lumenize for Jennifer*, built from the subject and the `act` chain.
   - **Recommendation:** *Lumenize, re: Jennifer*, naming the author of the post in `replyTo`, so the chat keeps showing whom the agent answered. Beat: *Lumenize* alone, which drops it.
4. **Does `ensureResource`'s `actor` option stay?** `commitAgentMessage` is its only production caller, so after this task nothing passes it.
   - **Recommendation:** keep it. `docs/vision/auth.md` describes an agent write on a person's behalf as *this human, via the agent*, and the first agent tool that writes a resource, rather than source, needs exactly that stamp.
5. **How does the Galaxy know which posts are still pending? (step 2)** `onStart`'s check needs it, and so does Studio, to know when to stop showing a post as waiting.
   - **(a) Derive it from the thread.** A human post is pending while no agent message's `replyTo` is that post or a later one, the rule question 2 recommends, and also while the agent's latest message names it as left held. One rule then serves `onStart`, the end of a turn, and Studio.
   - **(b) Store which posts have been processed**, a set the Galaxy writes as it takes up or answers each post.
   - **Recommendation: (a).** The thread already records every reply and, through the agent's own message, every post it left held, so a stored set would be a second copy of what the thread says, owing a way to stay in step with it ([ADR-010](../docs/adr/010-random-opaque-keys.md)'s replication rule).

## Decisions

Started at the Pass 1 gate; only settled rows.

| Decision | Why, and what it beat |
|---|---|
| **The agent posts to the chat as itself.** Every agent message names `agent:lumenize` as its subject, with no `act`; only `commitAgentMessage` can write one, and it passes no permission check. | 2026-10-10 (Larry), amending `docs/vision/auth.md` § *When the agent acts*, which had the agent only ever an actor. That section's objection was to a login, which grants authority that then has to be confined; this confines one thing, a chat post. Beat: the poster as every agent message's subject, as today, which leaves an outcome and the agent's own turn nobody to post as; and the agent as subject only in its own turns, which makes two shapes of agent message. |
| **A post that arrives during a turn is held in memory with its poster's authority, and its turn runs as that poster.** A turn a person's post starts acts as that person; the agent's own turn writes nothing but its message. | 2026-10-11 (Larry), replacing 2026-10-10's turn that only talks. The hold is a promise created inside the poster's own call, the mechanism that already carries every turn past the end of its poster's call, so it borrows nobody's permissions. A request made mid-turn then acts on the first try, where a turn that only talks answered a quick yes by asking again. An eviction drops what is held, but it drops the running turn too, so holding adds no failure of its own. Beat: a turn the agent starts that only talks, which needs a second yes and acts for nobody; starting a held post's turn from the ending turn's `finally`, which runs it as the ending turn's poster; storing the held post's id, whose turn ran as the previous poster; replaying its stored acting token, which ADR-016 forbids as an authz input; and skipping the post, as today. |
| **The build comes in two steps, both in this file.** Step 1 runs held posts oldest first; step 2 adds the agent's own turn choosing the held posts to take up. | 2026-10-11 (Larry). Step 1 stands alone if step 2 proves fiddly, and step 2 is step 1 plus a choice, so nothing step 1 builds is unlearned. Beat: step 1 alone, which loses the agent choosing the order and answering several posts in one message, the way Larry describes the agent working; and step 2 alone, which builds the choice before the holding it chooses among is proven. |
| **Whether the agent answers at all is decided later, by a discriminator.** Until then every human post that arrives while no turn runs starts one, and every one that arrives during a turn is held. | 2026-10-10 (Larry): with pre-alpha's few users a turn per post is affordable, and the discriminator is a cost optimization. Fast-follow Item 6 holds it. |
