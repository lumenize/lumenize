# High levels of agent agency in the agent loop

**Status:** Pass 1, settled 2026-11-10 (Larry), with both Stage 1 gates applied; Pass 2 drafted 2026-11-11; ready for Stage 2. Everything in it but the wake check gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md) (D13); the wake check follows the wipe, in fast-follow, once Q3 is decided (D19). Nothing gates it.

## Objective

**Give the agent enough agency to keep making progress towards the chat participants' goals no matter the situation while still satisfying certain security requirements.** In response to a single participant's chat message is the most obvious condition. The next level of complexity involves two participants collaborating on the same goal. After that comes multiple participants focused on competing goals. Then there are anomalous situations, like when an AI call times out, the Galaxy restarts unexpectedly or awakens from hibernation. The agent may hit the tool call limit or some other constraint. Under all these conditions, the agent must be able to assess the situation and do something. We still want actions taken by the agent to be secure in particular ways. For instance, it must not be able to access tenant Star data without doing so under clear authority of a participant with that authority and only under claims that show the chat participant as the `sub` and the agent as the `act`.

## Conventions

A list that other sections cite gives each item a prefixed ID: `DI` for an item of design intent, `B` for a blocker in today's code, `D` for a decision, `Q` for an open question, and `F` for a review finding. IDs follow the order items were raised, not the order shown, and are never reused, so D2 is the second decision made wherever its row sits, and a gap such as Q1 is a question answered. A decision that answers an open question records it, as D1's "(was Q2)" does.

Three terms stay apart. An **access token** is the signed JWT a Client holds, and only Mesh's auth layer mints one. **Claims** are what a node reads from `callContext.originAuth`, which every `lmz.call` in a chain inherits unchanged. **Recorded claims** are what a write stores: the claims at the moment of the write, projected and kept as history, never read back as an authorization input ([ADR-016](../docs/adr/016-record-the-acting-principal.md)). Live claims are never stored. Today's field is `actingToken` (D10). A step's claims are written *Jennifer + agent* for `{ sub: <Jennifer's sub>, act: { sub: 'agent:lumenize' } }`: the claims of a chain the agent starts for Jennifer, never an access token.

These words name a turn's lifecycle (D12):

- **A turn takes up one post.** A post at an idle Galaxy starts a turn that takes it up. Only one turn runs at a time, except that a turn the generation deadline cut off may still be running (TEMP → Q3, item 5).
- **A decision is the first step of a turn the agent starts itself,** when a turn ends with posts still waiting. It reads the thread under the agent's own claims and picks which waiting post to take up; from the pick on, the turn runs inside that post's held call. With nothing waiting, nothing more runs.
- **A closing step ends a turn when posts arrived while it ran.** The loop appends them last and asks for the turn's final message with no loop tools offered, so that message can answer them too (D18).
- **A post is answered when an agent message names it** in `answers`. *"Done, Jennifer: the lists page opens with a 'Shared with me' section."* answers Jennifer's post and not Austen's, though it follows both.
- **A post's claims are released when the turn that posted its answer ends,** or when the Galaxy is evicted.
- **A post is waiting while no agent message names it in `answers`.** Item 9's function decides it, for Studio, for a decision and for the wake check. After an eviction a post can be waiting with no held call.
- **A post's held call is the call that brought it,** which the Galaxy keeps in memory while the post waits (item 4).
- **A wake check runs when a wake finds a waiting post.** It schedules a turn through `svc.alarms` that holds no claims, so it reads, answers and asks (item 6). A decision differs: it runs when a turn ends with posts still waiting, and takes one up inside its held call.

## Context

Our philosophy on agent agency is the [Manifesto for AI Agency](../docs/vision/manifesto.md): seven "X over Y" lines, each argued in the doc it names. [`_ai-security.md`](../docs/vision/_ai-security.md) argues most of them, though it is a rough draft and already behind Larry's latest thinking, and [`auth.md`](../docs/vision/auth.md) has the details of who may do what. Three points from those lines bear on this task directly:

- **Every prior state is kept, but nothing restores one yet.** The temporal data model keeps every state a resource has been in, and git every committed state of code and file-based configuration, but no tool rolls either back. DI5 binds three kinds of call to the post their turn took up: a read of a tenant Star's data and a change to who can do what, because neither can be undone, and a write to a tenant Star's data, because it acts on the app's users with one person's permissions.
- **Attribution has to survive a group chat.** Every resource change and every git commit is attributed to a chat participant. When it is unclear who in a group chat instructed the agent, the chat it judged from sits on the same timeline as the changes, if nothing ties them more explicitly. D6 and D15 tie them.
- **This task builds the innermost feedback loop.** Its feedback is the difference between the participants' latest goals and the current implementation, and its output is the next change to the codebase. A second loop around it comes later, improving the app's standing guidance: its skills, workflows, rules, vision documents and ADRs.

Today's code falls short in four ways:

- **B1. A post that arrives mid-turn starts nothing,** and waits for someone to post again (`#onChatCommitted` in `apps/nebula/src/galaxy.ts`). Items 4 and 5 remove it.
- **B2. A turn's reply commits with the poster's claims and the agent as actor,** so the agent has nothing to post as when no person's call is there. Item 1 and the adapted `commitAgentMessage` remove it.
- **B3. The generation deadline posts nothing.** It releases the single-flight latch, and the turn keeps running. Q3 removes it; until then item 5 fences it.
- **B4. A turn an eviction kills is answered only if someone posts again.** The first build answers it at that next post, through the decision after that post's turn; the wake check (item 6) answers it as soon as the Galaxy wakes, after the wipe (D19).

§ *Scenes* maps what each person sees to the claims behind it, § *What changes* lists the work, and § *Design intent* says what the work must keep true.

## Scenes

The scenes about people live in [agent-first-ui.md](../docs/vision/agent-first-ui.md) § *Scenes*, where they outlive this task. This section maps each of them to the claims every step runs under, so § *Design intent* can be measured against them. It also holds the failure scenes, which test the loop itself and die with this task. Every row of § *Austen asks to invite a friend* runs on this build. § *Austen joins* needs a tool that reads a tenant Star, which no task adds yet (DI1). Of the failure scenes, § *Waking after a night away* and § *The tool-call limit* run on the first build; § *The model stops answering* and § *The Galaxy restarts mid-turn* wait on Q3 (D19).

### Austen joins

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Tries Austen's two questions | Austen + agent | Austen asked. **Refused** by passage into each tenant Star: her plain membership in `acme.crm` gives passage upward from `acme.crm` and none into `acme.crm.tenant1`. |
| Answers them | Jennifer + agent | Jennifer said yes to (a), and her Universe admin membership holds dominion over every tenant Star from `crm.acme.lumenize.dev`, the app's host. The call's turn took up Jennifer's post, so it runs under her claims (DI5). The answer is her disclosure decision. |

### Two people, one goal

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Builds the "Shared with me" section | Jennifer + agent | Jennifer asked. Her `write` on the `chat` node is the floor for source and builds. |
| Keeps Austen's post waiting | Austen's, held in memory | Her post's own call carries them (DI2). |
| Builds who-shared-each-list | Austen + agent | Austen asked, and she meets the same floor. |

If the Galaxy is evicted before Austen's post is answered, her claims go with it, and the wake check finds her post waiting, since "Done, Jennifer" names only Jennifer's. It is then answered as in § *The Galaxy restarts mid-turn*.

### Two people, different goals

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Sorts by when items were added | Jennifer + agent | Jennifer asked. |
| Holds back Austen's change | — | The agent's judgment: the two asks conflict. Jennifer's closing step reads Austen's post, and its one message answers both (D18). |
| Answers Austen's "(c) works for me" and waits | — | Her post starts a turn at an idle Galaxy. The change needs both yeses, so it builds nothing, and its message, "Thanks, Austen. I'll build it once Jennifer agrees.", answers her post. |
| Builds the sort switch | Jennifer + agent | Both have said yes. Jennifer's "Agreed" starts the turn, or, if it lands while Austen's turn runs, the decision after that turn takes it up. If it lands before Austen's turn reads the thread, that turn sees both yeses and builds at once, and the line above never appears. |

