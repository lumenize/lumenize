# High levels of agent agency in the agent loop

**Status:** Pass 1, settled 2026-11-10 (Larry), with Stage 1's gate applied; phases not written. Everything in it but catch-up gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md); catch-up builds last, once Q3 is decided. Nothing gates it.

## Objective

**Give the agent enough agency to keep making progress towards the chat participants' goals no matter the situation while still satisfying certain security requirements.** In response to a single participant's chat message is the most obvious condition. The next level of complexity involves two participants collaborating on the same goal. After that comes multiple participants focused on competing goals. Then there are anomalous situations, like when an AI call times out, the Galaxy restarts unexpectedly or awakens from hibernation. The agent may hit the tool call limit or some other constraint. Under all these conditions, the agent must be able to assess the situation and do something. We still want actions taken by the agent to be secure in particular ways. For instance, it must not be able to access tenant Star data without doing so under clear authority of a participant with that authority and only under claims that show the chat participant as the `sub` and the agent as the `act`.

## Context

Our philosophy on agent agency is the [Manifesto for AI Agency](../docs/vision/manifesto.md): seven "X over Y" lines, each argued in the doc it names. [`_ai-security.md`](../docs/vision/_ai-security.md) argues most of them, though it is a rough draft and already behind Larry's latest thinking, and [`auth.md`](../docs/vision/auth.md) has the details of who may do what. Three points from those lines bear on this task directly:

- **Every prior state is kept, but nothing restores one yet.** The temporal data model keeps every state a resource has been in. Git keeps every committed state of code and file-based configuration. No tool rolls either back yet, so only what cannot be undone, a disclosure or a change to who can do what, is bound to the post it answers (DI5).
- **Attribution has to survive a group chat.** Every resource change and every git commit is attributed to a chat participant. When it is unclear who in a group chat instructed the agent, the chat it judged from sits on the same timeline as the changes, if nothing ties them more explicitly. D6 and D15 tie them.
- **This task builds the innermost feedback loop.** Its feedback is the difference between the participants' latest goals and the current implementation, and its output is the next change to the codebase. A second loop around it comes later, improving the app's standing guidance: its skills, workflows, rules, vision documents and ADRs.

Today's code falls short in four ways:

- **B1. A post that arrives mid-turn starts nothing,** and waits for someone to post again (`#onChatCommitted` in `apps/nebula/src/galaxy.ts`).
- **B2. A turn's reply commits with the poster's claims and the agent as actor,** so the agent has nothing to post as when no person's call is there.
- **B3. The generation deadline posts nothing.** It releases the single-flight latch, and the turn keeps running.
- **B4. A turn an eviction kills is answered only if someone posts again.**

§ *Scenes* maps what each person sees to the claims behind it, § *What changes* lists the work, and § *Design intent* says what the work must keep true.

## Conventions

A list that other sections cite gives each item a prefixed ID: `DI` for an item of design intent, `B` for a blocker in today's code, `D` for a decision, and `Q` for an open question. IDs follow the order items were raised, not the order shown, and are never reused, so D2 is the second decision made wherever its row sits, and a gap such as Q1 is a question answered. A decision that answers an open question records it, as D1's "(was Q2)" does.

