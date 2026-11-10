# High levels of agent agency in the agent loop

**Status:** Pass 1, settled 2026-11-10 (Larry), after an `-alt` reframe begun 2026-10-15 replaced the first framing; phases not written. Larry reviewed it lightly, since real users will change it fast. It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md), and nothing gates it.

## Objective

**Give the agent enough agency to keep making progress towards the chat participants goals no matter the situation while still satisfying certain security requirements.** In response to a single participant's chat message is the most obvious condition. The next level of complexity involves two participants talking collaborating on the same goal. After that comes multiple participants focused on competing goals. Then there are anomoulous situations, like when an AI call times out, the Galaxy restarts unexpectedly or awakens from hibernation. The agent may hit the tool call limit or some other constraint. Under all these conditions, the agent must be able to assess the situation and do something. We still want actions taken by the agent to be secure in particular ways. For instance, it must not be able to access tenant Star data without doing so under clear authority of a participant with that authority and only under a token that shows the chat participant as the `sub` and the agent as the `act`.

## Context

Our philosophy on agent agency is the [Manifesto for AI Agency](../docs/vision/manifesto.md): seven "X over Y" lines, each argued in the doc it names. [`_ai-security.md`](../docs/vision/_ai-security.md) argues most of them, though it is a rough draft and already behind Larry's latest thinking, and [`auth.md`](../docs/vision/auth.md) has the details of who may do what. Three points from those lines bear on this task directly:

- **Every prior state is kept, but nothing restores one yet.** The temporal data model keeps every state a resource has been in. Git keeps every committed state of code and file-based configuration. No tool rolls either back yet.
- **Attribution has to survive a group chat.** Every resource change and every git commit is attributed to a chat participant. When it is unclear who in a group chat instructed the agent, the chat it judged from sits on the same timeline as the changes, if nothing ties them more explicitly.
- **This task builds the innermost feedback loop.** Its feedback is the difference between the participants' latest goals and the current implementation, and its output is the next change to the codebase. A second loop around it comes later, improving the app's standing guidance: its skills, workflows, rules, vision documents and ADRs.

## Conventions

A list that other sections cite gives each item a prefixed ID: `DI` for an item of design intent, `D` for a decision, and `Q` for an open question. IDs follow the order items were raised, not the order shown, and are never reused, so D2 is the second decision made wherever its row sits, and a gap such as Q1 is a question answered. A decision that answers an open question records it, as D1's "(was Q2)" does.

A step's claims are written *Jennifer + agent* for `{ sub: <Jennifer's sub>, act: { sub: 'agent:lumenize' } }`.

## Scenes

The scenes about people live in [agent-first-ui.md](../docs/vision/agent-first-ui.md) § *Scenes*, where they outlive this task. This section maps each of them to the claims every step runs under, so § *Design intent* can be measured against them. It also holds the failure scenes, which test the loop itself and die with this task.

> **Today's code differs.** A post that arrives mid-turn starts nothing and waits for someone to post again (`#onChatCommitted` in `apps/nebula/src/galaxy.ts`). A turn's reply commits with the poster's claims and the agent as actor. The generation deadline posts nothing: it releases the single-flight latch, and the turn keeps running. A turn an eviction kills is answered only if someone posts again.

### Austen joins

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Tries Austen's two questions | Austen + agent | Austen asked. **Refused** by passage into each tenant Star: her plain membership in the app reaches upward, not down. |
| Answers them | Jennifer + agent | Jennifer said yes to (a), and her Universe admin membership holds dominion over every tenant Star from the app's host. The call answers Jennifer's post, so it runs under her claims (DI5). The answer is her disclosure decision. |

### Two people, one goal

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Builds the "Shared with me" section | Jennifer + agent | Jennifer asked. Her `write` on the `chat` node is the floor for source and builds. |
| Keeps Austen's post waiting | Austen's, held in memory | Her post's own call carries them (DI2). |
| Builds who-shared-each-list | Austen + agent | Austen asked, and she meets the same floor. |

If the Galaxy is evicted between the two builds, Austen's claims go with it, and her post is answered as in § *The Galaxy restarts mid-turn*.