### Austen asks to invite a friend

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Makes the section collapsible | Jennifer + agent | Jennifer asked. |
| Asks Jennifer instead of inviting | — | Jennifer's closing step reads Austen's request and sees in the tree that Austen holds no admin on the app ([ADR-008](../docs/adr/008-full-org-tree-visibility.md)), so its message answers Austen's post and asks Jennifer. |
| Never hands the invite Jennifer's held claims | — | The closing step that read Austen's request is offered no loop tools (D18), so nothing in Jennifer's turn can invite. |
| Invites Riley | Jennifer + agent | Jennifer said yes, and her dominion over the app allows the invite. ADR-016 records the full claims. |

If the closing message leaves Austen's post unanswered instead, a decision takes it up, tries the invite under *Austen + agent*, is refused, because only an admin of the app can invite someone into it, and asks Jennifer.

### Failure scenes

The same format as the people scenes: Studio's chat, with what happens out of sight in italics.

#### The model stops answering

**Jennifer:** Add a "recently bought" list that fills itself from completed items.

**Studio's agent:** *(thinking... codegen...)*

*The model call hangs. Fourteen minutes into the turn, the generation deadline ends it.*

**Studio's agent:** I didn't finish: the model stopped answering partway through. Anything I'd already written is still in the source, but nothing new is built. Shall I pick it up again?

**Jennifer:** Yes.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she said yes. *(codegen...)* Done: completed items now move to a "recently bought" list.

The post after the deadline is the agent's own (DI3) and answers Jennifer's post (DI6), so no later decision takes her post up again. The model cannot write it, since the model is what hung (Q3). The retry runs under the claims Jennifer's yes brought.

#### The Galaxy restarts mid-turn

*Jennifer asks for a "recently bought" list and closes her laptop. Mid-turn, a deploy restarts the Galaxy, and the turn dies with it. Nothing wakes the Galaxy until Austen opens Studio the next morning.*

**Studio's agent:** Jennifer, I was interrupted while adding the "recently bought" list you asked for yesterday. Part of it may be in the source. Shall I pick it up?

**Austen:** Yes, go ahead. Jennifer and I talked about it.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she said yes. *(codegen...)* Done: completed items now move to a "recently bought" list.

The restart took Jennifer's claims (DI2). Austen's page wakes the Galaxy, and its wake finds Jennifer's post unanswered and schedules a wake check (DI7). Its turn runs with no call context, so it holds no participant's claims and can only post. Austen's yes brings her claims, and the work runs under them, though Jennifer asked for it.

#### Waking after a night away

*Last evening the agent asked Jennifer whether completed items should disappear after a week. She didn't answer, everyone left, and the Galaxy hibernated. No alarm is pending, because every post had an answer. In the morning Austen posts first.*

**Austen:** Make the add-item box bigger on phones.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she asked. *(codegen...)* Done: the add-item box fills the width on phones. Jennifer, my question from last night is still open: should completed items disappear after a week?

Austen's post wakes the Galaxy and brings her claims. Nothing carried over in memory, and nothing needed to: the agent read last night's question from the thread. Austen's post didn't reply to it, so the agent reminds Jennifer rather than choosing.

#### The tool-call limit

**Jennifer:** Let shoppers reorder items by dragging them.

**Studio's agent:** *(thinking... codegen...)*

*The agent uses all 32 of its tool-call rounds (`maxToolDepth`) for the turn, and its last build still fails.*

**Studio's agent:** I ran out of steps for this turn before the build passed. The last one failed compiling `ListView.vue`. Shall I keep going?

**Jennifer:** Keep going.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she said to keep going. *(codegen...)* Done: the build passes, and items can be dragged into a new order.

The post at the limit is the agent's own, and "keep going" is a new yes that brings Jennifer's claims again.

## Relationships

- **It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, whose provisioning outcome is the agent's own post (DI3), and whose confirmation needs a quick yes acted on (DI2). Personas needs everything here but the wake check, above all held claims and the decision that takes them up. The wake check waits (D19).
- **Part of it changes stored data,** so it rides ⑥'s wipe: moving the chat off the root and seeding the agent's grant move existing `Message`s, grants and `ServedBuild`s, which sit on the root today. Row ② of the master plan carries the `data` gate for it.
- **It takes personas' item 9,** the invite rule, the `.dev` co-mint cleanup and the agent's `invite` tool (D11). Personas keeps `provision`.
- **It carries what personas' item 11 and its *The turn trigger* and *The agent's reply* bullets planned,** in this file's shape: claims Mesh builds (item 3), `deriveKind` (item 7), and turns that take up a waiting post with tools (D12, D14).
- **It builds most of the backlog's *Nebula as permission broker in chat* row:** a refusal as the person, a yes from someone who holds the permission, and acting on that yes under their claims. What stays open there is a tool that reads a tenant Star, and offering to upgrade the person instead.
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md) (Proposed) commits what it builds on:** a node's orgTree as its one fine-grained access control, operations included, and the local principal. `docs/vision/auth.md` § *When the agent acts* states the model.
- **Personas' `asPersona` reuses item 3's claims helper.** It does not build the backlog's *Mesh has no public seam for running in-DO code under a call context* row's test seam, since neither of item 3's forms builds a synthetic admin's claims, and that row's reason, a landing recording its `ServedBuild` under the caller's claims, goes with D5. `apps/nebula/test/test-apps/dev-studio/as-caller.ts` is re-derived at build against what still reads a direct call's claims, `buildNow`'s claims log and D15's git author; if nothing does, it and the row go.
- **No skipped test in another lane waits on it,** checked 2026-11-11.
- **It disposes of the backlog's *Undo a bad turn's writes* row's open question of how a turn's writes are found:** by the agent in their recorded claims' `act`, D15's `toolCalls` entries, and the turn's time window.
- **It replaces a decision of [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)**, that a landing records its `ServedBuild` under `pinnedAtDoor` (D5). That archived file gets a dated superseded banner when `pinnedAtDoor` goes.
- **The wake check's repeat on every wake is Q3's to bound, not the backlog's *Add retry + skip logic for alarm handler failures* row's.** The wake check's job starts its turn detached and returns, so `triggerAlarms` deletes the alarm row before the turn can fail, and a count kept per row restarts on every wake.

## What changes

**Renamed first (D10), in one sweep with its standing guidance, so the tree never names both.** The items after it name today's symbols.

- **Code:** `actingToken` becomes `recordedClaims`: the `Snapshots` column, the `meta` field and the Registry's log field. `ActingTokenRecord` becomes `RecordedClaims`, `WireActingToken` becomes `WireRecordedClaims`, `projectActingToken` becomes `toRecordedClaims`, `toWireActingToken` becomes `toWireRecordedClaims`, and `#buildActingToken` becomes `#buildRecordedClaims`. The `actingClaims` parameters in `auth-registry.ts`, which hold live claims, become `callerClaims`. The pre-alpha wipe recreates the column, so it needs no migration.
- **Standing guidance and other live text:** every non-archived file the checks below list, among them ADR-004, ADR-012, ADR-016 (whose naming bullet reverses), `auth.md`, `_ai-security.md`, `security.md`'s reader list, `workflow.md`'s ADR-016 line, the master plan's ⑥ inventory, and `website/docs/nebula/api-reference.md`, after which the platform embed is regenerated. The prose phrase "acting token" becomes "recorded claims" where it names the record, and stays where it means a real access token, as in ADR-016's line on an action that establishes a session.
- **The checks, over non-archived files:** a symbol grep, `git grep -n -E 'actingToken|ActingToken|actingClaims' -- ':!tasks/archive'`, finds only dated history; a prose grep, `git grep -n -i -E 'acting[- ]token|token of the post' -- ':!tasks/archive'`, finds only uses that mean an access token.

**New:**