Three terms stay apart. An **access token** is the signed JWT a Client holds, and only Mesh's auth layer mints one. **Claims** are what a node reads from `callContext.originAuth`, which every `lmz.call` in a chain inherits unchanged. **Recorded claims** are what a write stores: the claims at the moment of the write, projected and kept as history, never read back to decide anything ([ADR-016](../docs/adr/016-record-the-acting-principal.md)). Live claims are never stored. Today's field is `actingToken` (D10). A step's claims are written *Jennifer + agent* for `{ sub: <Jennifer's sub>, act: { sub: 'agent:lumenize' } }`: the claims of a chain the agent starts for Jennifer, never an access token.

Four words name a turn's lifecycle (D12):

- **A turn takes up one post.** A post at an idle Galaxy starts a turn that takes it up. Only one turn runs at a time.
- **A decision is the first step of a turn the agent starts itself,** when a turn ends with posts still waiting. It reads the thread under the agent's own claims and picks which waiting post to take up; from the pick on, the turn runs inside that post's held call. With nothing waiting, nothing more runs.
- **A post is answered when an agent message names it** in `answers`. "Done, Jennifer: the lists page opens with a "Shared with me" section." answers Jennifer's post and not Austen's, though it follows both.
- **A post's claims are released when the turn that posted its answer ends,** or when the Galaxy is evicted.

## Scenes

The scenes about people live in [agent-first-ui.md](../docs/vision/agent-first-ui.md) § *Scenes*, where they outlive this task. This section maps each of them to the claims every step runs under, so § *Design intent* can be measured against them. It also holds the failure scenes, which test the loop itself and die with this task. Every row of § *Austen asks to invite a friend* runs on this build. § *Austen joins* needs a tool that reads a tenant Star, which no task adds yet (DI1).


### Austen joins

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Tries Austen's two questions | Austen + agent | Austen asked. **Refused** by passage into each tenant Star: her plain membership in `acme.crm` gives passage upward from `acme.crm` and none into `acme.crm.tenant1`. |
| Answers them | Jennifer + agent | Jennifer said yes to (a), and her Universe admin membership holds dominion over every tenant Star from `crm.acme.lumenize.dev`, the app's host. The call answers Jennifer's post, so it runs under her claims (DI5). The answer is her disclosure decision. |

### Two people, one goal

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Builds the "Shared with me" section | Jennifer + agent | Jennifer asked. Her `write` on the `chat` node is the floor for source and builds. |
| Keeps Austen's post waiting | Austen's, held in memory | Her post's own call carries them (DI2). |
| Builds who-shared-each-list | Austen + agent | Austen asked, and she meets the same floor. |

If the Galaxy is evicted before Austen's post is answered, her claims go with it, and catch-up finds her post unanswered, since "Done, Jennifer" names only Jennifer's. It is then answered as in § *The Galaxy restarts mid-turn*.

### Two people, different goals

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Sorts by when items were added | Jennifer + agent | Jennifer asked. |
| Holds back Austen's change | — | The agent's judgment: the two asks conflict. Jennifer's turn ends with one message answering both posts. |
| Answers Austen's "(c) works for me" and waits | — | Her post starts a turn at an idle Galaxy. The change needs both yeses, so it builds nothing, and its message, "Thanks, Austen. I'll build it once Jennifer agrees.", answers her post. |
| Builds the sort switch | Jennifer + agent | Jennifer's "Agreed" starts the turn, and both have said yes. If it lands while Austen's turn runs, the next decision sees both posts and may skip the line above. |

### Austen asks to invite a friend

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Makes the section collapsible | Jennifer + agent | Jennifer asked. |
| Tries to invite Riley | Austen + agent | Austen asked. **Refused**: only an admin of the app can invite someone into it, and Austen is a plain member. |
| Never hands the invite Jennifer's held claims | — | DI5: the decision took up Austen's post, so the invite runs under her claims, and no argument can name Jennifer's post. |
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

#### The tool-call limit

**Jennifer:** Let shoppers reorder items by dragging them.

**Studio's agent:** *(thinking... codegen...)*

*The agent uses all 32 of its tool-call rounds (`maxToolDepth`) for the turn, and its last build still fails.*

**Studio's agent:** I ran out of steps for this turn before the build passed. The last one failed compiling `ListView.vue`. Shall I keep going?

**Jennifer:** Keep going.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she said to keep going. *(codegen...)* Done: the build passes, and items can be dragged into a new order.

The post at the limit is the agent's own, and "keep going" is a new yes that brings Jennifer's claims again.

## Relationships

- **It gates [nebula-testing-with-personas.md](nebula-testing-with-personas.md)**, whose provisioning outcome and admin-invite outcome are the agent's own posts (DI3), and whose confirmation needs a quick yes acted on (DI2). Personas needs everything here but catch-up: the rename, the agent as a local principal, the `chat` node, the claims helper, held claims with the decision that takes them up, `deriveKind`, `invite` and `answers`. Catch-up (item 6) builds last, once Q3 is decided, since Q3 holds its stopping rule (D13).
- **Part of it changes stored data,** so it rides ⑥'s wipe: moving the chat off the root and seeding the agent's grant move existing `Message`s, grants and `ServedBuild`s, which sit on the root today. Row ② of the master plan carries the `data` gate for it.
- **It takes personas' item 9,** the invite rule, the `.dev` co-mint cleanup and the agent's `invite` tool (D11). Personas keeps `provision`.
- **It carries what personas' item 11 and its *The turn trigger* and *The agent's reply* bullets planned,** in this file's shape: claims Mesh builds (item 3), `deriveKind` (item 7), and turns that take up a waiting post with tools (D12, D14).
- **It builds most of the backlog's *Nebula as permission broker in chat* row:** a refusal as the person, a yes from someone who holds the permission, and acting on that yes under their claims. What stays open there is a tool that reads a tenant Star, and offering to upgrade the person instead. The row's @-mention parsing is not needed, since the agent's "@Jennifer" is its own text.
- **[ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md) (Proposed) commits what it builds on:** a node's orgTree as its one fine-grained access control, operations included, and the local principal. `docs/vision/auth.md` § *When the agent acts* states the model.
- **Personas' `asPersona` reuses the claims helper this task adds to Mesh,** which builds the seam the backlog's *Mesh has no public seam for running in-DO code under a call context* row asks for. `apps/nebula/test/test-apps/dev-studio/as-caller.ts` imports `runWithCallContext` for the same reason and is re-derived when the helper lands.
- **It replaces a decision of [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md)**, that a landing records its `ServedBuild` under `pinnedAtDoor` (D5). That archived file gets a dated superseded banner when `pinnedAtDoor` goes.
- **Catch-up's repeat on every wake is Q3's to bound, not the backlog's *Add retry + skip logic for alarm handler failures* row's.** Catch-up's job starts its turn detached and returns, so `triggerAlarms` deletes the alarm row before the turn can fail, and a count kept per row restarts on every wake.

## What changes

**Renamed first (D10), in one sweep with its standing guidance, so the tree never names both:**

- **Code:** `actingToken` becomes `recordedClaims`: the `Snapshots` column, the `meta` field and the Registry's log field. `ActingTokenRecord` becomes `RecordedClaims`, `WireActingToken` becomes `WireRecordedClaims`, `projectActingToken` becomes `toRecordedClaims`, beside `toWireRecordedClaims`, and `#buildActingToken` becomes `#buildRecordedClaims`. The `actingClaims` parameters in `auth-registry.ts`, which hold live claims, become `callerClaims`. The pre-alpha wipe recreates the column, so it needs no migration.
- **Standing guidance:** ADR-004, ADR-012, ADR-016 (whose naming bullet reverses), `_ai-security.md`, `security.md`'s reader list, `workflow.md`'s ADR-016 line, and `website/docs/nebula/api-reference.md`, after which the platform embed is regenerated.
- **The check:** `git grep -n -i 'actingToken\|acting token'` finds only archived files and dated history.