### Two people, different goals

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Sorts by when items were added | Jennifer + agent | Jennifer asked. |
| Holds back Austen's change | — | The agent's judgment: the two asks conflict. |
| Builds the sort switch | Jennifer + agent | Both said yes, and Jennifer answered last. Austen's claims would serve as well, and the agent names the ones it used. |

### Austen asks to invite a friend

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Makes the section collapsible | Jennifer + agent | Jennifer asked. |
| Tries to invite Riley | Austen + agent | Austen asked. **Refused**: only an admin of the app can invite someone into it, and Austen is a plain member. |
| Never hands the invite Jennifer's held claims | — | DI5: the invite answers Austen's post, so the Galaxy gives it Austen's claims, not Jennifer's. |
| Invites Riley | Jennifer + agent | Jennifer said yes, and her dominion over the app allows the invite. ADR-016 records the full claims. |

### Failure scenes

The same format as the people scenes: Studio's chat, with what happens out of sight in italics.

#### The model stops answering

**Jennifer:** Add a "recently bought" list that fills itself from completed items.

**Studio's agent:** *(thinking... codegen...)*

*The model call hangs. Fourteen minutes into the turn, the generation deadline ends it.*

**Studio's agent:** I didn't finish: the model stopped answering partway through. Anything I'd already written is still in the source, but nothing new is built. Shall I pick it up again?

**Jennifer:** Yes.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she said yes. *(codegen...)* Done: completed items now move to a "recently bought" list.

The post after the deadline is the agent's own (DI3) and answers Jennifer's post (DI6), so no catch-up starts. The model cannot write it, since the model is what hung (Q3). The retry runs under the claims Jennifer's yes brought.

#### The Galaxy restarts mid-turn

*Jennifer asks for a "recently bought" list and closes her laptop. Mid-turn, a deploy restarts the Galaxy, and the turn dies with it. Nothing wakes the Galaxy until Austen opens Studio the next morning.*

**Studio's agent:** Jennifer, I was interrupted while adding the "recently bought" list you asked for yesterday. Part of it may be in the source. Shall I pick it up?

**Austen:** Yes, go ahead. Jennifer and I talked about it.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she said yes. *(codegen...)* Done: completed items now move to a "recently bought" list.

The restart took Jennifer's claims (DI2). Austen's page wakes the Galaxy, and its wake finds Jennifer's post unanswered and schedules a catch-up (DI7). The catch-up runs with no call context, so it holds no participant's claims and can only post. Austen's yes brings her claims, and the work runs under them, though Jennifer asked for it.

#### Waking after a night away

*Last evening the agent asked Jennifer whether completed items should disappear after a week. She didn't answer, everyone left, and the Galaxy hibernated. No alarm is pending, because every post had an answer. In the morning Austen posts first.*

**Austen:** Make the add-item box bigger on phones.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she asked. *(codegen...)* Done: the add-item box fills the width on phones. Jennifer, my question from last night is still open: should completed items disappear after a week?

Austen's post wakes the Galaxy and brings her claims. Nothing carried over in memory, and nothing needed to: the agent read last night's question from the thread. Austen's post didn't answer it, so the agent reminds Jennifer rather than choosing.

#### The step limit

**Jennifer:** Let shoppers reorder items by dragging them.

**Studio's agent:** *(thinking... codegen...)*

*The agent uses all 32 of its steps for the turn, and its last build still fails.*

**Studio's agent:** I ran out of steps for this turn before the build passed. The last one failed compiling `ListView.vue`. Shall I keep going?

**Jennifer:** Keep going.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she said to keep going. *(codegen...)* Done: the build passes, and items can be dragged into a new order.

The post at the limit is the agent's own, and "keep going" is a new yes that brings Jennifer's claims again.

## Relationships