1. **The agent as a local principal of the Galaxy (D4), seeded by the Galaxy (D21).** `agent:lumenize` holds `write` on the `chat` node. Mesh builds its claims, which carry `aud: 'acme.crm'` in the Galaxy `acme.crm` and no `scopeAdmin`, so `hasDominionOver` reads them on every orgTree check and finds nothing.
   - **The Galaxy declares the two rows when it builds its Resources:** `{ nodes: [{ nodeId: CHAT_NODE_ID, parentNodeId: ROOT_NODE_ID, slug: 'chat', label: 'Chat' }], grants: [{ nodeId: CHAT_NODE_ID, sub: NEBULA_SUB, tier: 'write', protected: true }] }`. A Star declares nothing.
   - **`OrgTree`'s `#ensureRoot` becomes `#ensureSeed`,** which creates the root and the host's declared rows with `INSERT OR IGNORE`, so a wake writes nothing once they exist. This extends the Resources plane's constructor, and fast-follow Item 2's app-branded assistant reuses it.
   - **`OrgTree` refuses `revokePermission`, and a `setPermission` that lowers it, for a grant its host marks protected** (D16).
   - **No person's grant is seeded.** The owner reaches the tree through dominion, and a collaborator gets a grant by invite.
2. **A `chat` node of its own** under the root, at a fixed id as the root is, which `CHAT_NODE_ID` names and item 1's seed creates; today `CHAT_NODE_ID` is the root. The harness sites that post Galaxy `Message`s at `ROOT_NODE_ID` move with it (`grep -rn ROOT_NODE_ID apps/nebula/harness`), and the `CHAT_NODE_ID` JSDoc in `chat-constants.ts` changes.
3. **Running a block under claims, in two forms.** Today `newChain: true` starts a chain with no `originAuth` (`buildOutgoingCallContext` in `lmz-api.ts`), and the call context is already held by `runWithCallContext`.
   - **Claims Mesh builds**, for an identity with no Registry membership. The agent's own (DI3) never leave the Galaxy: a call made under them starts a fresh chain, enforced in `buildOutgoingCallContext`. Personas' `asPersona` carries its claims onward, as a tab's do.
   - **A new chain under the claims of the call the node is running in, with its local principal prepended as the outermost `act`**, by `prependActor` (DI1, DI4). Inside a held post's continuation (item 4) those are the poster's claims. The node passes no claims, so it cannot compose them, and Mesh adds the actor, so a chain the agent starts for Jennifer cannot leave the agent off. Every `lmz.call` and in-node write inside it inherits them unchanged: `projectActingToken` records both on every node the chain reaches, a tenant Star and the Registry's invite record included, and `#buildActingToken` already projects the ambient claims for in-node writes.
4. **Held claims (DI2).** `#onChatCommitted` keeps, from inside the poster's call, a handle the Galaxy re-enters for each tool call that acts for that post, never a claims object it could compose; Pass 2 picks the mechanism. The claims are released when the turn that posted the post's answer ends. Each piece of work it starts gets its own `ctx.waitUntil`.
5. **A decision (DI7).** When a turn ends with posts still waiting, the agent starts the next turn itself. Its first step reads the thread under the agent's claims and picks one waiting post to take up, and from the pick on the turn runs inside that post's held call (item 4).
   - **Tools only inside a held call.** The decision step, the closing step (item 10), and any turn with nothing held are offered no loop tools, so they read, answer and ask (D14). Every tool call runs inside the held call of the post it acts for.
   - **DI5's binding.** A call DI5 covers runs under that post's claims and takes no argument naming a post, so whose claims it uses follows from which post the model took up and from nothing else (D2). Other work may name another held post and run under its claims (D1): every loop tool but `invite` takes an optional post id, described in `CODEGEN_TOOLS`, the home `studio-guidance.md` gives tool mechanics. With none named, a tool runs under the post its turn took up, and naming a post that is not held is refused. A turn that needs DI5 work for two people's posts splits into two turns.
   - **TEMP → Q3, at the deadline.** A turn the generation deadline cut off starts no decision, and a post whose turn is still running is never taken up again; the Galaxy keeps those posts in memory. Without this, a hung turn's post is still unanswered after the deadline frees the latch, so the next decision would take it up again inside the same held call, every 14 minutes.
6. **The wake check (DI7).** `onStart` reads the thread under the agent's built claims, through the same read path as its own reads, and asks item 9's function whether any person's post is waiting, reading back no further than the oldest such post. Only if one is does it schedule a wake check through `svc.alarms`, with a fixed id so repeated wakes do not stack. Reading only the posts after the agent's latest message would miss Austen's in § *Two people, one goal*, which comes before "Done, Jennifer". The job starts a turn detached, which reads the thread, answers and asks, offered no loop tools since nothing is held after a restart (D14), and returns, so it never holds up the certificate alarm, and `beforeTeardown` cancels it.
7. **`deriveKind` in `participants.ts` reads the subject (DI3)**, in the same change that makes the agent one. Otherwise the agent's first post as itself reads as human, gets a turn, and the agent answers itself forever.
8. **The agent's `invite` tool, with the invite rule it needs (D11), moved from personas' item 9.** It is the first named row of DI1's tool and the first call DI5 covers, so it takes no argument naming a post.
   - **Two paths, one per kind of collaborator.** An Austen-kind invite goes through `Resources.invite(chat node, [{ email, tier: 'write' }])`, which checks DAG `admin` at the chat node within the turn and returns an ack; the membership, the grants and whether the email went out land later in `#onInviteResult`. A Galaxy-admin invite goes through `AuthFacade.invite('acme.crm', [{ email, scopeAdmin: true }])` over `lmz.call`, and everything about it lands in a Galaxy handler.
   - **Each handler posts, as the agent (DI3), what the turn could not know (D22):** a failure on either path, and the admin kind's success. `#onInviteResult` gains that post.
   - **The Galaxy's `invite` entry checks the held claims' dominion over the Galaxy before it calls either path,** so an invite refused for want of dominion is refused within the turn, and the agent can ask someone who has it. It mirrors the facade's rule, as `assertCanImpersonate` mirrors the impersonation mint, and the facade still enforces it.
   - **Only dominion invites into a Galaxy.** Today `AuthFacade.invite` admits a caller whose host is the target, so Austen, a plain member of `acme.crm`, may invite anyone into it. Into a Star, peers still invite.
   - **The `.dev` membership an invite mints beside the Galaxy's always carries the admin bit.** `issueInvites` sets it today only when the inviter has dominion over the Galaxy, so the branch that mints it plain goes, and an invitee already holding a plain `.dev` membership is promoted, since `#mintIdentity` returns an existing row unchanged.
   - **`LOOP_TOOL_ENTRIES` gains `invite`.** `LoopEntry` is a union of Galaxy method names and `AuthFacade.invite` is not one, so Pass 2 names the Galaxy entry the tool reaches, and the resource-surface test still asserts each named entry sits at the chat floor.
   - **The JSDoc of `AuthFacade.invite`, `Resources.invite`, `#onInviteResult` and `issueInvites` changes with it.** `#onInviteResult`'s failure branch, whose comment says nothing reaches it today, gains a producer: an inviter with DAG `admin` on `chat` but no dominion, if the Galaxy's check above ever misses.
   - **Personas' three invite criteria move with it,** in § *Criteria — what the phases must satisfy* of that file, for Pass 2 here.
9. **An agent message names every post it answers (D12, D20).** `Message.replyTo` stays: the post the turn took up, which ③'s capture reads as the prompt behind the reply. `answers` joins it in ⑥'s ontology bump, a set of every post the message answers, `replyTo` included, and `commitAgentMessage`, the one writer of an agent message, builds it that way. `replyTo` is required on a turn's final message, and both are absent on a result handler's outcome post, which belongs to no turn.
   - **What decides "answered" moves to `answers`,** through one named function (`calibration.md` §12): `App.vue`'s `replyLanded`, Studio's waiting state, the wake check and the byline (D23).
   - **What pairs a reply with its prompt keeps `replyTo`:** `#historyBundle`'s `replyOf`, the stream chunk, which names the post its turn took up, and the harness scenarios that find a post's reply (`grep -rn replyTo apps/nebula/harness`).
10. **A closing step (D18).** When the model finishes a turn and posts arrived while it ran, `runCodegenTurn` appends them last in the prompt, after the history bundle it built once at the turn's start, so the provider's cache still holds, and asks for the final message with no loop tools offered. That message may answer those posts too, and a post it does not answer waits for a decision. It costs one more model call, only when a post arrived mid-turn, and often saves the decision turn that post would otherwise need.