**New:**

1. **The agent as a local principal of the Galaxy (D4).** `agent:lumenize` holds `write` on the `chat` node, ensured with the tree on every wake by `#ensureRoot`'s `INSERT OR IGNORE`, which repairs a tree that lacks it. `revokePermission` refuses that grant, beside the root's refusals (D16). Mesh builds its claims, which carry `aud: 'acme.crm'` in the Galaxy `acme.crm` and no `scopeAdmin`, so `hasDominionOver` reads them on every orgTree check and finds nothing.
2. **A `chat` node of its own** under the root, at a fixed id as the root is, which `CHAT_NODE_ID` names. The harness sites that post Galaxy `Message`s at `ROOT_NODE_ID` move with it (`grep -rn ROOT_NODE_ID apps/nebula/harness`), and the `CHAT_NODE_ID` JSDoc in `chat-constants.ts` changes.
3. **Running a block under claims, in two forms.** Today `newChain: true` starts a chain with no `originAuth` (`buildOutgoingCallContext` in `lmz-api.ts`), and the call context is already held by `runWithCallContext`.
   - **Claims Mesh builds**, for an identity with no Registry membership. The agent's own (DI3) never leave the Galaxy: a call made under them starts a fresh chain, enforced in `buildOutgoingCallContext`. Personas' `asPersona` carries its claims onward, as a tab's do.
   - **A new chain under the claims of the call the node is running in, with its local principal prepended as the outermost `act`**, by `prependActor` (DI1, DI4). Inside a held post's continuation (item 4) those are the poster's claims. The node passes no claims, so it cannot compose them, and Mesh adds the actor, so a chain the agent starts for Jennifer cannot leave the agent off. Every `lmz.call` and in-node write inside it inherits them unchanged: `projectActingToken` records both on every node the chain reaches, a tenant Star and the Registry's invite record included, and `#buildActingToken` already projects the ambient claims for in-node writes.