- **It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, whose provisioning outcome and admin-invite outcome are the agent's own posts (DI3), and whose confirmation needs a quick yes acted on (DI2). Personas needs the agent as a local principal, the claims helper, the `chat` node, held claims and `deriveKind`; decision points and catch-up may build after it.
- **Part of it changes stored data,** so it rides ⑥'s wipe: moving the chat off the root and seeding the agent's grant move existing `Message`s, grants and `ServedBuild`s, which sit on the root today. Row ② of the master plan carries the `data` gate for it.
- **Nothing open gates it.**
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md) (Proposed) commits what it builds on:** a node's orgTree as its one fine-grained access control, operations included, and the local principal. `docs/vision/auth.md` § *When the agent acts* states the model.
- **Personas' `asPersona` reuses the claims helper this task adds to Mesh,** which builds the seam the backlog's *Mesh has no public seam for running in-DO code under a call context* row asks for. `apps/nebula/test/test-apps/dev-studio/as-caller.ts` imports `runWithCallContext` for the same reason and is re-derived when the helper lands.
- **It replaces a decision of [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)**, that a landing records its `ServedBuild` under `pinnedAtDoor` (D5). That archived file gets a dated superseded banner when `pinnedAtDoor` goes.
- **Catch-up trips the backlog's *Add retry + skip logic for alarm handler failures* row,** which Q3 takes up.

## What changes

**New:**

1. **The agent as a local principal of the Galaxy (D4).** `agent:lumenize` holds `write` on the `chat` node, seeded once when the tree is created and never re-ensured on construct: `#ensureRoot`'s `INSERT OR IGNORE` runs on every wake and would undo a revoke. Mesh builds its claims, which carry `aud: 'acme.crm'` in the Galaxy `acme.crm` and no `scopeAdmin`, so `hasDominionOver` reads them on every orgTree check and finds nothing.
2. **A `chat` node of its own** under the root, at a fixed id as the root is, which `CHAT_NODE_ID` names. The harness sites that post Galaxy `Message`s at `ROOT_NODE_ID` move with it (`grep -rn ROOT_NODE_ID apps/nebula/harness`), and the `CHAT_NODE_ID` JSDoc in `chat-constants.ts` changes.
3. **Running a block under claims Mesh builds**, for an identity with no Registry membership. The caller chooses how the chain behaves: the agent's wrapper starts a fresh chain, enforced in `buildOutgoingCallContext`, which today passes `originAuth` on unless `newChain` is set, while `asPersona` carries its claims as a tab's do.
4. **Held claims (DI2).** `#onChatCommitted` attaches, inside the poster's call, the continuation that later uses that post's claims, and whatever releases it only resolves it. Each piece of work it starts gets its own `ctx.waitUntil`.
5. **A decision point (DI7).** When a turn ends, the agent reads the thread and decides what to take up. Each tool call names the post it answers, and a call DI5 covers gets that post's claims from the Galaxy.
6. **Catch-up (DI7).** `onStart` reads the posts after the agent's latest message, under the agent's built claims and through the same read path as its own reads. Only if one is unanswered does it schedule a catch-up through `svc.alarms`, with a fixed id so repeated wakes do not stack. The job starts the decision detached and returns, so it never holds up the certificate alarm, and `beforeTeardown` cancels it.
7. **`deriveKind` in `participants.ts` reads the subject (DI3)**, in the same change that makes the agent one. Otherwise the agent's first post as itself reads as human, gets a turn, and the agent answers itself forever.

**Adapted:**

- **`commitAgentMessage`** writes under the agent's claims, without the `actor` and `pinnedAtDoor` options it passes today.
- **`#recordServedBuild`** writes as the agent (D5), and **`buildNow`** logs its caller's claims through `projectActingToken`, as `writeSource` logs each commit.
- **`#historyBundle`** reads under the agent's claims at a decision point, labels the agent as itself rather than as a numbered human, and shows each post's id and whose claims are held.
- **Studio's byline and avatar stack,** which `App.vue` builds from the subject and the `act` chain (Q4).
- **Studio's waiting state.** `deriveTurnDisplay` gains *waiting*, held while another post's turn streams, and a post stops waiting when an agent message follows it (DI6). Today `App.vue` resets a post's 90 s idle window only on chunks replying to that post, so a waiting post shows *thinking…*, then *failed*, under a comment saying a skipped post is never answered.
- **The tool contract, `TOOL_CONTRACT` in `codegen-loop.ts`,** gains the rules for several people: say whose claims it is using, answer every post before it, and ask before acting on what it was not asked.
- **`security.md`:** the bullet on the verdict of the door that admitted the work loses the reply and the `ServedBuild`, which become the agent's own writes. What stays is that a turn's source writes and builds run on its post's verdict, while a Resources write inside a turn is checked live. The rule that no synthetic claims go into a chain a node started names the agent's built claims beside the persona's.
- **Standing guidance to re-check at build:** `_ai-security.md` § *Attribution*'s "Every read rides the asking human's token" and § *Level 2*, `strategy.md`'s check 1, the ADR-019 index line in `workflow.md`, and fast-follow Item 6.
- **What asserts the old attribution:** `grep -rnE 'NEBULA_SUB|pinnedAtDoor|actingToken\.(sub|act)|deriveKind|deriveParticipants|single-flight' apps/nebula/test apps/nebula/harness`. Most hits invert, as `calibration.md` §3(b) expects; `source-chat-floor.test.ts` F5 and `served-build.test.ts`'s verdict case stay green on the agent's grant, so they are re-derived instead.