**Adapted:**

- **`commitAgentMessage`** writes under the agent's claims, without the `actor` and `pinnedAtDoor` options it passes today.
- **`#recordServedBuild`** writes as the agent (D5), and **`buildNow`** logs its caller's claims through `projectActingToken`, as `writeSource` logs each commit.
- **Each source commit names whose authority it used, twice (D15).**
  - **On the agent Message:** each `codegen.toolCalls` entry gains the post it acted for and the recorded claims it ran under, through the shared projection, in ⑥'s ontology bump, since `codegen` is an inline type in the chat ontology. The commit's oid, already in the tool's result, joins a commit to its entry. Studio renders a marker on each tool call from this record. The model still writes the *under Jennifer's authority* sentence (`TOOL_CONTRACT`); the marker, never the model's text, is what attests it.
  - **On the commit:** `writeSource` passes the person whose claims the write ran under as git's `author`, by `profileId` (ADR-013's write-time display stamp). The `committer` is `agent:lumenize` when the agent made the write, and the person again for a direct call. Pass 2 pins the email form. Its debug line reads the current claims rather than `#clientOrigin()`, which requires a chain that starts at a Client and would drop the claims of a chain the agent starts.
- **`#historyBundle`** reads under the agent's claims in a decision, labels the agent as itself rather than as a numbered human, and shows each post's id inline and the held claims in one block after the history, since what changes goes last.
- **Studio's byline and avatar stack (D23).** `deriveParticipants` adds the authors of the posts in `answers`, read from the value of a message whose recorded subject is the agent, each with their post's own recorded chain. `participants.ts`'s header states that one exception to deriving display only from the record, and its reason: no client can write an agent message, since only server code runs under the agent's claims (D3).
- **Studio's waiting state.** `deriveTurnDisplay` gains *waiting*, held while another post's turn streams, and a post stops waiting when an agent message names it in `answers` (DI6). Today `App.vue` resets a post's 90 s idle window only on chunks replying to that post, so a waiting post shows *thinking…*, then *failed*, under a comment saying a skipped post is never answered.
- **The tool contract, `TOOL_CONTRACT` in `codegen-loop.ts`,** gains the rules for several people: say whose claims it is using, end every turn with a message naming in `answers` the post it took up and any other it answers, naming a post only when the message answers it, done, refused or asked back, never for work it only promises, and ask before acting on what it was not asked.
- **`security.md`:** the bullet on the verdict of the door that admitted the work loses the reply and the `ServedBuild`, which become the agent's own writes. What stays is that a turn's source writes and builds run on its post's verdict, while a Resources write inside a turn is checked live. The rule that no synthetic claims go into a chain a node started names the agent's built claims beside the persona's, and gains item 3's second form: a chain a node started may carry the claims of the call it was started in, with the node's local principal prepended, and never claims the node composes.
- **`deleteNode`'s JSDoc** in `org-tree.ts` states D17's premise: whatever first reads `deleted` exempts a node holding a protected grant, or refuses its delete.
- **`prependActor`'s JSDoc** in `access-claims.ts` warns against prepending into a person's access token, not "a TOKEN", and names Mesh's new-chain form as its caller in place of the Resources plane.
- **What asserts the old attribution:** `grep -rnE 'NEBULA_SUB|pinnedAtDoor|(actingToken|recordedClaims)\.(sub|act)|deriveKind|deriveParticipants|single-flight' apps/nebula/test apps/nebula/harness`. Most hits invert, as `calibration.md` §3(b) expects; `source-chat-floor.test.ts`'s case that a turn finishes under the authority it started with, and `served-build.test.ts`'s verdict case stay green on the agent's grant, so they are re-derived instead.

**Removed:**

- **`pinnedAtDoor`** in `TransactionOpts`, and the check Snapshots skips for it (D5).
- **The `actor` a write carries (D6):** `TransactionOpts.actor`, `ensureResource`'s `actor` option, the actor branch of `#buildActingToken` in `snapshots.ts`, and `turnContext` in `galaxy.ts`. The claims carry the agent instead. A direct `writeSource` call's debug line still carries no actor, because no chain the agent started is running.

**Kept as they are:** one turn at a time, and the generation deadline, with item 5's interim until Q3 decides it.

## Design intent

- **DI1.** Give the agent a tool that allows it to make any `lmz.call()` but only if it holds a user's claims, it attaches itself as the `act` on those claims, and only if it has clear authority from the user. It need not know the user's permissions before attempting the call on their behalf. If that call is denied for a lack of permission, it will need to adjust for instance, by asking a user who it believes has that permission if it's OK to satisfy that user who lacks its permission. In which case, it attempts the call under that new person's claims. It is built one named `LOOP_TOOL_ENTRIES` row at a time, `invite` first (D11); its general form is in § *Future state*.

- **DI2. The agent holds a participant's claims only in memory.** They arrive with the post's call and are released when the turn that posted the post's answer ends, or the Galaxy is evicted. They are never stored, since a stored scope set is a security bug ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)). So the agent can hold several participants' claims at once, one per post it is answering (D1), and holds none after a restart. The claims stay with the post because AsyncLocalStorage binds where a continuation is attached, not where its promise is created: attached when a decision picks the post instead, the continuation would carry the claims of whatever call was running then, Jennifer's, and Austen's would be lost.
- **DI3. The agent posts as itself:** `{ sub: 'agent:lumenize' }`, with no `act`, on its own `write` grant on the `chat` node ([ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)). The scene tables leave those steps out.
- **DI4. Everything else it does runs as *participant + agent*,** under the claims of a participant who asked for it or said yes when the agent proposed it. Which held claims to use is the agent's judgment (D1), except where DI5 decides.
- **DI5. A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post its turn took up (D2).** The Galaxy picks those claims, not the model: the post is the one its turn took up, and such a call has no argument that names a post. A tenant Star is any Star under the Galaxy but `.dev`, which the call's target scope shows: in `acme.crm`, `acme.crm.tenant1` is one and `acme.crm.dev` is not. A call changes who can do what when it changes a membership, or a grant outside `.dev`. So `invite` is covered, and the source tools, `build`, and personas' `provision`, whose grants are the cast's in `.dev`, are not. The check still refuses claims that lack the permission, as it refuses Austen's for tenant data.
- **DI6. Every turn ends with an agent message that answers the post it took up.** So the next decision never takes up a post a message has already answered, and a recovery that dies again cannot loop. A person's post stops waiting, in Studio and for the wake check, once an agent message names it (§ *Conventions*).
- **DI7. A post at an idle Galaxy starts a turn, and a turn that ends with posts still waiting starts the next, beginning with a decision.** Any other wake reads the thread for unanswered posts and schedules a wake check through `svc.alarms` only if it finds one. Which posts are answered is read from the thread's `answers`, never written per turn.

## Constraints