4. **Held claims (DI2).** `#onChatCommitted` keeps, from inside the poster's call, a handle the Galaxy re-enters for each tool call that acts for that post, never a claims object it could compose; Pass 2 picks the mechanism. The claims are released when the turn that posted the post's answer ends. Each piece of work it starts gets its own `ctx.waitUntil`.
5. **A decision (DI7).** When a turn ends with posts still waiting, the agent starts the next turn itself. Its first step reads the thread under the agent's claims and picks one waiting post to take up, and from the pick on the turn runs inside that post's held call (item 4). The decision step, and any turn with nothing held, is offered no tools, so it reads, answers and asks (D14). Every tool call runs inside the held call of the post it acts for. A call DI5 covers runs under that post's claims and takes no argument naming a post, so the model chooses which post to take up but never whose claims such a call uses. Other work may name another held post and run under its claims (D1). A turn that needs DI5 work for two people's posts splits into two turns.
6. **Catch-up (DI7).** `onStart` reads the posts after the agent's latest message, under the agent's built claims and through the same read path as its own reads. Only if one is unanswered does it schedule a catch-up through `svc.alarms`, with a fixed id so repeated wakes do not stack. The job starts a turn detached, beginning with a decision and offered no tools, since nothing is held after a restart (D14), and returns, so it never holds up the certificate alarm, and `beforeTeardown` cancels it.
7. **`deriveKind` in `participants.ts` reads the subject (DI3)**, in the same change that makes the agent one. Otherwise the agent's first post as itself reads as human, gets a turn, and the agent answers itself forever.
8. **The agent's `invite` tool, with the invite rule it needs (D11), moved from personas' item 9.** It is the first named row of DI1's tool and the first call DI5 covers, so it takes no argument naming a post.
   - **Two paths, one per kind of collaborator.** An Austen-kind invite goes through `Resources.invite(chat node, [{ email, tier: 'write' }])`, which checks DAG `admin` at the chat node and answers within the turn. A Galaxy-admin invite goes through `AuthFacade.invite('acme.crm', [{ email, scopeAdmin: true }])` over `lmz.call`, and its answer lands in a Galaxy handler that posts the outcome as the agent (DI3).
   - **Only dominion invites into a Galaxy.** Today `AuthFacade.invite` admits a caller whose host is the target, so Austen, a plain member of `acme.crm`, may invite anyone into it. Into a Star, peers still invite.
   - **The `.dev` membership an invite mints beside the Galaxy's always carries the admin bit.** `issueInvites` sets it today only when the inviter has dominion over the Galaxy, so the branch that mints it plain goes, and an invitee already holding a plain `.dev` membership is promoted, since `#mintIdentity` returns an existing row unchanged.
   - **`LOOP_TOOL_ENTRIES` gains `invite`.** `LoopEntry` is a union of Galaxy method names and `AuthFacade.invite` is not one, so Pass 2 names the Galaxy entry the tool reaches, and the resource-surface test still asserts each named entry sits at the chat floor.
   - **Personas' three invite criteria move with it,** in § *Criteria — what the phases must satisfy* of that file, for Pass 2 here.
9. **An agent message names every post it answers (D12).** `Message.replyTo`, required on every agent message today (`chat-constants.ts`), widens to `answers`, a set, in ⑥'s ontology bump. Its three readers move with it: `App.vue`'s pairing of a post with its reply, `#historyBundle`'s, and Q4's byline. One named function decides whether a post is answered, and Studio's waiting state and catch-up both call it (`calibration.md` §12). A stream chunk keeps naming the one post its turn took up.

**Adapted:**

- **`commitAgentMessage`** writes under the agent's claims, without the `actor` and `pinnedAtDoor` options it passes today.
- **`#recordServedBuild`** writes as the agent (D5), and **`buildNow`** logs its caller's claims through `projectActingToken`, as `writeSource` logs each commit.
- **Each source commit names whose authority it used, twice (D15).**
  - **On the agent Message:** each `codegen.toolCalls` entry gains the post it acted for and the recorded claims it ran under, through the shared projection. The commit's oid, already in the tool's result, joins a commit to its entry. Studio renders *under Jennifer's authority* from this record, never from the model's text.
  - **On the commit:** `writeSource` passes the person whose claims the write ran under as git's `author`, by `profileId` (ADR-013's write-time display stamp), and `agent:lumenize` as `committer`. Pass 2 pins the email form. Its debug line reads the current claims rather than `#clientOrigin()`, which requires a chain that starts at a Client and would drop the claims of a chain the agent starts.
- **`#historyBundle`** reads under the agent's claims in a decision, labels the agent as itself rather than as a numbered human, and shows each post's id inline and the held claims in one block after the history, since what changes goes last.
- **Studio's byline and avatar stack,** which `App.vue` builds from the subject and the `act` chain (Q4).
- **Studio's waiting state.** `deriveTurnDisplay` gains *waiting*, held while another post's turn streams, and a post stops waiting when an agent message names it in `answers` (DI6). Today `App.vue` resets a post's 90 s idle window only on chunks replying to that post, so a waiting post shows *thinking…*, then *failed*, under a comment saying a skipped post is never answered.
- **The tool contract, `TOOL_CONTRACT` in `codegen-loop.ts`,** gains the rules for several people: say whose claims it is using, end every turn with a message naming in `answers` the post it took up and any other it addresses, and ask before acting on what it was not asked.
- **`security.md`:** the bullet on the verdict of the door that admitted the work loses the reply and the `ServedBuild`, which become the agent's own writes. What stays is that a turn's source writes and builds run on its post's verdict, while a Resources write inside a turn is checked live. The rule that no synthetic claims go into a chain a node started names the agent's built claims beside the persona's, and gains item 3's second form: a chain a node started may carry the claims of the call it was started in, with the node's local principal prepended, and never claims the node composes.
- **`prependActor`'s JSDoc** in `access-claims.ts` warns against prepending into a person's access token, not "a TOKEN", and names Mesh's new-chain form as its caller in place of the Resources plane.
- **Standing guidance to re-check at build:** `strategy.md`'s check 1, "never broader default access", which predates D1.
- **What asserts the old attribution:** `grep -rnE 'NEBULA_SUB|pinnedAtDoor|actingToken\.(sub|act)|deriveKind|deriveParticipants|single-flight' apps/nebula/test apps/nebula/harness`. Most hits invert, as `calibration.md` §3(b) expects; `source-chat-floor.test.ts` F5 and `served-build.test.ts`'s verdict case stay green on the agent's grant, so they are re-derived instead.