**Removed:** `pinnedAtDoor` in `TransactionOpts`, and the check Snapshots skips for it (D5).

**Kept, with new callers:** the `actor` a write carries, stamped once where the loop dispatches a tool (D6). `turnContext` carries it, and its JSDoc is rewritten. A direct `writeSource` call's commit line carries no actor.

**Kept as they are:** one turn at a time, and the generation deadline (Q3).

## Design intent

- **DI1.** Give the agent a tool that allows it to make any `lmz.call()` but only if it has a user token, it attaches itself as the `act` for that token, and only if it has clear authority from the user. It need not know the user's permissions before attempting the call on their behalf. If that call is denied for a lack of permission, it will need to adjust for instance, by asking a user who it believes has that permission if it's OK to satisfy that user who lacks it's permission. In which case, it attempts the call under that new person's token.

- **DI2. The agent holds a participant's claims only in memory, while it answers their post.** They arrive with the post's call and leave when the post is answered or the Galaxy is evicted. They are never stored, since a stored scope set is a security bug ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)). So the agent can hold several participants' claims at once, one per post it is answering (D1), and holds none after a restart. The claims stay with the post because AsyncLocalStorage binds where a continuation is attached, not where its promise is created: attached at the release instead, Austen's work would run as Jennifer.
- **DI3. The agent posts as itself:** `{ sub: 'agent:lumenize' }`, with no `act`, on its own `write` grant on the `chat` node ([ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)). The scene tables leave those steps out.
- **DI4. Everything else it does runs as *participant + agent*,** under the claims of a participant who asked for it or said yes when the agent proposed it. Which held claims to use is the agent's judgment (D1), except where DI5 decides.
- **DI5. A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post the agent is answering (D2).** The Galaxy picks those claims, not the model. A tenant Star is any Star under the Galaxy but `.dev`, which the call's target scope shows. The calls that change who can do what are the ones [ADR-016](../docs/adr/016-record-the-acting-principal.md) already has record the full claims. The check still refuses claims that lack the permission, as it refuses Austen's for tenant data.
- **DI6. Every decision ends with a post that answers every post before it.** So the next decision never finds a post already answered, and a recovery that dies again cannot loop. A person's post stops waiting, in Studio and for catch-up, once an agent message follows it.
- **DI7. A post wakes the Galaxy, and a turn's end is a decision point.** Any other wake reads the thread for unanswered posts and schedules a catch-up through `svc.alarms` only if it finds one. Which posts are answered is read from the thread, never written per turn.

## Constraints