- **The whole chat is read every turn, so what changes goes last.** Until the agent has a memory, each turn reads the chat in full. Keeping what changes at the end of the prompt lets the model provider's prompt cache reuse everything before it.
- **`docs/vision/auth.md` § *When the agent acts*:** the agent writes as a person who asked or said yes, and talks as itself.
- **[ADR-003](../docs/adr/003-continuation-messaging.md):** work waits on the Galaxy's own latch, never across a hop, and a result handler's outcome travels as data in a continuation.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md):** an agent message changes no authority and destroys nothing, so it owes no record; work done as a person records that person, with the agent as actor.
- **`durable-objects.md` § *No mutable instance state*:** held claims are an ephemeral cache, since losing them leaves the post in the thread for the wake check.
- **`durable-objects.md` § *Initialization*:** `onStart` runs inside `blockConcurrencyWhile` on every wake, so it only reads and schedules.
- **`security.md`:** no client can name an actor or a subject.
- **`security.md` § *Delegation*, rule (1):** authorization reads the subject, its `access` and `aud`, never `act`, so the agent prepended as `act` gains nothing by it. The one check on `act` being present, the impersonation mint, refuses a chain the agent started, and the agent should never impersonate anyway.
- **No node checks the `exp` of claims inside the mesh;** only the `ClientGateway` does, for its socket. So held claims work until they are released, as `security.md` lets work a door admitted run to its end.
- **`calibration.md` §14:** the agent's authority is a grant in the tree, never a membership in the Registry.
- **`strategy.md`'s check 1, "never broader default access":** the agent's own default access is `write` on `chat`, and every claim it holds beyond that came with a post from someone who asked or said yes, just in time and only while that post waits.
- **`studio-guidance.md`:** the rules for several people are cross-turn policy, so they live in `TOOL_CONTRACT`.
- **`live.md`:** a `/live` scenario first. What is deterministic gates: claims held with their post, DI5's binding (Jennifer posts twice and Austen once while Jennifer's first turn runs, so Jennifer's claims are still held when a decision takes up Austen's invite request; the invite runs under *Austen + agent* and is refused; mutation: let a DI5 call use any held post, and the invite lands), tools only inside a held call (mutation: give the decision step the tool list, and its model request lists them), the wake check's scheduling. When the wake check builds, its limb: Jennifer posts, Austen posts mid-turn, the agent posts "Done, Jennifer", the Galaxy is evicted, and the wake check finds Austen's post (mutation: read only after the latest agent message, and it misses it). Which post the agent takes up first is its judgment, and rides a limb that does not gate, as does D2's leftover risk: Jennifer's unrelated post waits beside Austen's invite request, and the limb records whether the agent invites in Jennifer's turn.
- **`calibration.md` §12:** whatever decides when Studio stops showing a post as waiting lives in a named function, as `deriveTurnDisplay` does.
- **`live.md` § *Two venues, one registry*: a deployed pass closes the build,** since it changes `AuthFacade.invite`, `issueInvites`, what a Client hears back and who posts as the subject. First check the deployed-only branches (`grep -rln HARNESS_TARGET_URL apps/nebula/harness`) against the new invite refusals; then run this build's scenarios with `HARNESS_TARGET_URL`, and read the Workers Issues raised since the pass began.
- **Milestone:** pre-alpha, before personas (D13), except the wake check (D19).

## Future state

- **A structured yes for the first call that discloses.** When DI1 grows a tool that reads a tenant Star, a DI5 call that discloses binds only to a person's yes, given through a control rather than text, to an agent message that proposed that exact call. That is the manifesto's human in the loop for what cannot be undone, and it closes what D2 leaves to judgment.
- **DI1's general form** is the backlog's *The model writes code that runs in a sandboxed Dynamic Worker…* row, whose proxy is item 3's chain under a held post's claims. Until then DI1 grows one named row of `LOOP_TOOL_ENTRIES` at a time, `invite` first.
- **Threads, which are sessions and branches.** The agent will encourage moving a piece of work into a thread. Unlike a thread in Discord or Slack, its first post is the agent's: a compacted summary of what in the main chat bears on the work, so the session starts with the context it needs.
- **A memory the main chat and every thread share.** What the agent learns about who can do what is a natural first thing to keep there.
- **A discriminator decides whether the agent answers at all.** Fast-follow Item 6 starts it with Cloudflare's Clef. It plugs in where a post arrives and where a turn ends.
- **Sub-agents do long work, and the chat agent stays the supervisor** (Larry, 2026-10-10). Its turns stay short, so a waiting post waits seconds rather than minutes, and each sub-agent runs under the claims of the post it serves.
- **Steering a turn while it generates** stays in fast-follow Item 6.

## Open questions

- **Q3. How does the loop recover when a turn fails?** Deferred until the multi-player happy path is settled (Larry, 2026-10-16), and the wake check builds after it (D13). What it has to answer:
  - **Who writes the post that ends the turn** when the model call hangs. The model cannot, so our own code must, with a fixed message or one more short model call. A turn that uses all 32 tool-call rounds (`maxToolDepth`) already posts the model's text or a fixed fallback (`#codegenTurn` in `galaxy.ts`).
  - **Which event frees the latch.** Today the 14-minute deadline frees it while the turn keeps running, and the abandoned turn may still write and land. Item 5's interim stands in until then.
  - **What bounds a wake check that dies before it posts.** Each wake would try again.
  - **What reconciles on wake:** fast-follow Item 6's *Consider reconciling on wake* bullet, which destroys a build box no build owns.