**Removed:**

- **`pinnedAtDoor`** in `TransactionOpts`, and the check Snapshots skips for it (D5).
- **The `actor` a write carries (D6):** `TransactionOpts.actor`, `ensureResource`'s `actor` option, the actor branch of `#buildActingToken` in `snapshots.ts`, and `turnContext` in `galaxy.ts`. The claims carry the agent instead. A direct `writeSource` call's commit line still carries no actor, because no chain the agent started is running.

**Kept as they are:** one turn at a time, a decision being part of a turn, and the generation deadline (Q3).

## Design intent

- **DI1.** Give the agent a tool that allows it to make any `lmz.call()` but only if it holds a user's claims, it attaches itself as the `act` on those claims, and only if it has clear authority from the user. It need not know the user's permissions before attempting the call on their behalf. If that call is denied for a lack of permission, it will need to adjust for instance, by asking a user who it believes has that permission if it's OK to satisfy that user who lacks its permission. In which case, it attempts the call under that new person's claims.

- **DI2. The agent holds a participant's claims only in memory, while it answers their post.** They arrive with the post's call and are released when the turn that posted the post's answer ends, or the Galaxy is evicted. They are never stored, since a stored scope set is a security bug ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)). So the agent can hold several participants' claims at once, one per post it is answering (D1), and holds none after a restart. The claims stay with the post because AsyncLocalStorage binds where a continuation is attached, not where its promise is created: attached when a decision picks the post instead, the continuation would carry the claims of whatever call was running then, Jennifer's, and Austen's would be lost.
- **DI3. The agent posts as itself:** `{ sub: 'agent:lumenize' }`, with no `act`, on its own `write` grant on the `chat` node ([ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)). The scene tables leave those steps out.
- **DI4. Everything else it does runs as *participant + agent*,** under the claims of a participant who asked for it or said yes when the agent proposed it. Which held claims to use is the agent's judgment (D1), except where DI5 decides.
- **DI5. A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post the agent is answering (D2).** The Galaxy picks those claims, not the model: the post is the one the decision took up, and such a call has no argument that names a post. A tenant Star is any Star under the Galaxy but `.dev`, which the call's target scope shows: in `acme.crm`, `acme.crm.tenant1` is one and `acme.crm.dev` is not. A call changes who can do what when it changes a membership, or a grant outside `.dev`. So `invite` is covered, and the source tools, `build`, and personas' `provision`, whose grants are the cast's in `.dev`, are not. The check still refuses claims that lack the permission, as it refuses Austen's for tenant data.
- **DI6. Every turn ends with an agent message that answers the post it took up.** So the next decision never takes up a post a message has already answered, and a recovery that dies again cannot loop. A person's post stops waiting, in Studio and for catch-up, once an agent message names it (§ *Conventions*).
- **DI7. A post at an idle Galaxy starts a turn, and a turn that ends with posts still waiting starts the next, beginning with a decision.** Any other wake reads the thread for unanswered posts and schedules a catch-up through `svc.alarms` only if it finds one. Which posts are answered is read from the thread's `answers`, never written per turn.

## Constraints

- **The whole chat is read every turn, so what changes goes last.** Until the agent has a memory, each turn reads the chat in full. Keeping what changes at the end of the prompt lets the model provider's prompt cache reuse everything before it.
- **`docs/vision/auth.md` § *When the agent acts*:** the agent writes as a person who asked or said yes, and talks as itself.
- **[ADR-003](../docs/adr/003-continuation-messaging.md):** work waits on the Galaxy's own latch, never across a hop, and a result handler's outcome travels as data in a continuation.
- **[ADR-016](../docs/adr/016-record-the-acting-principal.md):** an agent message changes no authority and destroys nothing, so it owes no record; work done as a person records that person, with the agent as actor.
- **`durable-objects.md` § *No mutable instance state*:** held claims are an ephemeral cache, since losing them leaves the post in the thread for catch-up.
- **`durable-objects.md` § *Initialization*:** `onStart` runs inside `blockConcurrencyWhile` on every wake, so it only reads and schedules.
- **`security.md`:** no client can name an actor or a subject.
- **`security.md` § *Delegation*, rule (1):** authorization reads the subject, its `access` and `aud`, never `act`, so the agent prepended as `act` gains nothing by it. The one check on `act` being present, the impersonation mint, refuses a chain the agent started, and the agent should never impersonate anyway.
- **No node checks the `exp` of claims inside the mesh;** only the `ClientGateway` does, for its socket. So held claims work until their post is answered, as `security.md` lets work a door admitted run to its end.
- **`calibration.md` §14:** the agent's authority is a grant in the tree, never a membership in the Registry.
- **`studio-guidance.md`:** the rules for several people are cross-turn policy, so they live in `TOOL_CONTRACT`.
- **`live.md`:** a `/live` scenario first. What is deterministic gates: claims held with their post, DI5's binding (while the agent works on Austen's post, no DI5 call reaches Jennifer's held claims), tools only inside a held call (mutation: give the decision step the tool list, and a source commit or Resource write naming `agent:lumenize` with no person reds the limb), catch-up's scheduling. Which post the agent takes up first is its judgment, and rides a limb that does not gate.
- **`calibration.md` §12:** whatever decides when Studio stops showing a post as waiting lives in a named function, as `deriveTurnDisplay` does.
- **Milestone:** pre-alpha. Everything but catch-up lands before personas, and catch-up follows once Q3 is decided.