- **The whole chat is read every turn, so what changes goes last.** Until the agent has a memory, each turn reads the chat in full. Keeping what changes at the end of the prompt lets the model provider's prompt cache reuse everything before it.
- **`docs/vision/auth.md` § *When the agent acts*:** the agent writes as a person who asked or said yes, and talks as itself.
- **[ADR-003](../docs/adr/003-continuation-messaging.md):** work waits on the Galaxy's own latch, never across a hop, and a result handler's outcome travels as data in a continuation.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md):** an agent message changes no authority and destroys nothing, so it owes no record; work done as a person records that person, with the agent as actor.
- **`durable-objects.md` § *No mutable instance state*:** held claims are an ephemeral cache, since losing them leaves the post in the thread for catch-up.
- **`durable-objects.md` § *Initialization*:** `onStart` runs inside `blockConcurrencyWhile` on every wake, so it only reads and schedules.
- **`security.md`:** no client can name an actor or a subject.
- **`calibration.md` §14:** the agent's authority is a grant in the tree, never a membership in the Registry.
- **`studio-guidance.md`:** the rules for several people are cross-turn policy, so they live in `TOOL_CONTRACT`.
- **`live.md`:** a `/live` scenario first. What is deterministic gates: claims held with their post, DI5's binding, catch-up's scheduling. Which post the agent takes up first is its judgment, and rides a limb that does not gate.
- **`calibration.md` §12:** whatever decides when Studio stops showing a post as waiting lives in a named function, as `deriveTurnDisplay` does.
- **Milestone:** pre-alpha, before personas.

## Future state

- **Threads, which are sessions and branches.** The agent will encourage moving a piece of work into a thread. Unlike a thread in Discord or Slack, its first post is the agent's: a compacted summary of what in the main chat bears on the work, so the session starts with the context it needs.
- **A memory the main chat and every thread share.** What the agent learns about who can do what is a natural first thing to keep there.
- **A discriminator decides whether the agent answers at all.** Fast-follow Item 6 starts it with Cloudflare's Clef. It plugs in where a post arrives and where a turn ends.
- **Sub-agents do long work, and the chat agent stays the supervisor** (Larry, 2026-10-10). Its turns stay short, so a waiting post waits seconds rather than minutes, and each sub-agent runs under the claims of the post it serves.
- **A lone waiting post could skip the decision's model call** and run directly, if that call's latency shows.
- **Steering a turn while it generates** stays in fast-follow Item 6.

## Open questions

- **Q3. How does the loop recover when a turn fails?** Deferred until the multi-player happy path is settled (Larry, 2026-10-16). What it has to answer:
  - **Who writes the post that ends the turn** when the model call hangs, or the turn uses all 32 of its tool-call rounds. The model cannot, so our own code must, with a fixed message or one more short model call.
  - **Which event frees the latch.** Today the 14-minute deadline frees it while the turn keeps running, and the abandoned turn may still write and land.
  - **What bounds a catch-up that dies before it posts.** Each wake would try again.
  - **How catch-up finds work the agent announced but never finished.** In § *Two people, one goal*, "Done, Jennifer" is an agent message after Austen's post, so if the Galaxy is evicted during Austen's build, her post looks answered.
- **Q4. What does the byline say once the agent is the subject?** Today it reads *Lumenize for Jennifer*, built from the subject and the `act` chain. Recommendation: *Lumenize, re: Jennifer*, naming the author of the post in `replyTo`; *Lumenize* alone drops whom it answered. Two inputs: `participants.ts` says display derives only from `meta.actingToken`, while `replyTo` lives in the value, safe only because no client can write an agent message; and in `child3-post.test.ts`'s depth-2 case, "re:" must still show the coach.
- **Q5. What happens when an admin revokes the agent's grant?** As drafted, Studio half works: turns still start and land builds, the agent's reply throws, so the poster sees *failed* over work that landed, and the refused `ServedBuild` only logs. Recommendation: a revoked grant means the agent is off for the app. `#onChatCommitted` checks the grant before starting work, and Studio says so.
- **Q6. Does the `chat` node refuse delete, move and rename, as the root does?** Today only `ROOT_NODE_ID` is refused, and `reparentNode` can move any other node. Recommendation: yes, since the node carries the conversation's audience.