## Decisions

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | The agent may hold several participants' claims at once, in memory and never in storage. It knows whose claims it holds, picks the best ones for the work, or asks the person whose claims it should use (Larry, 2026-10-16). (was Q2) Learning who can do what is less trial and error than it looks: every member of a Star can see who holds which grant in its tree ([ADR-008](../docs/adr/008-full-org-tree-visibility.md)), and the claims the agent holds say what each holder may do, since passage and dominion are computed from them. What it cannot read is the admin bit of someone whose claims it does not hold. | **Each piece of work runs under its own poster's claims, and nobody else's** (rejected 2026-10-15): the agent could not proceed under Jennifer's authority when Austen's claims are gone, and running a request under another person's claims is not in itself a defect. |
| D2 | A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post its turn took up, and the Galaxy, not the model, picks them. Everything else keeps D1's free choice (Larry, 2026-11-10). (was Q1) The check is hard on every call between nodes either way (Larry, 2026-10-16). This is prevention where the manifesto's Reversibility line keeps it, on what cannot be undone: a disclosure cannot be taken back, and an authority change can lead to one. What it guarantees is agreement: the post the work answers, the claims it runs under, D15's record and the reply's `answers` all name one person (2026-11-10, Stage 1, second pass). Which post to take up is the agent's judgment, so a steered decision could still act on Austen's request in Jennifer's turn, but only by answering Jennifer, on the record as hers. The Objective's "clear authority of a participant" is that post. A structured yes that closes even this waits for the first call that discloses tenant data (§ *Future state*), since this build's only DI5 call is `invite`, whose worst case is an email and a membership Jennifer can remove. | **Judgment alone, with attribution as the backstop**: a line from Austen, or one planted in `AGENTS.md`, could steer Jennifer's held claims toward Austen's request, and the Objective's "must not be able to" would become "is told not to". **Binding every call to the post its turn took up**: the same loss as D1's rejected alternative. **The model naming the post in each tool call** (rejected 2026-11-10, Stage 1): a steered model names Jennifer's post while answering Austen, and the chat and the record then disagree about whom the agent acted for. **The newest human post**: an unrelated "looks good" from Jennifer after Austen's request would carry it on Jennifer's claims. |
| D3 | The agent posts to the chat as itself: every agent message names `agent:lumenize` as its subject, with no `act`, and only server code runs under its claims (Larry, 2026-10-10). | **The poster as every agent message's subject**, as today: an outcome, and a decision the agent makes on its own, have nobody to post as. **The agent as subject only in its own turns**: two shapes of agent message. |
| D4 | The agent is a local principal of the Galaxy: `write` on a `chat` node of its own under the root, no Registry membership, and its reads and posts pass the same DAG check as anyone's (Larry, 2026-10-15). The grant shows in the tree, cannot be revoked (D16), and covers the conversation and nothing a later node beside it holds. | **A server read with no check**, confined to the chat by hand: a second read path every later rule skips. **A Registry membership**: the login `auth.md` objects to, with passage and dominion to confine. **`read` alone**: leaves a post's check skipped. **The chat on the root**: a chat-floor grant would cover everything the tree ever holds. |
| D5 | A landing's `ServedBuild` is the agent's write, under its grant on `chat`, and `pinnedAtDoor` goes; `buildNow` logs its caller's claims (Larry, 2026-10-15). Every Studio on the app hears a landing through that record, and since the agent's grant cannot be revoked (D16), no change to anyone's grant refuses it. | **Keeping `pinnedAtDoor`**, as [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) decided on 2026-10-13: a check the Resources plane skips on our own server's say-so. **Writing the record as the build's caller**: a grant revoked mid-build refuses it, and other Studios stay on the old build. |
| D6 | A write the agent makes for a person names the agent as actor (Larry, 2026-10-15). A record carrying only the person names the one acted upon as the one who acted, and undoing a bad turn finds its writes by that attribution. The agent rides on the claims: where the loop dispatches a tool, it starts a chain under the person's claims with the agent prepended as `act`, and every record on every node the tool's calls reach projects both (Larry, 2026-11-10, Stage 1). | **An `actor` option on each write**, as `ensureResource` has today: no `lmz.call` carries it, so a tenant Star's record and the Registry's invite record name the person alone. **An `actor` field beside the claims in the call context**: a second carrier that every record site would have to merge. **Recording the agent's part once per turn, on its reply**, which no write points to. |
| D7 | The agent meets every gate the chat floor guards, bounded by what runs under its claims: its posts, a landing's `ServedBuild`, its reads of the thread, and a result handler's outcome post (Larry, 2026-10-15). Source lives in the Workspace's git tree, and `requireChatWrite` only borrows the chat node's grant as its floor. | **A node of its own for source**, with nothing in the tree to hang it from. |
| D8 | A turn a reset kills is answered after the restart, not run again. The agent reads the recent messages, decides what to address, and asks whether to proceed; a yes runs as whoever sends it. A decision starts in memory when a turn ends, and only the wake check schedules an alarm (Larry, 2026-10-15). | **Running the killed turn again as the agent**, on its post's verdict: it acts on source with no live person. **Running it again from the poster's stored claims**: ADR-016 forbids stored claims as an authz input. **A marker and an alarm written as every turn starts**: storage writes are the dominant cost. |
| D9 | Whether the agent answers at all is decided later, by a discriminator; until then every person's post is answered (Larry, 2026-10-10). | **Building the discriminator now**: with pre-alpha's few users a turn per post is affordable, and the discriminator is a cost optimization (fast-follow Item 6). |
| D10 | The record a write stores is `recordedClaims` (Larry, 2026-11-10, Stage 1). It holds claims, not a token, and since D6 the agent's `act` in it was never in any token. `recordedClaims.sub` reads as those claims' subject, with no role to invert, and "recorded" marks it as history, so "live claims are never stored" needs no qualifier. | **`actingToken`**, chosen 2026-07-29: no access token carries the agent's `act`. **`actingClaims`**, tried before it: it contradicts DI2's "never stored", and live-claims parameters already carry the name. **`actingPrincipal`, `actedBy` or `actor`**: role names, whose `.sub` reads as the actor but holds the person acted upon (ADR-016). |
| D11 | The agent's `invite` tool and the invite rule it needs move here from personas. It is the first named row of DI1's tool and the first call DI5 covers, so DI5's binding is built with a real consumer and the invite scene runs on this build (Larry, 2026-11-10, Stage 1). | **Deferring DI1 and leaving `invite` in personas**: DI5's binding would be built with no consumer and no gating limb, a shape built with no consumer, which the next task would then have to unlearn. **A general `lmz.call` tool now**: it breaks `LOOP_TOOL_ENTRIES`' rule that a tool reaches only the entries the table names, DI5 would have to classify an arbitrary method at dispatch, and each call's result arrives in a result handler after the turn has moved on (ADR-003). |
| D12 | A turn takes up one post; a decision is the first step of a turn the agent starts itself when posts are still waiting; a post is answered when an agent message names it in `answers`; and its claims are released when the turn that posted its answer ends (Larry, 2026-11-10, Stage 1). A post that arrives at an idle Galaxy and cannot be acted on yet gets an answer that says so, as Austen's "(c) works for me" does in § *Two people, different goals*. It settles the bullet Q3 had on finding work announced but never finished. | **"Answered" as any agent message following the post**: "Done, Jennifer" follows Austen's post, so her claims would go before her build. **A decision as a model call of its own before each turn**: a solo user pays for it after every turn. **A turn that ends without answering the post it took up**: it needs an in-memory mark, or the Galaxy restarts a turn on that post forever, and DI6 loses its guarantee. |
| D13 | Everything in this file but the wake check gates personas, and the wake check builds last, once Q3 is decided (Larry, 2026-11-10, Stage 1). Held claims do nothing without the decision that takes a waiting post up, and personas' provision confirmation is a yes that arrives mid-turn. Without the wake check, a turn an eviction kills is answered only when someone posts again, as today. | **The wake check, Q3 and the failure scenes in a follow-on file**: a new file, and the failure scenes leave the loop they test. **The whole file gating personas**: personas would wait on Q3, which is deferred until the multi-player happy path is settled. **Decision points after personas**: held claims would arrive with nothing to take them up. |
| D14 | A loop tool runs only inside the held call of the post it acts for. The decision step, the closing step, and any turn with nothing held are offered no loop tools (Larry, 2026-11-10, Stage 1). A loop tool calls its Galaxy entry in-process, where no decorator's check runs, and the agent's own `write` on `chat` would pass the source floor anyway, so D7's list of what runs under the agent's claims is otherwise enforced nowhere. | **A check at dispatch refusing a call under the agent's own claims**: a guard on a path that offering no tools removes. **Letting the agent's own claims run tools, with attribution as the backstop**: its commits would name the agent alone, which DI4 and D6 rule out. |
| D15 | Each source commit names whose authority it used in two places: the agent Message's `codegen.toolCalls` entry records the post and the recorded claims, and the commit's git `author` is that person, with `agent:lumenize` as `committer` (Larry, 2026-11-10, Stage 1). Before D3 the agent Message's record named the poster, and it was the only link; the manifesto and § *Context* both promise that the commit itself names the person. | **The Message alone**: a repo that leaves the Durable Object, by export or a fork, names nobody. **The commit alone**: a git author carries no `access`, `aud` or full `act` chain, which ADR-016 records. |
| D16 | `OrgTree` refuses a revoke of `agent:lumenize`'s grant on `chat`, or a `setPermission` that lowers it, since the Galaxy's seed marks it protected (Larry, 2026-11-10, Stage 1; the lowering 2026-11-11). (was Q5) No Studio surface changes a grant, and under *Chat over components* the agent is the product's way to change one; with its grant gone it can neither read the thread nor post, so it never hears a request to restore it. Wanting the agent quiet is D9's discriminator, or a mute, never a revoke. | **A revoked grant means the agent is off for the app**: only a developer's direct `setPermission` call brings it back. **A re-enable path**: a kill switch and its undo, for a need nobody has raised. |
| D17 | The `chat` node refuses nothing the root refuses: delete, move and rename stay open, and a UI that later exposes them warns ([ADR-015](../docs/adr/015-passage-and-dominion.md)) (Larry, 2026-11-10, Stage 1). (was Q6) Each can be undone: delete sets a flag nothing reads yet and `undeleteNode` clears it, a move is reversed by moving it back, and the chat is keyed by a fixed id, so a rename changes nothing. D16's refusal differs because a revoke removes the only surface that could undo it. D17 holds while nothing reads `deleted`: whatever first reads it must exempt a node holding a protected grant, or refuse its delete, for D16's reason, and `deleteNode`'s JSDoc says so. | **Refusing them as the root does**: an authorization refusal on actions that can be undone, which ADR-015 rules out. |
| D18 | A turn that finishes while posts arrived mid-turn ends with a closing step: the loop appends those posts last and asks for the final message with no loop tools offered, so that message can answer them too (Larry, 2026-11-10, Stage 1, second pass). A turn builds its history once, at its start, so without it a turn never sees a post that arrived while it ran, and neither vision scene that answers two people in one message could run. | **No mid-turn reads**: every such post waits a whole turn for an answer, and both scenes split into two agent messages. **A re-read with the loop tools still offered, refusing a DI5 call once a mid-turn post has been read**: an invite read during Jennifer's turn would otherwise bind to her post, which D2 exists to stop, and the closing step removes that path rather than refusing it. |
| D19 | The wake check follows the wipe, in fast-follow, once Q3 is decided; before then, an evicted turn's post shows as waiting and is answered through the decision after the next post's turn (Larry, 2026-11-11). If that proves a problem in pre-alpha, the wake check moves to the top of the list. Until Q3 decides the deadline, a turn the deadline cut off starts no decision, and a post whose turn is still running is never taken up again (item 5, TEMP → Q3). | **The wake check before the wipe**: Q3, deferred until the multi-player happy path is settled, would stand in front of the wipe. **No interim at the deadline**: a hung turn's post stays unanswered with its claims held, so a decision would take it up again inside the same call, alongside the hung turn, every 14 minutes. |
| D20 | `Message.replyTo` stays, the post a turn took up, and `answers` joins it, every post the message answers with `replyTo` included; `commitAgentMessage`, the one writer, keeps the two consistent (Larry, 2026-11-11). They are two facts: which post prompted the work, which ③'s capture needs and cannot recover later, and which posts the message answers, which under D18 can be several. | **`answers` alone, replacing `replyTo`**: nothing durable then says which post a turn took up, since a stream chunk is gone when the turn ends and a turn with no tool calls leaves no `toolCalls` entry. **`replyTo` plus a set of only the other posts answered**: every reader of "answered" combines two fields, and the set needs a new name. **One ordered `answers` whose first entry is the post the turn took up**: the meaning sits in an order nothing names (`calibration.md` §12). |
| D21 | The Galaxy declares its seed, the `chat` node and the agent's protected `write` on it, when it builds its Resources, and `OrgTree` creates the root and the declared rows with `INSERT OR IGNORE` (Larry, 2026-11-11). These are the only two rows this task needs that nobody's request creates: the owner reaches the tree through dominion, and a collaborator gets a grant by invite. | **In `#ensureRoot`**: every Star's tree runs it, so the chat would land in every tenant Star. **`createNode` and `setPermission` from the Galaxy's `onStart`**: both demand claims, and `onStart` has none. **Once at creation, through a creation hook under the creator's claims**: the claims would cross the `@rawRpc()` bridge, which carries none today, and the existing hooks only log a failure, so a missed seed would leave that Galaxy without its chat. **A repair on every wake by upsert instead of a refusal**: a revoke would appear to succeed and then revert, and every wake would write a row. |
| D22 | An invite's handler posts, as the agent, what the turn could not know: a failure on either path, and the admin kind's success. The Galaxy's `invite` entry checks the held claims' dominion over the Galaxy before calling either path, mirroring the facade's rule (Larry, 2026-11-11). Only the DAG check answers within the turn; the mint, the grants and the email land in a handler after it, and without a post a failed invite reaches nobody in the chat. | **Leaving an Austen-kind failure to its `_InviteStatus` row**: every member can see it in the tree, and nobody sees it where they look, in the chat. **One path for both kinds, through the facade and a handler**: it reopens personas' decided two-path design for no gain the post does not already bring. **No early dominion check**: an invite refused for want of dominion arrives after its post is answered, too late to ask someone who has it. |
| D23 | An agent message's byline reads *Lumenize, re: {author}* for each post in `answers`, each author shown with that post's own recorded chain, so an answer to an impersonated post reads *Lumenize, re: {coach} for {user}*; the avatar stack puts the agent's face in front of theirs, and a handler's outcome post, which answers nothing, reads *Lumenize* (Larry, 2026-11-11). (was Q4) A reply UI like Discord's, quoting the post answered, is the better form, and this byline stands until one exists. | **_Lumenize_ alone, with a separate reply link**: the same fact shown twice, and the coach of a depth-2 post has nowhere to appear. **_Lumenize for Jennifer_, as today**: "for" claims the message ran on Jennifer's authority, when under D3 it is the agent's own and only its tool calls ran under her claims, which D15's marker shows. |