## Future state

- **DI1's general form** is the backlog's *The model writes code that runs in a sandboxed Dynamic Worker…* row, whose proxy is item 3's chain under a held post's claims. Until then DI1 grows one named row of `LOOP_TOOL_ENTRIES` at a time, `invite` first.
- **Threads, which are sessions and branches.** The agent will encourage moving a piece of work into a thread. Unlike a thread in Discord or Slack, its first post is the agent's: a compacted summary of what in the main chat bears on the work, so the session starts with the context it needs.
- **A memory the main chat and every thread share.** What the agent learns about who can do what is a natural first thing to keep there.
- **A discriminator decides whether the agent answers at all.** Fast-follow Item 6 starts it with Cloudflare's Clef. It plugs in where a post arrives and where a turn ends.
- **Sub-agents do long work, and the chat agent stays the supervisor** (Larry, 2026-10-10). Its turns stay short, so a waiting post waits seconds rather than minutes, and each sub-agent runs under the claims of the post it serves.
- **Steering a turn while it generates** stays in fast-follow Item 6.

## Open questions

- **Q3. How does the loop recover when a turn fails?** Deferred until the multi-player happy path is settled (Larry, 2026-10-16), and catch-up builds after it (D13). What it has to answer:
  - **Who writes the post that ends the turn** when the model call hangs, or the turn uses all 32 of its tool-call rounds (`maxToolDepth`). The model cannot, so our own code must, with a fixed message or one more short model call.
  - **Which event frees the latch.** Today the 14-minute deadline frees it while the turn keeps running, and the abandoned turn may still write and land.
  - **What bounds a catch-up that dies before it posts.** Each wake would try again.
  - **What reconciles on wake:** fast-follow Item 6's *Consider reconciling on wake* bullet, which destroys a build box no build owns.
- **Q4. What does the byline say once the agent is the subject?** Today it reads *Lumenize for Jennifer*, built from the subject and the `act` chain. Recommendation: *Lumenize, re: Jennifer*, naming the authors of the posts in `answers`; *Lumenize* alone drops whom it answered. Two inputs: `participants.ts` says display derives only from `meta.actingToken`, while `answers` lives in the value, safe only because no client can write an agent message; and in `child3-post.test.ts`'s depth-2 case, "re:" must still show the coach.

## Decisions