## Decisions

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | The agent may hold several participants' claims at once, in memory and never in storage. It knows whose claims it holds, picks the best ones for the work, or asks the person whose claims it should use (Larry, 2026-10-16). (was Q2) Learning who can do what is less trial and error than it looks: every member of a Star can see who holds which grant in its tree ([ADR-008](../docs/adr/008-full-org-tree-visibility.md)), and the claims the agent holds say what each holder may do, since passage and dominion are computed from them. What it cannot read is the admin bit of someone whose claims it does not hold. | **Each piece of work runs under its own poster's claims, and nobody else's** (rejected 2026-10-15): the agent could not proceed under Jennifer's authority when Austen's claims are gone, and running a request under another person's claims is not in itself a defect. |
| D2 | A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post the agent is answering, and the Galaxy, not the model, picks them. Everything else keeps D1's free choice (Larry, 2026-11-10). (was Q1) The check is hard on every call between nodes either way (Larry, 2026-10-16). This is prevention where the manifesto's Reversibility line keeps it, on what cannot be undone: a disclosure cannot be taken back, and an authority change can lead to one. What it removes is only the crossover, Austen's request carried out with Jennifer's power; misreading what Jennifer herself wanted remains, as in any one-person chat. | **Judgment alone, with attribution as the backstop**: a line from Austen, or one planted in `AGENTS.md`, could steer Jennifer's held claims toward Austen's request, and the Objective's "must not be able to" would become "is told not to". **Binding every call to the post it answers**: the same loss as D1's rejected alternative. |
| D3 | The agent posts to the chat as itself: every agent message names `agent:lumenize` as its subject, with no `act`, and only server code runs under its claims (Larry, 2026-10-10). | **The poster as every agent message's subject**, as today: an outcome, and a decision the agent makes on its own, have nobody to post as. **The agent as subject only in its own turns**: two shapes of agent message. |
| D4 | The agent is a local principal of the Galaxy: `write` on a `chat` node of its own under the root, no Registry membership, and its reads and posts pass the same DAG check as anyone's (Larry, 2026-10-15). The grant shows in the tree, an admin can revoke it, and it covers the conversation and nothing a later node beside it holds. | **A server read with no check**, confined to the chat by hand: a second read path every later rule skips. **A Registry membership**: the login `auth.md` objects to, with passage and dominion to confine. **`read` alone**: leaves a post's check skipped. **The chat on the root**: a chat-floor grant would cover everything the tree ever holds. |
| D5 | A landing's `ServedBuild` is the agent's write, under its grant on `chat`, and `pinnedAtDoor` goes; `buildNow` logs its caller's claims (Larry, 2026-10-15). Every Studio on the app hears a landing through that record, and only a revoked grant refuses it. | **Keeping `pinnedAtDoor`**, as [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) decided on 2026-10-13: a check the Resources plane skips on our own server's say-so. **Writing the record as the build's caller**: a grant revoked mid-build refuses it, and other Studios stay on the old build. |
| D6 | A write the agent makes for a person names the agent as actor, stamped once where the loop dispatches a tool (Larry, 2026-10-15). A record carrying only the person names the one acted upon as the one who acted, and undoing a bad turn finds its writes by that attribution. | **Recording the agent's part once per turn, on its reply**, which no write points to. **Keeping `actor` with no caller.** |
| D7 | The agent meets every gate the chat floor guards, bounded by what runs under its claims: its posts, a landing's `ServedBuild`, its reads of the thread, and a result handler's outcome post (Larry, 2026-10-15). Source lives in the Workspace's git tree, and `requireChatWrite` only borrows the chat node's grant as its floor. | **A node of its own for source**, with nothing in the tree to hang it from. |
| D8 | A turn a reset kills is answered after the restart, not run again. The agent reads the recent messages, decides what to address, and asks whether to proceed; a yes runs as whoever sends it. A decision starts in memory when a turn ends, and only catch-up schedules an alarm (Larry, 2026-10-15). | **Running the killed turn again as the agent**, on its post's verdict: it acts on source with no live person. **Running it again from the poster's stored claims**: ADR-016 forbids stored claims as an authz input. **A marker and an alarm written as every turn starts**: storage writes are the dominant cost. |
| D9 | Whether the agent answers at all is decided later, by a discriminator; until then every person's post is answered (Larry, 2026-10-10). | **Building the discriminator now**: with pre-alpha's few users a turn per post is affordable, and the discriminator is a cost optimization (fast-follow Item 6). |

## Review progress

- **2026-10-15:** `/review-task` Stage 1 ran against the first framing (run `wf_14464a96-76d`). When this file replaced that framing on 2026-11-10, its findings were carried into the sections above or retired by the new design; git keeps them at `277c313`. Stage 1 should run again on this framing before phases are written.