## Phases

Numbered in build order. Every phase lands before personas (D13); the wake check is not among them (§ *Non-goals*). Phases 1, 3, 5 and 7 change stored data, so they ride ⑥'s wipe, which row ② of the master plan carries. A `/live` scenario comes first in each phase that has one (`live.md`); a criterion in another lane says why. After any phase that changes a harness helper or a scenario another file wrote, `drive.ts all --fast` runs, and its result is reported with any flake named.

1. **The stored record is `recordedClaims` (D10).** The rename block in § *What changes* lands as one sweep, code and standing guidance together, so no later phase names both.
   - **Success criteria:**
     - The symbol grep and the prose grep in the rename block find only dated history and real access tokens.
     - `npm run type-check` passes, and the suites of `packages/mesh`, `packages/resources` and `apps/nebula` pass with the same `Test Files` count as before.
     - `drive.ts all --fast` passes, `four-party-chat` included, which reads the field.
   - **Mutation note:** leave one `actingToken` in `snapshots.ts`, and the symbol grep reds.

2. **Mesh runs a block under claims, in two forms (item 3).** Mesh's call-context API gains them, built on `runWithCallContext`.
   - **Form one:** claims Mesh builds for a local principal; a call made under them starts a fresh chain.
   - **Form two:** the claims of the call the node is running in, held as a handle the node cannot build, re-chained with the node's local principal prepended by `prependActor`.
   - **Lane:** `packages/mesh/test`, with real Durable Objects. No product path exists until Phase 5, which drives form two on the running system.
   - **Success criteria, each with its mutation:**
     - A record written on a second node inside a form-two chain carries `sub` from the held call and `act.sub` from the local principal, and an impersonated caller's own `act` stays beneath it. Mutation: start the chain with the held claims unchanged, and `act` is missing.
     - Form two outside any call, in an alarm handler, throws. Mutation: let it start a chain with no claims, and the call proceeds.
     - A call made under form one reaches its callee with no `originAuth`. Mutation: inherit the built claims, and the callee reads `agent:lumenize`.
     - The impersonation mint refuses a caller inside a form-two chain. Mutation: drop the mint's `act` gate, and it mints.
   - `prependActor`'s JSDoc changes as § *What changes* says.

3. **The Galaxy seeds its chat node and the agent's protected grant (items 1 and 2, D16, D17, D21).** `#ensureRoot` becomes `#ensureSeed`, the Galaxy declares its seed, `CHAT_NODE_ID` gets an id of its own, and the harness sites that post at `ROOT_NODE_ID` move.
   - **Success criteria (`/live`, a new container-free scenario, `galaxy-seeds-its-chat`):**
     - After a real app creation, the Galaxy's tree, read through a real client, has a `chat` node under the root, and `agent:lumenize` holds `write` on it. The `.dev` Star's tree and a tenant Star's tree hold only the root. Mutation: seed every plane, and `.dev` shows a chat node.
     - A Galaxy admin's revoke of the agent's grant, and a `setPermission` lowering it to `read`, are both refused, and the grant still reads `write`. Mutation: drop the protected check, and the revoke lands.
   - **Success criteria (the Resources lane, because rows written at construction cannot be read from a running stack):** constructing the plane a second time over the same storage writes no rows. Mutation: upsert the seed, and the second construction writes.
   - `deleteNode`'s JSDoc states D17's premise.

4. **The agent posts as itself (DI3, D3, D5, item 7).** `commitAgentMessage` and `#recordServedBuild` write under the agent's built claims, `deriveKind` reads the subject, `pinnedAtDoor` goes, and `buildNow` logs its caller's claims.
   - **Success criteria (`/live`):**
     - In `four-party-chat`, inverted, the agent's reply records `{ sub: 'agent:lumenize' }` with no `act`, and `deriveKind` calls it the agent's. Mutation: write it under the poster's claims, and its subject is Austen.
     - The agent's own message never starts a turn, the criterion moved from personas. Mutation: leave `deriveKind` reading only `act`, and the agent's reply starts a turn that answers itself.
     - In `build-reaches-every-studio`, a landing's `ServedBuild` records the agent as subject, and a second Studio hears it. Mutation: restore the poster's claims with `pinnedAtDoor`, and the record names the poster.
   - **Checks:** `git grep -n pinnedAtDoor -- ':!tasks/archive'` finds only dated history, and the archived `nebula-build-reaches-every-studio.md` gains its dated superseded banner.