| ID | Decision | Rejected alternative — why |
|---|---|---|
| D1 | The agent may hold several participants' claims at once, in memory and never in storage. It knows whose claims it holds, picks the best ones for the work, or asks the person whose claims it should use (Larry, 2026-10-16). (was Q2) Learning who can do what is less trial and error than it looks: every member of a Star can see who holds which grant in its tree ([ADR-008](../docs/adr/008-full-org-tree-visibility.md)), and the claims the agent holds say what each holder may do, since passage and dominion are computed from them. What it cannot read is the admin bit of someone whose claims it does not hold. | **Each piece of work runs under its own poster's claims, and nobody else's** (rejected 2026-10-15): the agent could not proceed under Jennifer's authority when Austen's claims are gone, and running a request under another person's claims is not in itself a defect. |
| D2 | A call that reads or changes a tenant Star's data, or changes who can do what, runs under the claims of the post the agent is answering, and the Galaxy, not the model, picks them. Everything else keeps D1's free choice (Larry, 2026-11-10). (was Q1) The check is hard on every call between nodes either way (Larry, 2026-10-16). This is prevention where the manifesto's Reversibility line keeps it, on what cannot be undone: a disclosure cannot be taken back, and an authority change can lead to one. What it removes is only the crossover, Austen's request carried out with Jennifer's power; misreading what Jennifer herself wanted remains, as in any one-person chat. | **Judgment alone, with attribution as the backstop**: a line from Austen, or one planted in `AGENTS.md`, could steer Jennifer's held claims toward Austen's request, and the Objective's "must not be able to" would become "is told not to". **Binding every call to the post it answers**: the same loss as D1's rejected alternative. **The model naming the post in each tool call** (rejected 2026-11-10, Stage 1): a steered model names Jennifer's post while answering Austen, and the chat and the record then disagree about whom the agent acted for. **The newest human post**: an unrelated "looks good" from Jennifer after Austen's request would carry it on Jennifer's claims. |
| D3 | The agent posts to the chat as itself: every agent message names `agent:lumenize` as its subject, with no `act`, and only server code runs under its claims (Larry, 2026-10-10). | **The poster as every agent message's subject**, as today: an outcome, and a decision the agent makes on its own, have nobody to post as. **The agent as subject only in its own turns**: two shapes of agent message. |
| D4 | The agent is a local principal of the Galaxy: `write` on a `chat` node of its own under the root, no Registry membership, and its reads and posts pass the same DAG check as anyone's (Larry, 2026-10-15). The grant shows in the tree, cannot be revoked (D16), and covers the conversation and nothing a later node beside it holds. | **A server read with no check**, confined to the chat by hand: a second read path every later rule skips. **A Registry membership**: the login `auth.md` objects to, with passage and dominion to confine. **`read` alone**: leaves a post's check skipped. **The chat on the root**: a chat-floor grant would cover everything the tree ever holds. |
| D5 | A landing's `ServedBuild` is the agent's write, under its grant on `chat`, and `pinnedAtDoor` goes; `buildNow` logs its caller's claims (Larry, 2026-10-15). Every Studio on the app hears a landing through that record, and only a revoked grant refuses it. | **Keeping `pinnedAtDoor`**, as [nebula-build-reaches-every-studio.md](archive/nebula-build-reaches-every-studio.md) decided on 2026-10-13: a check the Resources plane skips on our own server's say-so. **Writing the record as the build's caller**: a grant revoked mid-build refuses it, and other Studios stay on the old build. |
| D6 | A write the agent makes for a person names the agent as actor (Larry, 2026-10-15). A record carrying only the person names the one acted upon as the one who acted, and undoing a bad turn finds its writes by that attribution. The agent rides on the claims: where the loop dispatches a tool, it starts a chain under the person's claims with the agent prepended as `act`, and every record on every node the tool's calls reach projects both (Larry, 2026-11-10, Stage 1). | **An `actor` option on each write**, as `ensureResource` has today: no `lmz.call` carries it, so a tenant Star's record and the Registry's invite record name the person alone. **An `actor` field beside the claims in the call context**: a second carrier that every record site would have to merge. **Recording the agent's part once per turn, on its reply**, which no write points to. |
| D7 | The agent meets every gate the chat floor guards, bounded by what runs under its claims: its posts, a landing's `ServedBuild`, its reads of the thread, and a result handler's outcome post (Larry, 2026-10-15). Source lives in the Workspace's git tree, and `requireChatWrite` only borrows the chat node's grant as its floor. | **A node of its own for source**, with nothing in the tree to hang it from. |
| D8 | A turn a reset kills is answered after the restart, not run again. The agent reads the recent messages, decides what to address, and asks whether to proceed; a yes runs as whoever sends it. A decision starts in memory when a turn ends, and only catch-up schedules an alarm (Larry, 2026-10-15). | **Running the killed turn again as the agent**, on its post's verdict: it acts on source with no live person. **Running it again from the poster's stored claims**: ADR-016 forbids stored claims as an authz input. **A marker and an alarm written as every turn starts**: storage writes are the dominant cost. |
| D9 | Whether the agent answers at all is decided later, by a discriminator; until then every person's post is answered (Larry, 2026-10-10). | **Building the discriminator now**: with pre-alpha's few users a turn per post is affordable, and the discriminator is a cost optimization (fast-follow Item 6). |
| D10 | The record a write stores is `recordedClaims` (Larry, 2026-11-10, Stage 1). It holds claims, not a token, and since D6 the agent's `act` in it was never in any token. `recordedClaims.sub` reads as those claims' subject, with no role to invert, and "recorded" marks it as history, so "live claims are never stored" needs no qualifier. | **`actingToken`**, chosen 2026-07-29: no access token carries the agent's `act`. **`actingClaims`**, tried before it: it contradicts DI2's "never stored", and live-claims parameters already carry the name. **`actingPrincipal`, `actedBy` or `actor`**: role names, whose `.sub` reads as the actor but holds the person acted upon (ADR-016). |
| D11 | The agent's `invite` tool and the invite rule it needs move here from personas. It is the first named row of DI1's tool and the first call DI5 covers, so DI5's binding is built with a real consumer and the invite scene runs on this build (Larry, 2026-11-10, Stage 1). | **Deferring DI1 and leaving `invite` in personas**: DI5's binding would be built with no consumer and no gating limb, a shape the next task would have to relearn. **A general `lmz.call` tool now**: it breaks `LOOP_TOOL_ENTRIES`' rule that a tool reaches only the entries the table names, DI5 would have to classify an arbitrary method at dispatch, and each call's result arrives in a result handler after the turn has moved on (ADR-003). |
| D12 | A turn takes up one post; a decision is the first step of a turn the agent starts itself when posts are still waiting; a post is answered when an agent message names it in `answers`; and its claims are released when the turn that posted its answer ends (Larry, 2026-11-10, Stage 1). A post that arrives at an idle Galaxy and cannot be acted on yet gets an answer that says so, as Austen's "(c) works for me" does in § *Two people, different goals*. It settles the bullet Q3 had on finding work announced but never finished. | **"Answered" as any agent message following the post**: "Done, Jennifer" follows Austen's post, so her claims would go before her build. **A decision as a model call of its own before each turn**: a solo user pays for it after every turn. **A turn that ends without answering the post it took up**, as the vision scene first showed: it needs an in-memory mark, or the Galaxy restarts a turn on that post forever, and DI6 loses its guarantee. |
| D13 | Everything in this file but catch-up gates personas, and catch-up builds last, once Q3 is decided (Larry, 2026-11-10, Stage 1). Held claims do nothing without the decision that takes a waiting post up, and personas' provision confirmation is a yes that arrives mid-turn. Without catch-up, a turn an eviction kills is answered only when someone posts again, as today. | **Catch-up, Q3 and the failure scenes in a follow-on file**: a new file, and the failure scenes leave the loop they test. **The whole file gating personas**: personas would wait on Q3, which is deferred until the multi-player happy path is settled. **Decision points after personas**, as Relationships first read: held claims would arrive with nothing to take them up. |
| D14 | A loop tool runs only inside the held call of the post it acts for. The decision step, and any turn with nothing held, is offered no tools (Larry, 2026-11-10, Stage 1). A loop tool calls its Galaxy entry in-process, where no decorator's check runs, and the agent's own `write` on `chat` would pass the source floor anyway, so D7's list of what runs under the agent's claims is otherwise enforced nowhere. | **A check at dispatch refusing a call under the agent's own claims**: a guard on a path that offering no tools removes. **Letting the agent's own claims run tools, with attribution as the backstop**: its commits would name the agent alone, which D8 rejects. |
| D15 | Each source commit names whose authority it used in two places: the agent Message's `codegen.toolCalls` entry records the post and the recorded claims, and the commit's git `author` is that person, with `agent:lumenize` as `committer` (Larry, 2026-11-10, Stage 1). Before D3 the agent Message's record named the poster, and it was the only link; the manifesto and § *Context* both promise that the commit itself names the person. | **The Message alone**: a repo that leaves the Durable Object, by export or a fork, names nobody. **The commit alone**: a git author carries no `access`, `aud` or full `act` chain, which ADR-016 records. |
| D16 | `revokePermission` refuses `agent:lumenize`'s grant on `chat`, beside the root's refusals, and `#ensureRoot` ensures it on every wake (Larry, 2026-11-10, Stage 1). (was Q5) No Studio surface changes a grant, and under *Chat over components* the agent is the product's way to change one; with its grant gone it can neither read the thread nor post, so it never hears a request to restore it. Wanting the agent quiet is D9's discriminator, or a mute, never a revoke. | **A revoked grant means the agent is off for the app**, Q5's first recommendation: only a developer's direct `setPermission` call brings it back. **A re-enable path**: a kill switch and its undo, for a need nobody has raised. |
| D17 | The `chat` node refuses nothing the root refuses: delete, move and rename stay open, and a UI that later exposes them warns ([ADR-015](../docs/adr/015-passage-and-dominion.md)) (Larry, 2026-11-10, Stage 1). (was Q6) Each can be undone: delete sets a flag nothing reads yet and `undeleteNode` clears it, a move is reversed by moving it back, and the chat is keyed by a fixed id, so a rename changes nothing. D16's refusal differs because a revoke removes the only surface that could undo it. | **Refusing them as the root does**, Q6's first recommendation: an authorization refusal on actions that can be undone, which ADR-015 rules out. |

## Review progress

- **2026-10-15:** `/review-task` Stage 1 ran against the first framing (run `wf_14464a96-76d`). When this file replaced that framing on 2026-11-10, its findings were carried into the sections above or retired by the new design; git keeps them at `277c313`. Stage 1 should run again on this framing before phases are written.
- **2026-11-10, Stage 1 launched on this framing** as workflow run `wf_ad0fab75-2a7`, after a self-review fixed five defects the merge introduced. Its brief: findings that would mislead a builder or break a decision first, wording last, and no finding asking to decide Q3. Larry reviewed this framing lightly, since real users will change it fast.
- **2026-11-10, Stage 1 returned and its gate is applied.** All 42 findings survived verification and reduced to F1–F23. Larry decided F1–F10 and F13 one at a time, revising D6 and adding D10–D17; the author applied the rest. The gate added items 8 and 9 and the lifecycle definitions, so the file was reshaped, not lightly edited.