5. **A post's claims are held, and a decision takes waiting posts up (items 4, 5 and 9; DI2, DI6, DI7; D6, D12, D14, D20; D19's interim).** Each post's held call is a Phase 2 handle. A turn's tools run inside a form-two chain under the post they act for, which retires `turnContext` and the `actor` option. The `answers` field joins `replyTo`, and `#historyBundle` and `TOOL_CONTRACT` change as § *What changes* says. When a turn takes a post up, a log line names the post and the recorded claims it runs under, which is what the criteria below read.
   - **Success criteria (`/live`, a new scenario, `held-post-answered`, running § *Two people, one goal*):**
     - Austen's post, sent during Jennifer's turn, is taken up after it, and its turn's line names `{ sub: Austen, act: agent:lumenize }`. Mutation: attach the continuation when the decision picks the post rather than in Austen's call, and the line names Jennifer.
     - That turn's final message has Austen's post as `replyTo` and in `answers`, and "Done, Jennifer" names only Jennifer's. Mutation: build `answers` without `replyTo`, and the first check reds.
     - A lone post's turn ends with no decision line. Mutation: run a decision after every turn, and a decision line appears.
     - The decision step's model request lists no loop tools. Mutation: give it the tool list, and the request names `write_file`.
   - **Success criteria (the `dev-studio` lane, at its 800 ms deadline, because a hung model call cannot be produced on demand):** after the deadline, a second post's turn ends with no decision taking up the hung post, and no second turn runs on it. Mutation: let the deadline start a decision, and a second turn starts on the hung post.
   - **Success criteria (the codegen-loop lane, pure dispatch):** a tool call naming a post that is not held returns a tool error naming it. Mutation: skip the held check, and the call runs.
   - **Check:** `turnContext`, `TransactionOpts.actor` and `ensureResource`'s `actor` option are gone, by grep.

6. **A closing step answers posts that arrived mid-turn (item 10, D18).**
   - **Success criteria (`/live`, a new scenario, `closing-step`, running § *Two people, different goals* to its first agent message):**
     - When Austen posts during Jennifer's turn, the turn's log shows a closing step that appended her post, and its model request lists no loop tools. Mutation: skip the closing step, and no such line appears; offer the tools, and the request lists them.
     - With no post arriving mid-turn, no closing step runs. Mutation: run it on every turn, and the line appears.
     - A limb that does not gate records whether the final message names both posts in `answers`, since that is the model's judgment.

7. **Each source commit names whose authority it used (D15).** `codegen.toolCalls` entries gain the post and the recorded claims, and `writeSource` passes git's `author` and `committer`, reading the current claims rather than `#clientOrigin()`.
   - **Success criteria (`/live`, extending `held-post-answered`):** the agent message's `toolCalls` entry for each `write_file` carries Austen's post id and claims naming Austen with the agent as actor. Mutation: drop the entry's claims, and the field is missing.
   - **Success criteria (the `dev-studio` lane, which reads the Workspace's git log in-process):** a turn's commit has the poster's `profileId` as author and `agent:lumenize` as committer, and a direct `writeSource` call's commit names the caller as both. Mutation: pass no `author`, and the commit carries the client's default identity.
   - **Check:** Studio renders a marker on each tool call from the record, seen in `held-post-answered`'s screenshot of the thought panel.

8. **Studio shows a waiting post as waiting, and bylines the agent by what it answers (D23).** `deriveTurnDisplay` gains *waiting*, the one named function decides whether a post is answered, and `App.vue`'s `replyLanded` calls it.
   - **Success criteria (the function's own lane, since it is pure):** Austen's post reads as waiting after "Done, Jennifer" and answered after a message naming it in `answers`. Mutation: answer a post when any agent message follows it, and it reads as answered too soon.
   - **Success criteria (`/live`, `held-post-answered` driven through Playwright):** Austen's tab shows her post as waiting while Jennifer's turn streams, never as *failed*, then as answered. Mutation: leave `App.vue` pairing by position, and her post shows as answered too soon.
   - **Success criteria for the byline (D23):** in `held-post-answered`, the agent's answer to Austen reads *Lumenize, re: Austen*, and in `child3-post.test.ts`'s depth-2 case an answer to the impersonated post reads *Lumenize, re: {coach} for {user}*. Mutation: build the byline from the agent message's own record, and it reads *Lumenize* alone.

9. **The agent invites (item 8, D11, D22).** The invite rule, the `.dev` co-mint cleanup, the `invite` row in `LOOP_TOOL_ENTRIES`, the Galaxy's early dominion check, and both handlers' posts.
   - **Success criteria (`/live`, a new scenario, `agent-invites`, with real email):**
     - Jennifer asks for an Austen-kind invite and then an admin-kind one, and each invitee's memberships show its kind: a plain Galaxy membership with an admin `.dev` one, and a Galaxy membership with `scopeAdmin`. Mutation: send the admin kind through `Resources.invite`, and the invitee holds no `scopeAdmin`.
     - DI5's binding: Jennifer posts twice and Austen once while Jennifer's first turn runs, and the decision that takes up Austen's invite request runs it under *Austen + agent*, refused. Mutation: let a DI5 call use any held post, and the invite lands.
     - An inviter with DAG `admin` on `chat` but no dominion is refused within the turn, before the turn's final message. Mutation: drop the early check, and the refusal arrives after it.
     - A failed invite produces an agent message from its handler. Mutation: drop the handler's post, and no message arrives.
     - A plain Galaxy member's invite into the Galaxy is refused at `AuthFacade.invite`, while a peer's invite into a tenant Star lands. Mutation: restore `memberHere` at the Galaxy tier, and the member's invite lands.
     - A plain `.dev` membership the invitee already holds is promoted. Mutation: leave `#mintIdentity`'s existing row unchanged, and the invitee stays plain.
     - A limb that does not gate records D2's leftover risk: Jennifer's unrelated post waits beside Austen's invite request.

10. **Standing guidance, then the full sweep and the deployed pass.** Each edit lands here because Phases 4 to 9 all change what it describes.
    - `security.md`: the door-verdict bullet, the rule on chains a node starts, and its *Delegation* reader buckets, stated structurally.
    - The *Today's code differs* callouts in `auth.md` § *When the agent acts* and ADR-025.
    - `as-caller.ts` re-derived against what still reads a direct call's claims, closing the backlog row when nothing does.
    - **Success criteria:**
      - `drive.ts all` passes, Docker scenarios included.
      - `deploy-test.sh` deploys, and this build's scenarios pass with `HARNESS_TARGET_URL`, after their deployed-only branches are checked against the new invite refusals.
      - Workers Issues since the pass began show nothing new.

## Non-goals

- **The wake check (item 6):** fast-follow Item 15, after Q3 (D19).
- **Q3's other answers,** the post that ends a hung turn, which event frees the latch, and what bounds a wake check: Q3, after the multi-player happy path.
- **DI1's general `lmz.call()` tool and a tool that reads a tenant Star:** § *Future state*, with the structured yes for the first call that discloses.
- **The discriminator and steering a turn while it generates:** fast-follow Item 6.
- **A reply UI like Discord's,** which D23's byline stands in for: the backlog's row of that name.
- **Renaming § *Future state*:** a nit the second Stage 1 pass raised.

## Review progress

- **2026-10-15:** `/review-task` Stage 1 ran against the first framing (run `wf_14464a96-76d`). When this file replaced that framing on 2026-11-10, its findings were carried into the sections above or retired by the new design; git keeps them at `277c313`. Stage 1 should run again on this framing before phases are written.
- **2026-11-10, Stage 1 launched on this framing** as workflow run `wf_ad0fab75-2a7`, after a self-review fixed five defects the merge introduced. Its brief: findings that would mislead a builder or break a decision first, wording last, and no finding asking to decide Q3. Larry reviewed this framing lightly, since real users will change it fast.
- **2026-11-10, Stage 1 returned and its gate is applied.** All 42 findings survived verification and reduced to F1–F23. Larry decided F1–F10 and F13 one at a time, revising D6 and adding D10–D17; the author applied the rest. The gate added items 8 and 9 and the lifecycle definitions, so the file was reshaped, not lightly edited.
- **2026-11-11, Stage 1 ran again** (run `wf_b4127a1b-d7e`, after a self-review that fixed eleven defects the first gate's edits introduced). 63 findings were raised and 59 survived, merging into 25 items. Larry decided the five structural ones and two more one at a time: the closing step (D18), the agreement guarantee with a structured yes deferred to the first call that discloses (D2), the deadline interim and the wake check after the wipe (D19), `replyTo` kept beside `answers` (D20), the Galaxy's seed (D21), invite outcomes posted and dominion checked early (D22), and "wake check" for the wake case, with "decision" for answering posts that arrived mid-turn. The author applied the rest. Not done: renaming § *Future state*, a nit.
