# A turn is stored round by round, and continues from storage

**Status:** ready for `/build-task`. Stage 1 was resolved with Larry on 2026-11-17, and Stage 2 ran twice, on 2026-11-17 and 2026-11-18, with both passes applied. D14 and the edits that followed the second pass have had no panel since, so `/build-task`'s verifiers are their first review. The build ratifies no ADR: Larry holds every ratification until pre-alpha launches. Its backlog row, *A turn an eviction cuts off resumes where it stopped* in [backlog.md](backlog.md) § *Other Nebula backlog*, goes in § *Phase 7*.

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D3 is the third decision made, wherever its row sits.

## Objective

**A turn of Studio's agent no longer lives in the Galaxy's memory. Each round is stored as the model's reply arrives, and the turn continues from storage when a tab answers or the Galaxy wakes.**

Take a turn on the app `acme.crm`, working on Austen's post *"check that Gerry can see his own deals"*:

| Round | What the model asked for | Stored when |
|---|---|---|
| 1 | `read_file src/App.vue` | its reply arrives, and again when the file is read |
| 2 | `write_file src/App.vue`, then `build` | its reply arrives, after the write, and after the build reports |
| 3 | `run_in_tab gerry`, code that lists his deals | its reply arrives, and again when Gerry's tab answers |

Suppose a deploy resets the Galaxy while round 3's call is out. Today the turn is gone. Nothing records its three rounds, Austen's post shows as waiting, and nothing happens until someone posts again. After this task, Austen's Studio reconnects and the Galaxy finds the turn in storage. It answers the tab call as lost, and round 4's model call is the first thing it pays for.

## Context

Larry, 2026-11-12: *"any time you need to hold a DO awake, you've designed it wrong."* A turn is the one place the Galaxy still does. `runCodegenLoop` is a single function call that runs for the whole turn, up to `DEFAULT_LOOP_CONFIG.maxToolDepth` rounds, 64 today, and 14 minutes, with the model's transcript in a local array. `ctx.waitUntil` keeps the Galaxy in memory for it.

The model itself never waits. It answers one request, and our loop does the waiting: for the next model call, for a build, for a tab. So between any two model calls a turn is only a transcript and a place to continue from, and that fits in storage.

The personas build made this pressing. `run_in_tab` asks a Studio tab to run code, which makes it the first tool call that leaves the Galaxy: it is sent to another node with a result handler named, and nothing here awaits it. A build and a model call are awaited where they are made, so by this meaning they have not left. It was built waiting in memory for the tab's answer, which `mesh.md` forbids for every other call and marks TEMP for this one.

These things in today's tree stand in the way:

- **B1.** `runCodegenLoop` (`apps/nebula/src/codegen-loop.ts`) keeps a turn's transcript, its record of tool calls and its counters in local variables until the turn ends.
- **B2.** A turn's tool calls are written once, on the agent's `Message`, as `codegen.toolCalls`. A turn that never reaches its end records none of them, so nothing says what it wrote or whose claims its calls ran under.
- **B3.** `Galaxy.#tabAnswers` holds a promise per tab call, and `onTabAnswer` wakes it. An eviction loses both.
- **B4.** `Galaxy.#takenUp`, the posts running turns took up, is a field on the instance. An eviction empties it while the post it named still waits.
- **B5.** A `read_file` call records the file's size, `{ path, bytes }`, and not the content the model was sent. So today's record cannot rebuild what the model saw.
- **B7.** `Galaxy.#turnInFlight`, the flag that keeps a Galaxy to one turn at a time, is a field on the instance. An eviction clears it while the turn it stood for is unfinished.
- **B6.** An eviction skips the turn's `finally`, which is what destroys the build box. Cloudflare stops a container shortly after its Durable Object goes inactive when no inactivity timeout is set, and the Galaxy sets none, so the box is not left running for long. A Galaxy that wakes at once can still find it up, and the run that continues the turn destroys it as it ends, as every run does.

The rest of this file says what a round holds, what the turn's own row holds, how a turn continues from the two, and what a waking Galaxy does first.

## Goals

- **A restart pays again for no model call that had returned.** Today an eviction at round 20 loses twenty model calls and the turn with them. After this, a reply is on record before its tools run, so only a model call cut off before it returned is made again.
- **No call waits in memory for an answer from outside the Galaxy.** Today `run_in_tab` does (B3). After this a turn waits in memory on a model call and on a build, each awaited where it is made, and on nothing sent to another node.
- **A turn's record exists while the turn runs.** Today a turn cut off leaves no trace of its calls (B2). After this, each round is on record before its tools run, and each call's result joins it with the claims the call ran under.
- **What a turn has done is read from storage, never remembered.** Today the instance holds it (B1, B4), so an eviction and a hang look alike from outside.

## Relationships

- **[archive/nebula-personas-are-real-members.md](archive/nebula-personas-are-real-members.md)**, kept and archived on 2026-11-16, built the in-memory tab wait as a temporary one, its D23. This task removes it.
- **[nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*** lists what a recovering turn has to decide first. This task decides those for a turn that has a row. Item 15 keeps the posts that no turn took up, a decision between turns that an eviction cut off, and telling the person what a cut-off turn left uncommitted.
- **The same file's § *Item 17: Turn-log inspection v0*** reads a person's `Message` Resources to see how their builds went. After this it reads their rounds too.
- **[nebula-pre-alpha.md](nebula-pre-alpha.md) § *③ Capture live*** names the harvest as each `Message` with its `codegen`, and says a turn that dies at the deadline is never captured. After this task a cut-off turn's calls are on record round by round, and the harvest is the `Message`s and their `Round`s.
- **It supersedes** the [backlog.md](backlog.md) row *A turn an eviction cuts off resumes where it stopped*, and the TEMP bullet on `Galaxy.runInTab` in `.claude/rules/mesh.md`. § *Phase 6* replaces the bullet and § *Phase 7* removes the row.
- **It changes the Galaxy's tree:** a `turns` node beside `chat`, and every invite at `chat` also grants `read` there (D14).
- **It answers these of Item 15's questions:** who writes the post that ends a turn (DI9, DI13), which event frees the latch (DI13, DI14), and what bounds a wake that dies before it posts (D6). § *Phase 7* rewrites that item to what is left.
- **It owes edits elsewhere**, all in § *Phase 7*: the wording of § *③ Capture live* and of Item 17, the note on today's code in `docs/vision/auth.md` § *When the agent acts*, and what `docs/vision/_ai-security.md` and `.claude/rules/security.md` say a turn's message records.

## Current state

Built already, and what becomes of each part:

- **The work of one round** in `runCodegenLoop`: parsing the model's reply, validating each call, the two loop detectors, dispatching each tool, and the feedback after a build. **Carried over.** The `while` around it and its local variables are left behind.
- **`modelText`** (`codegen-loop.ts`), the one place a tool's result becomes the model's text. **Carried over unchanged.** It is what rebuilds a tool message from a stored result.
- **`Galaxy.actUnder`**, which runs a tool under the claims recorded on the post a turn took up. **Carried over unchanged.** It reads those claims from storage, so a waking Galaxy needs nobody's token to continue.
- **`Message.codegen.toolCalls`** and its readers: `toolCallMarks` in `participants.ts`, which Studio shows, and several `/live` scenarios. **Adapted:** the calls move to rounds, and the readers follow.
- **`#tabAnswers` and `onTabAnswer`** (B3). The handler is **adapted** to write to storage, and the map is left behind.
- **`#takenUp`** (B4). **Left behind:** the post a turn took up is on its row.
- **`#turnInFlight`** (B7). **Adapted:** it says only that a run not cut off by its deadline is live in this object (DI14).
- **`GALAXY_TREE_SEED`** and the plane's node invite. **Adapted:** the seed gains the `turns` node, the agent's protected `write` there, and a declaration that an invite at `chat` also grants `read` at `turns`, which the invite honours (D14). Collaborators arrive by more than one path: `Galaxy.invite`, the agent's tool, and the plane's own `invite` at `chat`, which `apps/nebula/harness/lib/chat-cast.ts` and several scenarios call. The seed covers both.
- **The generation deadline, the turn's heartbeat and the transient `streamProgress` push.** **Carried over.** Token deltas stay off storage.
- **The decision between turns, and the closing step.** **Carried over.** A decision is one model call and stores nothing.

Missing:

1. A `Round` type in the chat ontology (`CHAT_MESSAGE_TYPES`).
2. A row per running turn, in the Galaxy's raw storage.
3. A way to run one round from stored state, in place of the loop that runs them all.
4. A result handler for a tool call that leaves the Galaxy, which records the answer and continues the turn.
5. A waking Galaxy that finds a turn's row and continues it.
6. A one-time read of a query in the Resources plane (D13), and a node invite that also writes the grants its host's seed declares for that node (D14).

## Design intent

The core is Larry's, and § *Decisions* holds it. Each item below that rests on a decision names its D row. An item that names none is the drafter's, and Larry's to overrule.

- **DI1. A turn is its row and its rounds.** The row is written before the first model call. A `Round` is written for each round (DI3). Between rounds nothing about the turn lives on the instance.
- **DI2. A round holds what the model returned and what each call came to.** That is the model's text and reasoning for the round, each tool call as the provider returned it, whole, and each call's result or error with the post it acted for and the claims it ran under. The provider's object carries the call's id, name and argument text as the model wrote them, so the arguments are stored once and parsed when read. A `read_file` records `{ path, bytes, oid }`, where `oid` is the git blob id of the content the model was sent, and the content itself stays in the Workspace's git store (D5). Every round is a new Resource at the `turns` node (D14), written by the agent as itself.

  ```ts
  // Round 3 of the turn above, as first stored, with its call out to Gerry's tab.
  {
    chat: '…',            // the app's one chat, as on a Message
    message: '6f0c…',     // the agent Message this turn will commit (DI9)
    index: 3,
    text: 'I will check what Gerry sees.',
    calls: [{
      raw: { id: 'call_7', type: 'function', function: {
        name: 'run_in_tab', arguments: '{"tab":"gerry","code":"…"}' } },
      // no `post`, `claims`, `result` or `error` yet: they arrive with the answer
    }],
  }
  ```

  Round 1's one call, once the file is read, shows what a `read_file` records:

  ```ts
  { raw: { id: 'call_1', type: 'function', function: {
      name: 'read_file', arguments: '{"path":"src/App.vue"}' } },
    post: 'a81e…',      // Austen's post
    claims: { sub: '…austen', profileId: '…', act: { sub: 'agent:lumenize' } },
    result: { path: 'src/App.vue', bytes: 2140, oid: '3f2a…' } }
  ```

  The closing step, the one model call a turn makes after its loop when posts arrived while it ran, is stored as the turn's last round. That round names each post it was shown with the `validFrom` it read, so a rebuild writes the same request and the `Message` answers the same snapshots.

- **DI3. A round is written when the model's reply arrives, and again as each call's result lands** (D8, D12). Each write after the first is a new snapshot of the same round (ADR-004), and a call's `post` and `claims` join the round with its result, since they are the claims it ran under. Each write names the `validFrom` of the snapshot it builds on (D14). A repeat of the same write is recognized as one (ADR-005), and any other conflict means another writer changed the round, so the turn ends with DI9's fixed line and nothing is retried. A round whose reply asks for no call ends the turn and is written once. In the example, round 2 is written three times: at the reply, after the write, and after the build.
- **DI4. The turn's row holds only what no round holds, and is deleted when the turn's `Message` commits.** That is the opening prompt as the model was first sent it, the post the turn took up with the `validFrom` it read, the agent `Message`'s id, the posts the model was shown with the `validFrom` of each, which the closing `Message` answers by, the source commit the turn started from, and the index of each round whose model call was cut off (D6, DI8).

  ```ts
  // The row of the `acme.crm` turn, which no eviction has touched yet.
  {
    prompt: [/* the messages the model was first sent */],
    post: { id: 'a81e…', validFrom: '2026-11-17T15:02:11.482Z' },
    message: '6f0c…',
    read: { 'a81e…': '2026-11-17T15:02:11.482Z' },   // each post shown
    sourceCommit: '9b1d…',
    interrupted: [],      // [4] if a later deploy cuts round 4's model call off
  }
  ```

- **DI5. Everything else the loop carries between rounds is worked out from the rounds.** The model's messages are rebuilt from the opening prompt and each round, through `modelText`. The round count, the files written, the last build, the detectors' memory of earlier calls and text, and whether the last build failed, so that the next round is told to fix it, all come from the same rounds. The row's list of interrupted rounds is the one thing kept there, since an interruption leaves no round to count (D10).
- **DI6. A tool call that leaves the Galaxy names a result handler, and nothing waits for it** (D3). The handler carries the turn's id, which is the agent `Message`'s id, the round's resource id and the `validFrom` it was dispatched from, the call's id, and the address of the tab it asked. It writes the answer onto the round as the agent, naming that `validFrom` (DI3), and continues the turn from storage. An answer for a turn with no row, or a row naming another turn, is dropped. `run_in_tab` is the only such call today, and `build` could become one (§ *Beyond this task*).
- **DI7. Where a turn stands is read from its rounds, in this order.** A stop recorded in the last round ends the turn first: a `mark_complete`, the repeated call the detector stopped at, or a second failed container step, each of which records a result saying so, or a call whose error says the post the turn took up moved on (D15). Otherwise the first call with no result is next. If every call has one, the next model call is next. A turn that has ended goes to the closing step when posts arrived while it ran, and to the commit when none did, and a closing round is followed only by the commit. Nothing stores a position, so a handler, a wake and the ordinary next step all continue the same way.
- **DI8. A waking Galaxy that finds a turn's row settles what the eviction left, then continues** (D9).
  - **When it wakes.** When anything next constructs the Galaxy: its `onStart` finds the row (D17). An eviction, a hibernation and a code update each construct the object again, in the same isolate or a new one, and whatever reaches it next constructs it: a Studio reconnecting, a page load, a Star asking for its ontology on behalf of a page whose version it has not installed (in pre-alpha the `.dev` Star), an alarm, or a teardown. That is what D9's "next call" means here.
  - **A call cut off.** Once the object is constructed again, every call in flight is gone, a tab's included, since the Gateway's record of it was in memory. At most one call was in flight, the first with no result. It is answered as interrupted and never run again (D4, D12), and the calls after it run. Its error on the round is the record, and it tells the model the call may have run and files may have changed.
  - **A model call cut off**, the closing step's included, is made again. No round records that, so the row first records the round's index (D6), and a rebuild puts a note saying so after the round before. A closing call cut off twice commits the turn's own last reply and leaves the arrived posts waiting, as a failed closing call does today.
- **DI9. Every turn that has a row ends in an agent `Message`.** A turn that cannot go on says so in a fixed line of ours, the way a turn that uses every round it is allowed falls back to one today. That covers a turn interrupted twice at one round (D6), a run past its deadline (DI13), a round write that conflicts (DI3), and a run that throws for any other reason. So the `message` a round names exists once the turn has ended, and Austen never waits on a turn that is gone. A waking Galaxy that finds the `Message` already committed deletes the row and does nothing else.
- **DI11. The `Message` stays the crafted reply.** It keeps `content`, `thought`, `answers` and the turn's summary in `codegen`: the model, the source commit, the round count, how the turn stopped, the files written and the last build. `toolCalls` leaves it whole. Studio reads a message's tool-call marks from that turn's rounds, by a one-time read of `{ typeName: 'Round', filter: { message } }` (D13).
- **DI12. The deadline bounds each run of a turn, not the turn.** Today 14 minutes covers the whole turn, set by the 15 minutes `waitUntil` holds one promise. A run is what a turn does from one event to its next wait: in the `acme.crm` turn, rounds 1 to 3 are one run, and Gerry's answer starts a second. Each run has a deadline of its own. What bounds the turn is `maxToolDepth`, its cap on rounds, and D6 ends one that is interrupted twice at the same round.
- **DI13. A run that reaches its deadline ends the turn.** Our own code commits the agent `Message` with DI9's fixed line and deletes the row, which is the target `#takenUp`'s own comment names. No decision follows it, as none follows a cut-off turn today. The run it cut off may still be going. Before it dispatches a tool or writes a round it checks that the row names its own turn, by the agent `Message`'s id, and stops when it does not. A run stopped that way commits nothing and deletes nothing, since the row there may be the next turn's.
- **DI14. A turn is in flight for as long as its row exists, and only whether a run is live stays on the instance.** The commit trigger and the decision read the row, so a post that arrives while a tab call is out starts no second turn. `#turnInFlight` says a run not cut off by its deadline is live in this object (B7). Every run entry sets it before its first `await`, so two entries cannot both start a run, and only `onStart` wakes a row, where nothing has run yet (D17). Losing the flag in an eviction is the signal and not a fault.
- **DI16. The warm, the build box and the heartbeat belong to a run.** The first write of a run warms the box, every run destroys it as it ends, a run that ends to wait for a tab included, and the heartbeat beats for the length of a run. Nothing beats while a tab call is out, which the Gateway bounds at 30 s.
- **DI15. Rounds sit at a `turns` node where only the agent and the app's admins can write** (D14). The node is a sibling of `chat` under the root. The agent holds a protected `write` there, as it does at `chat`, and the Galaxy's seed declares that every invite at `chat` also grants `read` at `turns`, so a collaborator sees a turn's calls and cannot write one, whichever path invited them. An admin's write is recorded as theirs and trusted as their dominion is (ADR-015).
- **DI17. Every run is the agent's.** A run started by a post, a tab's answer or a wake runs under `lmz.asLocalPrincipal(NEBULA_SUB, …)`, the store reads and writes rounds as the agent, and each tool runs inside `actUnder(row.post)`, as today.

### Claims this rests on

- **C1. Nothing checks that an id a resource names exists.** A field typed as another ontology type is validated as a string id (ADR-006) and nothing reads the store for it. So a round can name the agent `Message` before that `Message` is committed. Checked 2026-11-15: an ontology's `relationships` reach only the generated validator.
- **C2. The model's messages are a function of the opening prompt and the rounds.** Each message the loop sends comes from one of these: the model's own reply, a tool's result through `modelText`, or build feedback computed from the build's report and the files written. Checked 2026-11-15 by reading every `messages.push` in `runCodegenLoop`. One exception was found, B5, and D5 answers it. A round keeps the provider's tool call whole, so whatever else it carries survives, and DI2's closing round carries what the closing step adds. Proved against a stored `Round` and the real provider only once § *Phase 4* runs.
- **C4. A turn's tools need nobody's live call.** Checked 2026-11-15 by reading `runCodegenTurn`: every tool dispatch goes through `actUnder`.
- **C5. Each run of a turn gets a hold of its own.** A handler's call and a wake are each a new event, so each can hand `waitUntil` a new promise. Not measured.
- **C9. A Galaxy a deploy restarts mid-turn is reached again with no one acting.** Since 2026-10-30 Cloudflare defers a Durable Object's code update by up to 300 s by default, so a deploy cuts a turn only if a run is still going then. An update deployed with `--durable-objects-code-update-mode immediate`, or a runtime update, cuts it at once and closes its sockets, so an open Studio's reconnect is the upgrade that wakes it. Nothing has measured an active Galaxy, and § *Phase 7* does.
- **C7. A blob the Workspace already holds costs nothing to record again, and reads back cheaply.** `@cloudflare/computer` 0.9.0's git client has `hashObject({ dir, content, write: true })` and `catFile({ dir, oid })`, read in its installed types on 2026-11-17. Measured on 2026-11-18 by `turn-rounds.test.ts`: a blob the store already holds writes no row, and a new one wrote one row each to `vfs_blob_bytes`, `vfs_blobs`, `vfs_chunks` and `vfs_manifests`, and two each to `vfs_dirents` and `vfs_nodes`, the object's file and its directory. A blob no commit points at read back after a later `writeSource`, and nothing in the Galaxy runs a git gc. Not measured: what a `catFile` costs once the repo is packed. A platform doc's blob is one no commit points at, and D5 accepts that it stays for good.
- **C6. An eviction can be tested where storage survives it.** The vitest-plugin lane's `ctx.abort()` keeps storage and a local `wrangler dev`'s wipes it (`durable-objects.md`). `waiting-posts.test.ts` already resets a Galaxy mid-turn there.

## Constraints

- **ADR-003:** no node holds a reply promise open across a hop. It is why the tab wait goes, and why the handler carries ids and an address and no transcript.
- **ADR-004 and ADR-006:** a round is a snapshot sequence, its second write is a new snapshot, and it names its chat and its `Message` by id.
- **ADR-002:** a result is stored as the value itself and becomes text only in `modelText`.
- **ADR-016 and ADR-025:** each call's record names the claims it ran under, and the agent writes each round as itself, under its own grant at the `turns` node.
- **ADR-005:** each round write names the `validFrom` it read, and a repeat is recognized as one (D14).
- **ADR-001:** `Round` is declared in `CHAT_MESSAGE_TYPES`, and the change bumps `CHAT_MESSAGE_ONTOLOGY_VERSION`.
- **`durable-objects.md` § *Wall-clock billing* and § *No mutable instance state*:** no design depends on a Durable Object staying awake, and storage is the source of truth.
- **`live.md`:** the scenarios come first. A `/live` scenario runs a turn and reads its rounds as they are written. Which tool the model calls is its own choice, so an eviction at a chosen round is gated in the lane that scripts the model's output, where a reset keeps storage (C6). A local `wrangler dev` wipes storage on a reset, so the eviction's own `/live` scene is deployed: a second deploy with an immediate code update while a turn runs (C9).
- **The gate is `data`, before the first invite** (Larry, 2026-11-17). `toolCalls` moves off `Message.codegen` and the chat ontology's version bumps, so this lands before the wipe or production is wiped again after it ([nebula-pre-alpha.md](nebula-pre-alpha.md) § *What remains*). Every captured turn then has one shape.

## Beyond this task

- **`build` can leave the Galaxy the same way.** It is the longest wait a turn has after the model. A round's call with no result yet is not particular to tabs, so a build that names a result handler needs no new shape.
- **Studio can show a call that is still out.** Each result reaches a round's subscribers as it lands (D12), so one live query on the running turn's rounds would show its calls as they happen. That is later work.
- ⚠️ Design consideration: **an alarm could continue a cut-off turn that nobody is watching.** D9 leaves it to the next call. An alarm adds no stored shape, so it can come later without a wipe.
- ⚠️ Design consideration: **the model call could leave too**, if Cloudflare offers a callback that streams. On 2026-11-12 neither AI Gateway's background runs nor Workers AI's async queue did.

## Open questions

None are open. Q1 was answered as D5 and Q2 as D6.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | The per-round record is named `Round` (Larry, 2026-11-15). | `TurnRound` repeats what its reference to the turn says. `Step` is what the loop already calls a progress line. |
| D2 | A round is a Resource, a new one per round. The opening prompt sits in one raw row per turn (Larry, 2026-11-14). | Raw storage for the rounds too. As a Resource, a round reaches the chat's subscribers and records who wrote it with no code of ours. One transcript Resource updated every round: each update would store the whole transcript again. Keeping the opening prompt after the turn: a replay assembles a new one from `codegen.sourceCommit`, which is what the nightly loop does. |
| D3 | The transcript stays in storage, and the result handler carries two ids (Larry, 2026-11-14). DI6 lists what it carries now. | Carrying the transcript in the handler, out and back: it is large, and it belongs in storage. |
| D4 | A tab call still unanswered when the Galaxy wakes is answered as lost and never sent again (Larry, 2026-11-14). | Sending it again: the code may have run, and running it twice can write twice. |
| D5 | A `read_file` is recorded on its round as `{ path, bytes, oid }`. The Galaxy writes the content to the Workspace's git store by `hashObject` as the model reads it, and a rebuild reads it back by `catFile` (Larry, 2026-11-17, was Q1). A committed source file is already there, so nothing new is stored for it. | A raw row beside the turn's row: a second copy of what the Workspace holds, and a finished turn no longer says which version was read. On the round: every Studio on the app would receive each file. Reading again at rebuild: the model would be shown the file as it is now. |
| D6 | A turn interrupted twice at the same round gives up, with DI9's fixed line. An interruption is a wake that finds a model call was cut off. A cut call's error on its round is its record, and a tab's answer arriving is not one. The row keeps the index of each interrupted round (Larry, 2026-11-17, was Q2). | A fixed cap on interruptions: it ends a healthy turn that spans a third deploy, and lets a broken one pay for three model calls. Counting every run: a tab's answer starts one, so a turn would end at its second `run_in_tab`. A backoff with no bound: the post still shows as waiting. |
| D7 | Reversed by D11 on the same day. A round is as open to a member's overwrite as a `Message` is, and a turn continues from whatever its rounds hold (Larry, 2026-11-17). An overwrite is a new snapshot naming who wrote it, with the agent's own beneath it in history. The refusal belongs in the orgTree, with the [backlog.md](backlog.md) row *Only a message's author, or nobody, can change it*. | A check on every continue that stops a turn whose round the agent did not record (was DI10): it gives every member a way to stop anyone's turn. A node of the rounds' own where only the agent holds `write`: a second grant on every invite, ahead of the design that row waits for. Rebuilding from the agent's own snapshots only: a check on every rebuild for a risk a `Message` carries unguarded. |
| D8 | A round is stored when the model's reply arrives, before its tools run (Larry, 2026-11-17). Its second half, running the Galaxy's own unfinished calls again on a wake, is replaced by D12. As first decided: on a wake, a call of the Galaxy's own with no result is run again. Each of today's tools is harmless to repeat: an `edit_file` may report its anchor already replaced, which the model reads as any tool error. | Storing a round only when it ends: an eviction during a build pays again for the reply that carried every file. Answering the Galaxy's own unfinished calls as lost, like a tab's: the model would write the same files again. |
| D9 | A cut-off turn continues at the next call that reaches its Galaxy, and no alarm wakes it (Larry, 2026-11-17). | The run's deadline as an alarm: a row written and cancelled on every run, and work resumed with nobody watching, to finish a turn a few minutes before its poster returns. The build box needs no waker, since Cloudflare stops it shortly after the Galaxy goes inactive (B6). |
| D10 | The row holds no counters: the round count, the files written, the last build and the detectors' memory are worked out from the rounds (DI5). Larry's 2026-11-14 wording put the loop's counters on the row, and he read this change on 2026-11-17. | Counters on the row: a write per round for values the rounds already hold, and a second copy that can disagree with them. |
| D11 | Superseded by D14 on 2026-11-18. A turn reads only the rounds the agent itself recorded, and one a member wrote over ends it (Larry, 2026-11-17, reversing D7). Under D8 a stored call with no result is run with no model in between, under the claims of the post the turn took up, so a member's `Round` holding `invite { scopeAdmin: true }` would have made an admin as the poster. | D7, reading whatever the rounds hold. A node of the rounds' own: a second grant on every invite. Keeping the calls still to run on the row: the row would store a position, against DI7. |
| D12 | Each call's result is written to its round as it lands, as a new snapshot, and a call in flight when the Galaxy went away is answered as interrupted and never run again (Larry, 2026-11-17). A reply is at most 8,192 tokens, so a round's value is about 32 KB at most and a round with four calls stores about 200 KB. | Running the Galaxy's own calls again (D8's second half): an `edit_file` whose replacement holds its anchor applies twice. Results kept on the row until the round ends: a second home for a result, which the rebuild would merge. A flag per tool for what repeats safely: a table to keep right for every tool added. |
| D13 | The Resources plane gains a one-time read of a query, with no subscription, and Studio reads a message's marks through it (Larry, 2026-11-18). A page subscribes to what stays on screen and can change, and reads once what will not. | A short list of each call's name, post and claims on the `Message`: a second home for a fact the rounds hold. A subscription to every `Round` in the chat: a query returns its oldest 1000 results, so new turns' marks would vanish. A subscription per message: a stored subscriber row for every round shown, against a limit of 200 live queries a type. |
| D14 | Amended by D18 on 2026-11-19: `turns` hangs under `chat`, beside `messages`. Rounds sit at a `turns` node beside `chat`, where the agent holds a protected `write` and an invite grants `read`, and every round write names the `validFrom` it read (Larry, 2026-11-18, superseding D11). The node says who may write a round, and `validFrom` decides between the agent's own writers when they race. | Rounds at `chat`, with D11's filter, the agent's round ids on the row and a rule for each conflict: a third and fourth guard on one mechanism, and any member could end anyone's turn with one write. Refusing a later snapshot by anyone but a resource's creator: a second permission mechanism beside the orgTree, which ADR-025 rules out. |
| D15 | A call refused because the post the turn took up moved on records that as its error, and a rebuild that meets the error ends the turn `post-moved`, as the other recorded stops do (Larry, 2026-11-18). | DI7's original stops alone: a wake between the post-moved error and the commit would run the round's later calls, each refused the same way, and once every call held a result it would call the model again for a post that had moved on. |
| D16 | Superseded by D17 on 2026-11-19. A cut-off turn wakes at the first Client to reach the Galaxy after the object is constructed, whichever Client it is: a Studio's, or one a Star asks for its ontology on behalf of (Larry, 2026-11-19, at the hand-off). DI8's example had said a Star's ask starts none, but it rides the asking page's chain. A Star asks only for a page whose version it has not installed, and a page load reaches the Galaxy by `fetch`, which wakes nothing. | Waking only for a Client the Galaxy hosts: a rule in Mesh whose only job is to delay work that runs anyway once a Studio opens. |
| D17 | A cut-off turn wakes from the Galaxy's `onStart`, whatever constructs the object, and Mesh has no hook for a first Client (Larry, 2026-11-19, superseding D16). Nothing has run when `onStart` does, so any row it finds is a turn an eviction cut off, and the flag that told a later look apart goes. A teardown's construction wakes it too, and its wipe ends the run: every round write and the commit check the row first, with no `await` between. | `ScopedMeshDO.onFirstClient()`, fired at a Client's upgrade or call: a new framework hook, its tests and a second flag, to wait for a Client the turn never needed. |
| D18 | The Galaxy's conversation hangs from a `chat` node, with `messages`, where `Message` and `ServedBuild` live, and `turns` beneath it (Larry, 2026-11-19, amending D14). The agent's one protected `write` sits at `chat`. An invite at `messages` grants its tier there and `read` at `chat`, so a revoke at `messages` takes posting away and leaves the reading, which a revoke at `chat` ends. The chat floor is `write` at `messages`, and its guard is now `requireChatFloor`. | Working the `read` at `turns` out from the grant at `chat` at each check: a second mechanism beside the tree. A revoke at `chat` that also revokes the grant paired with it: machinery to keep two grants agreeing. `posts` for the child: `messages` matches the `Message` type it holds, the agent's replies included. |
| D19 | Each call names the person's message it acted for by the snapshot's whole key, `messageSnapshot: { id, validFrom }`, and the turn copies that snapshot's claims onto its row when it takes the message up (Larry, 2026-11-19). A call answered after the message moved on still names the version and claims it ran under, and keeps the tab's answer beside the moved-on error. `post` had been the prose word for a person's message, leaked into a stored field. | One pin on the agent `Message`: the call is what acted, so the pointer belongs on it. `actsFor`: it reads as the token's `act`. `message`: the round already has one, the agent's reply. |
| D20 | No flag holds a tab's answer that lands while the run that sent its call is still ending (Larry, 2026-11-19). The window is closed today only because the answer handler awaits its own round write, and a turn that did stall there goes on when the Galaxy is next constructed (D17). | Keeping `#answered`: state on the object for a window no test can reach, whose mutation survived. |

## Phases

Each phase leaves every suite green. A criterion that names a test means a test under `apps/nebula/test/`, `packages/resources/test/` or `packages/mesh/test/`, in the lane that scripts the model's output, unless it says `/live`. Rationale is in § *Design intent* and § *Decisions*, cited by item.

### Phase 1: the Resources plane answers a query once

**Goal:** a Client can read a query's current result with no subscription (D13). This phase changes `packages/resources` and its docs alone.

- Add `query(ontologyVersion, query)` to the plane's `requests` surface in `packages/resources/src/resources.ts`, beside `read`. It runs `#gateClientOp` first, as `read` does, so a stale version throws `OntologyStaleError` (ADR-024). It then compiles and evaluates the query as a subscription does, and answers `{ snapshots, deniedNodes?, more? }` (ADR-008). It accepts `allowScan` as a subscription does, and logs `query scans` when it scans.
- It takes the caller from `callContext.originAuth`, and a call with none rejects. Its verdict over the host comes from one exported function: the `hostName && hasDominionOver(claims, hostName)` that `Subscriptions.#identity()` computes today, failing closed when the host is unknown. The subscription and the read both call it.
- One helper evaluates `read` on each distinct node once, and `#broadcastQueries` calls it too. It logs a debug line naming the nodes it checked.
- A new `Snapshots` method returns the current snapshots for a list of ids through the projection `#getCurrentSnapshot` uses, `toWireRecordedClaims` included. It checks no permission and is not on the wire.
- The read writes nothing: no subscriber row and no live query. It refuses what a subscription refuses.
- Add `resources.query(query)` to `packages/resources/src/client-resources.ts`, through `#versioned` and `callAsync`, as `#readResource` is. Its snapshots do not enter the client's store. Reword `#handleStale`'s JSDoc to name every answer and push channel instead of counting them.
- Document it in `website/docs/nebula/resources.md`, and in `api-reference.md`'s table and a section of its own: subscribe to what stays on screen and can change, and read once what will not change or will not stay. Run `apps/nebula/scripts/gen-platform.mjs` and commit the embed.
- Add a row to [backlog.md](backlog.md) § *Nebula*: a query cannot sort, page or limit, so it returns its oldest `QUERY_RESULT_CAP` results. A query that names the node it reads under is [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 21*, which starts with that row's work.

**Success criteria (capable of failing).** The first five are in `packages/resources/test`, on the package's own fixtures, with a plain member granted on one node as `act-under-claims-of.test.ts` logs one in. The admin cases are in `apps/nebula/test/test-apps/baseline/confine-org-plane.test.ts`, beside the subscription's.

- A member reads a type's resources at two nodes once and gets each snapshot's value and `meta`. The `Subscriptions` tables hold the same rows before and after, read through a `runInDurableObject` probe.
- A member with `read` on one of the two nodes gets that node's snapshots, and the other node in `deniedNodes`.
- Two Clients send a byte-identical descriptor and get different `snapshots` and `deniedNodes`, by their own grants. An impersonated child's read is decided by the subject's grants and not by `act`.
- A returned snapshot's `meta.recordedClaims` deep-equals what `resources.read` returns for the same resource, and holds no `access` and no `aud`.
- With three results at each of two nodes, the helper's debug line names two nodes.
- An admin whose token's `aud` is the host and who holds no grant reads every result. An admin of a descendant scope with no grant gets `deniedNodes` and no snapshots, and so does that admin calling from another host. A chain with no claims rejects.
- A stale `ontologyVersion` recovers as `read` does. `QUERY_RESULT_CAP` + 1 results answer `QUERY_RESULT_CAP` snapshots and `more: true`. An `it.each` covers the refusals: a filter the engine rejects, one no index can look up, and a descriptor that is not an object.
- The `@check-example` checker passes on the new doc blocks, and `gen-platform.mjs --check` reports no drift.

**Mutation notes:** register the query before answering and the row count changes. Skip the evaluation and the member without `read` gets the snapshot. Pass the bare `scopeAdmin` bit and the descendant admin reads. Build `meta` from the raw column and the recorded-claims test fails. Evaluate per result and the debug line names six nodes.

### Phase 2: rounds have a type and a node, and a blob is read and written by its id

**Goal:** the stored shape exists, only the agent and admins can write it, and members can read it (D14).

- Add `TURNS_NODE_ID` to `apps/nebula/src/chat-constants.ts` beside `CHAT_NODE_ID`, a fixed id as `CHAT_NODE_ID` is. `GALAXY_TREE_SEED` gains the node `turns` under the root and the agent's protected `write` there. The seed is applied with `INSERT OR IGNORE` on every start (`packages/resources/src/org-tree.ts`), so a Galaxy made before this phase gains the node too.
- Add `Round` to `CHAT_MESSAGE_TYPES`, bump `CHAT_MESSAGE_ONTOLOGY_VERSION`, and regenerate the validator seeds with `npx tsx scripts/gen-validator-seeds.ts` in `apps/nebula`, in the same step. Fields, per DI2: `chat` (typed `Chat`, not indexed), `message` (`@index`, typed `Message`), `index`, `text`, `reasoning?`, `calls`, and `closing?`, the posts a closing step was shown as `{ id, validFrom }` pairs. Each call holds `raw`, `post?`, `claims?`, `result?` and `error?`, and `post` and `claims` are absent until the call has run.
- A `TreeSeed` can declare grants that go with an invite at a node, as `inviteAlso: Array<{ at: string; grant: { nodeId: string; tier: PermissionTier } }>`, and the Galaxy's seed declares `read` at `turns` with an invite at `chat`. `#onInviteResult` writes those grants for the minted `sub` with the invite's own, before it flips the invite's row, so one invite still sends one email. The door checks `admin` at the invite's node only, since the host's seed chose the rest. `Galaxy.invite` is unchanged. A grant at `chat` written by `setPermission` carries nothing more, and today every collaborator arrives by invite.
- Add two Galaxy helpers beside `readSource`, neither with `@mesh()`. One writes content to the Workspace's git store with `hashObject({ dir: WS_ROOT, content, write: true })` and answers its `oid`, and one reads a blob back with `catFile({ dir: WS_ROOT, oid })`.
- `Message.codegen.toolCalls` stays in this phase, and § *Phase 4* removes it.

**Success criteria (capable of failing):**

- The agent creates a `Round` at `turns` and writes a second snapshot naming the first one's `validFrom`. A test reads both rows from `Snapshots` through a `runInDurableObject` probe, with a comment saying the plane has no history read. A `Round` whose `index` is a string is refused by the validator.
- A member holding `write` at `chat` is refused with `PermissionDeniedError` when creating a `Round` at `turns`, and when writing over the agent's. The same member reads the agent's `Round`.
- A `Round` whose `message` names an id no `Message` has is accepted (C1).
- An invitee accepted from the plane's own invite at `chat`, as `chat-cast.ts` sends it, holds `write` at `chat` and `read` at `turns`, and the invite produced one link. So does one invited by `Galaxy.invite`. An invite at a node the seed declares nothing for writes one grant.
- A blob written by the helper reads back byte for byte, for content the repo has committed and for content it has not. The test counts the rows of the Workspace's tables before and after each write, and the numbers go into C7 in this file.
- A blob no commit points at still reads back after a later `writeSource` (C7).

**Mutation notes:** drop the seed's grant and the agent's create is refused. Grant `write` at `turns` on invite and the member's write lands. Drop the seed's declaration and the invitee's read of the agent's `Round` is denied. Call `hashObject` without `write: true` and the uncommitted content's `catFile` throws.

### Phase 3: the loop holds nothing between rounds

**Goal:** `runCodegenLoop` reads everything it needs from a store of rounds and writes to it, so a second invocation on the same store continues the turn (DI1, DI3, DI5, DI7). The store is in memory in this phase.

- Add a `rounds` dep to `CodegenLoopDeps`. It reads the turn's rounds, writes a round when a reply arrives, writes it again as each call's result lands with that call's `post` and `claims` (D12), and reads the turn's interruptions. Each write names the `validFrom` it read (D14) and answers `ok`, `conflict` or `not-this-turn`, and either of the last two stops the invocation before its next dispatch or model call (DI3, DI13).
- Add a `blobs` dep: `write(content)` answers an `oid` as a file is read, and `read(oid)` answers the content at a rebuild. It may remember what it read by `oid` within one invocation, since the bytes are content-addressed. The loop records `{ path, bytes, oid }`. Tests back it with a map, and § *Phase 4* binds it to § *Phase 2*'s helpers.
- `runCodegenTurn` in `galaxy.ts` hands the loop an in-memory store and a map-backed `blobs`, so `codegen.toolCalls` is still built from the loop's result.
- Add a pure function that takes the opening prompt, the rounds and the interruptions, and answers what the loop's locals hold today: `messages`, the params of the next model call, `appliedPaths`, `lastBuild`, both detectors' hashes, `containerFailures`, the round count, and what is next by DI7's order. It parses each call's arguments from its `raw`, and turns each result into the model's text through `modelText`.
- The loop calls that function before each step and keeps no local across rounds. `mark_complete`, the call the identical-call detector stops at, and a second failed container step each record a result saying so. `error` and `post-moved` are what an invocation returns when a model call or a tool throws, and a moved post is also recorded as that call's error.
- The first call with no result is dispatched. A dep answers the interrupted error for a call a wake found in flight, in place of running it, and the calls after it run (DI8). A dep says whether a tool leaves the Galaxy, and such a call is sent and the invocation returns `waiting` with nothing awaited (DI6). No tool leaves yet, so `run_in_tab` still awaits in this phase.
- An interrupted index puts DI8's note into `messages` as a `user` message with fixed text, after the round before it. A store holding two rounds of one index, or a gap in the indexes, ends the invocation with one fixed outcome and no throw.

**Success criteria (capable of failing):**

- Every test in `apps/nebula/test/test-apps/dev-studio/codegen-loop.test.ts` passes, its assertions on `messages` unchanged.
- A scripted turn runs straight through and again as a fresh invocation per round on a shared store, and `[messages, params]` handed to `callModel` are deeply equal at every round. There is one script per `StopReason`, and `loop-detected` has one for each detector. The scripts include a failed build's feedback, an unparseable call and a `read_file` (C2).
- A test walks each stop that lands mid-round. Every dispatched call holds its result or error and its claims, and every call after it holds none of them. A call refused as post-moved has an error and no `claims`.
- An invocation stopped after the first of three calls, a `write_file`, is invoked again. The write is not dispatched a second time, and the model is not called for that round.
- A round of `[write_file, mark_complete, build]`, invoked again from its stored state, ends `complete` with no model call and never dispatches `build`. So does a round stopped at a repeated call.
- A round's second of three calls, marked as found in flight, gets the interrupted error and is never dispatched. The third is dispatched, and the next round's `messages` carry the error as the second call's tool message.
- A rebuild with round N interrupted, before and after round N lands, puts the note after round N-1 both times, and the earlier `messages` is a prefix of the later.
- A store answering `conflict` or `not-this-turn` stops the invocation before its next dispatch and its next model call.
- A `blobs` dep that counts reads sees each `oid` read at most once per invocation, over five rounds with two `read_file` calls.

**Mutation notes:** keep `seenCallHashes` in a local and the call detector's per-round run misses a repeat the straight run catches, and the same for `seenTextHashes`. Keep `fixMode` in a local and `params` differ. Rebuild a `read_file` from `{ path, bytes }` and `messages` differ. Write results only when the round ends and the stopped-after-one-call test dispatches the write again. Apply the call-with-no-result rule before the stop rule and the `mark_complete` test dispatches `build`.

### Phase 4: the Galaxy stores a turn as a row and its rounds

**Goal:** a running turn is on record (DI1 to DI5, DI11, DI15, DI17), and its tool calls are read from rounds everywhere.

- First, make the lane able to test a reset. The test Galaxy in `apps/nebula/test/test-apps/baseline/index.ts`, and its dev-studio twin, keep the model's script, the build faults, the deadline override, a hold on one model call, and faults for a round write and a blob read, all in `ctx.storage.kv`, where `ctx.abort()` leaves them. A test arms them through `runInDurableObject`, which starts no wake. Tests count model calls from the debug sink's `nebula.Galaxy.turn` `request` lines.
- Write the `/live` scenario next, `rounds-as-they-land`, container-free and registered in `drive.ts`. A second member reads the turn's `Round`s by `message`, taking the id from the first stream chunk. It gates on what holds whatever the model does: every `Round` arrives before the `Message`, each is the agent's, the indexes run from 1 with no gap, and each dispatched call ends with `post`, `claims`, and a result or an error. A turn with no tool call is reported as not exercised. From the Worker's logs it reads the store's line per write, and in a round of two or more calls it requires the first call's result to be written before the second is dispatched.
- Add a container-free `/live` limb for the provider. It imports § *Phase 3*'s rebuild function, feeds it the rounds of a real turn plus one interrupted call and one interrupted index, and posts the result to the Workers AI REST endpoint with the token in `.dev.vars`.
- The Galaxy keeps the turn's row under one `ctx.storage.kv` key, shaped as DI4 shows. It is written before the first model call, and deleted in the commit step only when `row.message` is this turn's.
- `runCodegenTurn` hands the loop a store that writes each round as a `Round` at `TURNS_NODE_ID` as the agent, each later write naming the `validFrom` it builds on, and reads a turn's rounds by `message` as the agent. A conflict ends the turn with a fixed line beside `POST_MOVED_LINE`, and the row goes. One entry function starts every run under `lmz.asLocalPrincipal(NEBULA_SUB, …)` (DI17).
- `blobs` is bound to § *Phase 2*'s helpers. The closing step's reply is written as the turn's last round, and the `Message`'s `read` is built from the row and that round's `closing`.
- `#codegenTurn` builds the `Message`'s `thought` and `codegen` from the rounds. `codegen` keeps `model`, `sourceCommit`, `rounds`, `stop`, `appliedPaths` and `build`, and loses `toolCalls`, which also leaves `CHAT_MESSAGE_TYPES`, with a second version bump and the seeds regenerated.
- `toolCallMarks` takes a turn's `Round` snapshots and keys each mark by round index and call index; `ToolCallMark.index`'s JSDoc says so. The marks' query descriptor is exported from one place. `apps/nebula-studio-ui/src/App.vue` keeps marks in a reactive map by message id, filled once through § *Phase 1*'s `resources.query` when a new agent message id appears, outside the thread's `computed`.
- Every reader of `codegen.toolCalls` moves to rounds: the scenarios and tests `grep -rln 'toolCalls' apps/nebula/harness/scenarios apps/nebula/test` lists, the `toolCallMarks` case in `apps/nebula/test/agent-loop.test.ts` among them.

**Success criteria (capable of failing):**

- `rounds-as-they-land` passes locally, and fails when results are written only as a round ends. The provider limb passes on a 200 with a reply that parses.
- § *Phase 3*'s per-round equality script runs through the real store, rebuilding from `Round`s read back after each round. `[messages, params]` captured by `takeSeenMessagesForTest` equal the straight run's.
- A test holds the model's first call. The row holds `prompt`, `post`, `message`, `read` and `sourceCommit`, and no `Round` exists. Held at round 3, a member's client reads rounds 1 and 2 with each call's `post` and `claims`.
- After the turn's `Message` commits, the row's key is absent, `codegen` has no `toolCalls`, and `codegen.rounds` equals the count of the turn's `Round`s.
- A turn that reads `src/App.vue`, writes it, and reads it again records two different `oid`s, and each reads back as the content the model was sent at that round.
- A Galaxy admin writes over a round between two of its calls. The agent's next write conflicts, the turn ends in the fixed line with the row gone, and a later post starts a turn.
- With more than 1000 `Round`s in the app, `resources.query` by `message` returns the new turn's rounds.
- `first-app-built` asserts `tool-call-mark` with no condition, its count equal to the calls in that message's rounds.
- `grep -n 'toolCalls' apps/nebula/src/chat-constants.ts` prints nothing. Run on 2026-11-17, it prints the type's field and a comment on it.
- `four-party-chat`, `first-app-built`, `agent-invites`, `cast-from-a-tab`, `post-edited-mid-turn`, `shared-lists-turn`, `studio-guidance-loop`, `studio-codegen-rest` and `waiting-posts-answered` pass, read against rounds.

**Mutation notes:** write the row after the first model call and the held-first-call test finds no row. Leave the row at commit and the absent-key assertion fails. Record a `read_file` by path alone and the two-`oid` test reads the later content for the earlier round. Retry a conflicted write and the admin test's turn runs on. Drop `raw` from `Round` and the equality script fails.

### Phase 5: a cut-off turn continues or says it cannot, and every row ends in a `Message`

**Goal:** nothing about a turn is remembered (B4, B6, B7), and no row is left without a run that ends it (DI8, DI9, DI13, DI14, D6, D9). `run_in_tab` still waits in memory in this phase, so a run never ends to wait.

- A turn is in flight while its row exists (DI14). The commit trigger starts no turn beside a row, `#decisionFor` offers no post while one exists, and `#takenUp` goes. Every run entry sets `#turnInFlight` and the looked-for-a-row flag before its first `await`.
- Add a hook to `ScopedMeshDO` that fires once each time the object is constructed, at the first Gateway upgrade or the first request whose `callChain[0]` is a Client, and never for `__rawRpc`, an alarm or a node's call (`mesh.md` § *Nebula platform code never drops to raw primitives*). The Galaxy implements it: it looks for a row, and starts the wake detached under `ctx.waitUntil`. `onStart` starts none. *Superseded by D17: the wake runs from `onStart`, and the hook is deleted.*
- The wake does DI8's steps. For a cut model call it records the round's index on the row with a synchronous `kv.put` before the run starts, since outgoing calls wait for that write. An index already there ends the turn with the fixed line (D6). A turn whose last round ended it goes to the closing step or the commit (DI7). A row beside a committed `Message` is deleted.
- Every run entry ends the turn with DI9's fixed line and deletes the row when its run rejects. The commit trigger, finding a row with no live run, starts the wake and no new turn.
- A run that reaches `generationDeadlineMs` commits the fixed-line `Message` and deletes the row. Each dispatch and each round write first compares `row.message` with its own turn's id (DI13), and no decision follows.
- `StopReason` gains `interrupted` and `deadline`, and each fixed line is a constant beside `POST_MOVED_LINE`. The tests that assert today's behaviour are rewritten: `waiting-posts.test.ts`'s deadline and reset cases, and `dev-studio.test.ts`'s `m-hung` probe.

**Success criteria (capable of failing):**

- A turn whose round 1 is `read_file src/App.vue` and round 2 a `write_file` of it is reset while round 4's model call is held, and a Client reconnects. The row's `interrupted` is `[4]` while the repeated call is held, rounds 1 to 3 are not called again, the repeated request's round-1 tool message holds the original content, and the `Message` commits.
- Reset a second time at round 4, the turn ends in the fixed line with `codegen.stop` of `interrupted` and its `rounds`, `appliedPaths` and `sourceCommit`, the row gone, and no third call for that round.
- Reset at round 4 and again at round 6, the turn commits the model's own `Message`, and `interrupted` holds both while round 6's call is held.
- Reset while a scripted `build` is out, in a round whose first call is an `edit_file` whose replacement contains its anchor: the replacement appears once, the build holds the interrupted error, `interrupted` is empty, and the model is called for the next round.
- Reset while the `build` of a round `[read_file, build, write_file]` is out: after the wake the `write_file` is dispatched.
- Reset while the closing step's call is held: the loop's rounds are not called again, one closing request is made, and one `Message` commits with its `answers`. Cut a second time, the turn's own last reply commits and the arrived posts wait.
- Reset after a final round with no closing step due: the `Message` commits with no model call. A row seeded beside a committed `Message` is deleted, with no model call and no second `Message`.
- A round write that throws, and a blob read that throws, each leave a fixed-line `Message` and no row, with no reset. A post committed beside a row with no live run starts no second turn.
- After a reset, two Clients reconnect and one posts at once. One wake marker appears, `interrupted` holds the index once, and the turn commits the model's own `Message`.
- With a short deadline, a held model call's reply is a `write_file`, the deadline passes, and a second person's turn starts before the reply is released. The fixed-line `Message` has `codegen.stop` of `deadline`, the file is absent, no `writeSource` line follows the fixed line in the debug sink, and the second turn's row survives the release and its turn commits its own `Message`. The test waits on the marker the stopped run logs.
- A Galaxy holding a row and a held call, with every Client disposed, is reset and then deleted through real scope deletion: no wake marker appears before teardown, and its storage is wiped. A mesh alarm fired on such a Galaxy, within a budget of at least 15 s, logs no wake marker and leaves the row as it was.
- In `packages/mesh/test`, the hook fires once each time the object is constructed, on an upgrade and on a Client's call, and never on `__rawRpc`, an alarm or a node's call. *Superseded by D17, with the hook.*
- `grep -n 'takenUp' apps/nebula/src/galaxy.ts` prints nothing. Run on 2026-11-17, it prints the field and its uses.

**Mutation notes:** record the index after the run starts and the twice-at-one-round test loops. End a turn at any second interruption and the rounds-4-and-6 test fails. Run the cut call again and the `edit_file` test finds the replacement twice. Answer every call with no result as interrupted and the `[read_file, build, write_file]` test never writes. Start the wake from `onStart` and the alarm test logs a wake. Set the flags after an `await` and the two-Client test logs two wakes. Delete the row by its presence and the deadline test's second turn loses its row.

### Phase 6: a tab call leaves by its result handler, and nothing waits for it

**Goal:** `#tabAnswers` and its promise are gone (B3, DI6, DI16, D3, D4).

- `Galaxy.runInTab` sends the call and returns. Its result handler, `onTabAnswer(turnId, roundId, validFrom, callId, address, answer)`, has no `@mesh()`, and its whole body sits in a `try`/`catch` that ends the turn with DI9's fixed line (`mesh.md` § *Explicit-callback error delivery*).
- The handler writes the answer onto the round as the agent, through `clipRunResult`, naming the `validFrom` it carried. A repeat is recognized as one, any other conflict ends the turn (DI3), and an answer for a turn with no row or another turn's row is dropped. It then starts a run through DI17's entry, handed to `ctx.waitUntil` (C5), unless a run is live in the object.
- A tab that ran nothing, one its host reports gone or one with no preview, leads to a call to the next tab. The handler picks it inside `actUnder(row.post)`, from the poster's own subscriptions hosted here, as `runInTab` does today. A post that has moved ends the turn with `POST_MOVED_LINE` and asks no further tab. A tab that stayed silent is recorded as `TAB_STAYED_SILENT`, and no tab at all as `NO_STUDIO_TAB`, each as the call's error.
- The loop's dep reports `run_in_tab` as a tool that leaves the Galaxy. The warm latch, the box's teardown and the heartbeat become a run's (DI16), their markers carry a run's id, and `chat-trigger.test.ts`'s T5a, T5b and T5d are reworded from a turn to a run.
- In `.claude/rules/mesh.md`, replace the TEMP bullet on `Galaxy.runInTab` with: a node MUST NOT wait in memory on a mesh call it sends, and the call's result handler is the only wait. In `.claude/rules/security.md`, extend the *The Galaxy* bullet's no-`@mesh()` and tab-choice rules to `onTabAnswer`, which writes only the result or error of the call its continuation names.

**Success criteria (capable of failing):**

- `grep -n 'tabAnswers' apps/nebula/src/galaxy.ts` prints nothing. Run on 2026-11-17, it prints the field and its uses.
- `grep -n 'waits in memory' .claude/rules/mesh.md` prints nothing, and `grep -c 'MUST NOT wait in memory on a mesh call' .claude/rules/mesh.md` prints 1. Run on 2026-11-17, the first prints the TEMP bullet.
- Every case in `apps/nebula/test/test-apps/baseline/run-in-tab.test.ts` passes: the answer, the silent tab, the passed-over tab, no Studio open, and a post written while impersonating. The answered round's newest snapshot is the agent's.
- A second person posts while a tab call is out. No model call is made for their post until the first turn's `Message` commits, and a decision then takes it up.
- With the post edited while the first tab reports no preview, the second tab is never called and the turn ends in `POST_MOVED_LINE`.
- A reset before the tab answers, then a Client reconnecting: the call holds the interrupted error, the model is called once for the next round and never for an earlier one, `interrupted` is empty while that call is held, and the turn ends in a `Message` (D4, D6).
- The same answer delivered twice adds one snapshot, and the model is called once.
- A Galaxy admin writes over the round while its tab call is out. When the tab answers, the turn ends in the fixed line, the row is gone, and a later post starts a turn.
- In a turn that writes, runs code in a tab, then builds, run 1 logs a warm and a teardown and run 2 logs a teardown only, and run 1's teardown comes before the tab's answer.
- With a short deadline D, a run of about 0.6 D that ends on a tab call and a second run of about 0.6 D end in the model's own `Message`. A second run alone past D ends in the deadline line.
- `/live`: `cast-from-a-tab` and `persona-tabs` pass, and `cast-from-a-tab` asserts its `run_in_tab` round arrived with the call unresolved before it arrived answered.

**Mutation notes:** keep an in-memory wait and the reset test never finishes its turn. Let the trigger ignore the row and the second person's post starts a turn. Drop the answer on a conflict and the admin test leaves the row. Measure the deadline from the turn's start and the 0.6 D test ends in the deadline line. Start a handler's run with no deadline and the past-D test never ends.

### Phase 7: the deployed pass, and every file that describes a turn agrees

**Goal:** the design holds where a real deploy does the evicting, and no standing text describes the old loop.

- Run the whole registry locally, `npx tsx apps/nebula/harness/drive.ts all`, since `galaxy.ts` and the chat ontology changed under scenarios this task did not write.
- Deploy with `bash apps/nebula/scripts/deploy-test.sh`, wait for `Test worker live and matches HEAD`, and run this task's scenarios against it with `HARNESS_TARGET_URL`.
- Let `deploy-test.sh` pass `--durable-objects-code-update-mode` through to wrangler. Add a deployed-only scenario, `deploy-cuts-a-turn`, which exports `skip` unless `HARNESS_REDEPLOY=1` and a deployed target are set, and stays out of the sweep. It starts a turn with Studio open and deploys again with `immediate` while the turn runs.
- It watches only through subscriptions opened before the deploy, records each tab's connection states, and makes no call to the Galaxy until the `Message` arrives or a bound passes. If its own call at that bound is what continued the turn, it reports that, and C9 is recorded as false. It is inconclusive, and fails as such, without a line in the Worker's logs showing the Galaxy started again between the first `Round` and the `Message`. It reads repeated model calls from the rounds and the row's interruptions.
- Read the target's Workers Issues since the pass began, `node scripts/issues.mjs --worker test-nebula --since <start>`.
- Edit what § *Relationships* lists as owed, and also: `.claude/rules/security.md`'s bullet *The record*, and its paragraph on work the agent does for a person, which now has no time bound while the orgTree grant is still read per call; the header of `apps/nebula/src/participants.ts`; and every description of the Galaxy's tree that `grep -rln 'chat node\|CHAT_NODE_ID' website/docs/nebula .claude/rules docs/vision` lists. Reword the Objective and DI8 if C9 came out false.
- Delete the backlog row, move this task's row in `nebula-pre-alpha.md` to § *Shipped*, rewrite `#underDeadline`'s RESIDENCY comment and `ToolCall`'s JSDoc to what the code now does, and update the memory `project_turn_stored_round_by_round.md`.

**Success criteria (capable of failing):**

- The local sweep exits zero, or `drive.ts all --rerun` does after a fix, and any flake is named as one.
- `deploy-cuts-a-turn` passes deployed with its line of the Galaxy starting again found, and the deploy's self-check matched `HEAD` both times.
- The Issues read lists nothing new, or each new issue is recorded here as a finding.
- With `F` the source files the build changed, `[ -z "$F" ] || grep -nE '\b(DI|[SDQCB])(1[0-9]|[1-9])\b|\bPhase[ -][0-9]+\b|\bChild [0-9]+\b' $F` prints no handle of this file.
- `node scripts/check-prose.mjs` passes on every prose file the build touched.

**Mutation notes:** revert § *Phase 5*'s wake and `deploy-cuts-a-turn` waits out its bound with the post unanswered. Deploy without `immediate` and the scenario is inconclusive, since the turn finishes on the old code.

## Build notes

**Sweep cadence (Larry, 2026-11-18):** a full sweep is about 52 minutes of scenario time. Phases 4 and 6 sweep only the scenarios that run a chat turn, read its record or render Studio's chat, plus the phase's own new scenario. Phase 5 adds a hook every node's entry runs, so it sweeps in full, and so does Phase 7, its closing gate.

### Open decisions, in the order to take them

Gathered from the phases' notes, merged, and ordered by what depends on what, then by risk. Each goes to Larry on its own at the hand-off.

- **Settled at the hand-off: what wakes a cut-off turn**, D16. A Star's ontology ask rides the asking page's chain, so it wakes a turn as a Studio's reconnect does, and DI8's example now says so. Larry also caught DI8's "new isolate": the wake's flags live on the object, which an eviction, a hibernation or a code update constructs again, in the same isolate or a new one. Every description of the hook, in source, tests, the harness and this file, now says the object is constructed again. Larry then moved the wake to `onStart` and deleted the hook, D17.
- **Settled at the hand-off: a member taken off the chat kept the `read` at `turns` their invite brought**, D18. `chat` is now the parent, with `messages` and `turns` beneath it, and the invitee's `read` sits at `chat`. Still open: Studio's mark reader and the round store each filter a query's rounds afterwards, Studio's by who wrote them and the store's by node, since a query cannot name its node. `nebula-pre-alpha-fast-follow.md` § *Item 21* is that capability; Larry asked on 2026-11-19 whether to pull it forward.
- **Settled at the hand-off: a tab's answer for a turn whose post moved on recorded no claims**, D19. Its call now names the snapshot and claims the turn copied at take-up, and keeps the tab's answer beside the moved-on error, so *The record* holds with no exception. Still to draft: text for ADR-006 on when a reference names the whole key, the id alone, or a version by time.
- **Settled at the hand-off: the flag for a tab's answer that lands while its run is still ending**, D20. Deleted.
- **The `resources.query` example.** The block in `website/docs/nebula/api-reference.md` is `@skip-check` like the rest of that page, which `documentation.md` says to ask about first.
- **The fixed lines are mine to word and yours to change.** A turn cut off twice at one model call ends in *"I was interrupted twice at the same step, so I stopped. What I saved is kept: ask again and I will carry on from it."* A run past the deadline ends in *"This ran past the time I am allowed, so I stopped."*, and a run that throws in *"Something went wrong on my side, so I stopped."*, each followed by the same second sentence. They follow whatever the model last wrote, as `ROUND_CONFLICT_LINE` did in § *Phase 4*, and stand alone when it wrote nothing. That changed the conflict line too, which no longer follows *"I couldn't finish cleanly — see the thought process."*

### Phase 1

**For the human:** nothing open.

- The criterion's "that admin calling from another host" is read as the Galaxy's own universe admin on the `.dev` page, whose token's `aud` is `{scope}.dev`. A `.dev` admin holds no token for any other host, so that is the reading that can be built, and it is the host rule's case: the admin is answered as the descendant admin is.

**Retro notes:**

- `QueryReadResult.snapshots` is an array of `{ resourceId, value, meta }`, so the query's order survives the wire, which a keyed object would not promise (ADR-002's note on key order).
- No Client can send a chain without claims, and a node's own chain carries the node's, so the no-claims case builds a bare plane over a Galaxy's storage with a call context carrying none.
- Reading `store.resources.todo[id]` in the for-docs test subscribes to it, so whether a one-time read's snapshots stayed out of the store cannot be asserted through the store. The assertion was dropped rather than kept as one that subscribes.
- The first sweep failed five scenarios, `signup-to-first-app`, `first-app-built`, `invites-land-on-their-host`, `logout-ends-every-host` and `cast-from-a-tab`, and none of them for this phase's code. Larry's hand-driven stack was stopped for the sweep, but its Studio vite (pid 65918) went on holding `[::1]:5174` and proxying to the stopped `wrangler dev`, so every request a scenario sent to Studio's port answered 502 or closed. With it stopped, `drive.ts all --rerun` passed all five, and the harness names each a flake, since none of their files changed. Four are explained by the port: a picture, the preview, Studio's socket and the wipe all went through it. `invites-land-on-their-host` failed on the email-test socket closing before its mail arrived, which the port does not obviously explain, so it stands as a flake. A sweep's check for a hand-driven stack (`pgrep -fl 'wrangler dev'`) does not see a vite left behind.
- The first whole `apps/nebula` run failed only in inventories of the `requests` surface: `resources-door.test.ts` for each host, `galaxy-resource-surface.test.ts`, and `scope-isolation.test.ts`'s table of a written reason per member a descendant Star may reach. Each now lists `query`. No narrow run could have shown them.

**Close-out notes:**

- Added the [backlog.md](backlog.md) row *A query cannot sort, page or limit*, which `nebula-pre-alpha-fast-follow.md` § *Item 21* already pointed at.
- `hasDominionOverHost` (`packages/resources/src/host-dominion.ts`) is the one verdict a subscription stores, the one-time read computes and `OrgTree.requirePermission` checks. The comments that counted two confinement points, in `resources.ts`, `org-tree.ts`'s `evaluatePermissions` and `confine-org-plane.test.ts`'s header, now name three.

**Mutations run** (each caught by the test named, and by no other unless said):

- Register the query before answering: *answers each snapshot's value and meta at two nodes*.
- Answer every match without the read evaluation: *names the one they may not*, the two-caller test and the read-check test.
- Let `act` grant dominion: the two-caller test's impersonated child.
- Build `meta` from the raw `recordedClaims` column: the recorded-claims test.
- Drop the per-node dedup: *evaluates each node once*.
- Drop the version gate from `requests.query`: the stale test.
- Answer every row past the cap: the cap test.
- Drop the descriptor's shape check: the `it.each` case for a descriptor that is not an object.
- Pass the bare `scopeAdmin` bit: `confine-org-plane`'s query test, at the descendant admin.
- Read `authScope` where the verdict reads `aud`: the same test at its third limb, the admin on the `.dev` page, which the previous mutation hides.
- Drop the claims check: *refuses a chain that carries no claims*.
- Give `requirePermission` the bare bit again, now that it calls `hasDominionOverHost`: both of `confine-org-plane`'s existing denials of a descendant admin.

### Phase 2

**For the human:** nothing open.

- The criterion's refusal "with `PermissionDeniedError`" is what the plane answers the member's op with, `{ type: 'permission', requiredTier: 'write', nodeId: TURNS_NODE_ID }`: `Snapshots.transaction` catches `requirePermission`'s `PermissionDeniedError` and turns it into that value.

**Retro notes:**

- An unchecked grant writer cannot be a method of `OrgTree`, since every member of one is reachable past the `resources` door. `writeInviteAlsoGrants` is a module function a class `static` block sets, so it reaches a `#private` method and adds nothing to what an `OrgTree` carries. `galaxy-resource-surface.test.ts`'s list of the tree's methods is unchanged.
- A declared invite grant is written with `INSERT OR IGNORE`, so it never lowers or replaces a grant the invitee already holds at `turns`, as an invite never lowers a bit.
- "One link" is counted from the Registry's `invite.issued` line for the invitee's address at the Galaxy's scope, which a second facade call would double.
- The probe `writeAsAgentForTest` writes through a new protected `Galaxy.writeAsAgent`. § *Phase 4*'s store is its production caller; until then a test is the only one.
- The whole `apps/nebula` run failed two tests. `plane-wipe.test.ts` counted the Galaxy's tree as two nodes, root and chat, and now counts three. The browser `smoke.test.ts` waited out its 60 s for a login email Resend reported delivered, and passed on a rerun with nothing changed: a flake, in the mail's routing.
- The sweep passed 77 of 78. `revoke-is-total` waited out a login email Resend never saw, a scenario of two logins and a scope deletion with no node invite in it, and passed on `--rerun` with nothing changed: a flake, in sending the mail.
- The `Round` validator is a generated literal (`src/validator-seeds.ts`), so the mutation of `index`'s type was made by hand: edit, regenerate, run, restore, regenerate, and `--check` in sync.

**Close-out notes:** none.

**Mutations run** (each caught by the test named):

- Drop the agent's seeded `write` at `turns`: the create-then-put test, the unknown-`message` test and the member test.
- Grant `write` at `turns` with an invite at `chat`: the member test, and both invite tests.
- Drop the seed's `inviteAlso`: both invite tests, and the member test at its read of the agent's round.
- Write the declared grants for an invite at any node: *an invite at a node the seed declares nothing for*.
- Call `hashObject` without `write: true`: both blob tests.
- Send the facade invite twice: both invite tests' one-link assertion.
- Type `Round.index` as `unknown` (by hand, regenerated): *refuses a Round whose index is a string*.

### Phase 3

**For the human:**

- A moved post is read back as a recorded stop, and Larry kept it on 2026-11-18: D15.

**Retro notes:**

- The loop reads the store before every step, each dispatch included, so even inside a round nothing lives between steps, and each write names the version just read. The memory store makes that free; § *Phase 4*'s store pays a query and a read per round for it.
- The sweep failed 13 of 78, and each on mail or its socket: mail Resend never saw, mail Resend delivered that never reached the email-test Worker, or that Worker's socket timing out or closing. The Worker showed no Workers Issues for the day. None of the 13 runs a turn, and `drive.ts all --rerun` passed all of them with nothing changed, so each is a flake, most likely of this machine's network that hour: `message-roundtrip`, `late-answer-dropped`, `resubscribe-when-lost`, `push-survives-token-lapse`, `claim-lifecycle`, `refresh-reads-the-host`, `links-sign-nobody-in`, `links-sign-in-once`, `invites-land-on-their-host`, `logout-ends-every-host`, `hosts-and-frames`, `dev-tab-frame` and `session-survives-token-lapse`.
- `StopReason` gains `conflict` here, since a store's conflict ends the turn and § *Phase 4* gives it a fixed line. `LoopResult.stop` also takes `waiting` and `not-this-turn`, which end an invocation and no turn.
- `LoopResult.toolCalls` is worked out from the rounds in today's shape: `mark_complete` without a result, and a call the identical-call detector stopped at left out. A call recorded as post-moved is now listed with its error, which reddened `waiting-posts.test.ts`'s edited-post case in the whole run; it now asserts the refused write, with no claims.
- The task's mutation "write results only when the round ends" has nothing to change in this design, which keeps no results in memory to hold back. What it guards is guarded by three mutations below: reading the store once per invocation, looking for an unrun call before a recorded stop, and treating the second invocation's stored call as unrun.
- That last mutation spun: with every call read as unrun, a stored `mark_complete` was dispatched forever, and the memory store's reads never yielded to the test's timer, so it ran until stopped by hand, with no verdict. A dispatch that stored nothing would spin the same way. § *Phase 4*'s store does I/O on every step, which yields, and a bound on steps per invocation would make such a bug fail loudly.

**Close-out notes:** none.

**Mutations run** (each caught by the test or tests named):

- The identical-call detector's memory in a local of the invocation: the per-round equality script for a repeated call.
- The repeated-text detector's memory in a local: the per-round script for repeated text.
- The fix params from a local that starts at the generate params: the per-round scripts for `complete`, `no-tool-calls` and `build-unavailable`, and the read-back test.
- A rebuilt `read_file` from `{ path, bytes }`: the read-back test and both `read_file` tests in `codegen-loop.test.ts`.
- The store read once per invocation: every per-round script.
- An unrun call before a recorded stop: all four mid-round stops and both stored-stop tests.
- Every call with no outcome answered as interrupted: the in-flight test.
- The note one round early: the note-placement test.
- No blob cache: the blob-count test.
- No index check: the skip-or-repeat test.
- Claims on a post-moved call: the mid-round post-moved case.
- A refused round create ignored: both create-refusal cases.
- A write recorded without its claims: all four mid-round cases.
- A stored result read as unrun: no verdict, as above.

### Phase 4

**For the human:** nothing open.

**Retro notes:**

- The turn's row lives under `turn:row` in `ctx.storage.kv`, and `TURN_ROW_KEY` is exported only so a test probe that runs a turn with no commit can delete what it wrote. A run's store answers `not-this-turn` already here, for a row naming another turn, since it costs one read and § *Phase 5*'s deadline needs it.
- `roundStore` is `protected`, so a test probe can run the loop over the Galaxy's own store one invocation per round. Its read is § *Phase 1*'s one-time query, as the agent, so a store read costs a query and a point read per round.
- The closing step's round is stored before its message commits, and a run that finds a closing round goes straight to the commit, as DI7 says. A closing call cut off before its round is stored is § *Phase 5*'s.
- `ToolCallMark.index` is now `{round}.{call}`, a string. Studio reads each agent message's marks once, when the message first appears, through `resources.query`; the watch sits after `nebula`'s declaration, since a `watch` reads its source at setup.
- The test Galaxies keep their script, faults, deadline, holds and request log in `ctx.storage.kv`. A held model call or build waits in memory, which a reset ends, and `holdModelCallForTest(n)` counts model calls across resets.
- `STUDIO_MODEL` moved to `src/studio-model.ts`, a leaf, so `rounds-as-they-land`'s provider limb sends to the same model from Node.
- `rounds-as-they-land` passed every limb on its first local run, with a real round of two reads. Mutated one limb at a time, limbs 2 to 5 each failed alone. Workers AI accepted a `tool` message with no `tool_call_id`, so limb 5's mutation is the invalid-JSON arguments the provider is known to refuse (`8007`). Limb 1 has no single-edit mutation: rounds that arrive after their message need a store that holds every write until the commit, which no edit of one line makes.
- Every reader of `codegen.toolCalls` moved to the rounds: `turnCallsOf` in `test/test-helpers.ts` for the vitest lanes and in `harness/lib/turn-calls.ts` for the scenarios. `turnCalls` lists a `mark_complete` with its `{ ok: true }` result, and calls left unrun after a stop.

**Close-out notes:**

- The [backlog.md](backlog.md) row on undoing a bad turn's writes named the turn's `toolCalls` entries, and now names its `Round`s.
- `tasks/on-hold/nebula-studio-self-improvement.md` § *The folded shape* still shows `toolCalls` on `codegen`; § *Phase 7* edits it with the other files that describe a turn's record.

**Mutations run** (each caught by the test named):

- A `Round` stored without its provider call: four of `turn-stored.test.ts`'s five tests.
- The row written after the first model call: the held-first-call test.
- The row left at the commit: the held-first-call test and the admin-overwrite test.
- A read recorded by a blob of its path: the two-`oid` test and the per-round equality test.
- A conflicted round write taken as written: the admin-overwrite test, whose turn runs on.
- The rounds' query by scan rather than by `message`: the thousand-rounds test.
- In `rounds-as-they-land`, one per limb: results held back until a round's calls have all run (limb 4), no claims recorded (limb 3), indexes from 0 (limb 2), echoed arguments that are not JSON (limb 5).

**Suites and sweep:** the whole `apps/nebula` suite passed, 140 files, 1295 tests and 2 skipped. The turn subset, the 21 scenarios that run a turn, read its record or render Studio's chat, plus `rounds-as-they-land`, passed 22 of 22 on its first run, each scenario alone on a fresh stack. No flake, and the tree did not change during it.

### Phase 5

**For the human:** the fixed lines and Mesh's docs moved to § *Open decisions, in the order to take them*.

- The criterion on a blob read that throws "with no reset" cannot hold as written. A run reads back only blobs it did not write, and in this phase only a wake is such a run, so the test resets the Galaxy and the woken run's read throws. The round-write case runs with no reset.

**Retro notes:**

- The hook fires after the call's admission, or after a 101, so the node's name is stamped when the Galaxy's wake logs it. It never fires for a refused call.
- A woken run's first rebuild says what the eviction cut. A model call is recorded on the row, then made again with the note. A call with no outcome is answered as interrupted, and the calls after it run. A turn that had ended goes on to its closing step or its commit. `#runFromRow` tells the closing step a wake found the turn ended by whether the run wrote a round, and the closing call is recorded at `rounds + 1`.
- The trigger wakes a row only on the first look for one after the object is constructed. After that, a row with no live run belongs to this object: in § *Phase 6* it waits on a tab, and here it is only a row whose turn could not be ended, left for the object's next construction. DI14's second flag is what says so.
- `stoppedTurn` builds the summary a deadline or a throw commits, by rebuilding the turn with every blob read as empty, since no model is sent it.
- After `ctx.abort()` in the vitest-plugin lane, a stub made before the abort answers every call with `scope-deleted`, and a fresh `getByName` reaches the fresh object. The scope lifecycle hooks log `tearing down` twice for a Galaxy reset just before, since they retry the first refusal.
- The trigger's log lines carry the post's id and no `instanceName`, so a test matches them by the post.

**Close-out notes:**

- `#takenUp` and its TEMP comment are gone, and so is the trigger's *"edited while its turn runs"* line, which nothing read. `grep -n 'takenUp' apps/nebula/src/galaxy.ts` prints nothing.
- [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check* still points at `#takenUp`, and this phase answers the questions § *Relationships* names. § *Phase 7* rewrites it, as § *Relationships* says.
- `waiting-posts.test.ts`'s reset and deadline cases and the dev-studio deadline probe now assert the new behaviour: the wake continues a cut-off turn, and a deadline commits our line answering the post.

**Mutations run** (each caught by the test named, unless it says otherwise):

- No record of a cut model call on the row: the three cut-at-round-4 tests.
- A second interruption at any round ends the turn: the rounds-4-and-6 test.
- The wake started from `onStart`: the cut-at-round-4 tests, whose reset then wakes before any Client.
- The closing step not told of a wake: both closing tests. A second cut there ignored: the cut-twice closing test.
- No check for a committed message: the row-beside-its-message test.
- A run's rejection left unhandled: the round-write and blob-read tests.
- The trigger blind to the row: the post-beside-a-row test.
- The wake's flags set after a macrotask: the post-beside-a-row test, through the second flag. The two-Client test passed under it, since a Client that reconnects before it posts sets the flags long before its post arrives; the race it names needs a post to be the first thing to reach the object once it is constructed again.
- A stale run's round write, and its round write and dispatch together: the deadline test.
- The commit deleting the row by its presence: **survived**. The check covers a run whose own commit is still awaiting when the deadline ends its turn and the next turn starts, which no test arranges, so it stays for that interleaving.
- No end for a turn past its deadline: the deadline test.
- The cut call run again: the `edit_file` test. Every call with no outcome answered as interrupted: the `[read_file, build, write_file]` test.
- In the loop's own tests: a woken run run as an ordinary one, a second cut ignored, and no check before a dispatch.
- In Mesh: the hook firing on every arrival, never on an upgrade, for any chain, and never on a call. Each reddened its own test in `hosted-clients.test.ts`.

**Suites and sweep:** Mesh's whole suite passed, 85 files and 1102 tests with 4 skipped, and `apps/nebula`'s 142 files and 1313 tests with 2 skipped, which is § *Phase 4*'s 1295 and the 18 this phase added. The full sweep passed 75 of 79 and parked `redeploy-strands-no-client`, as it always does. Four failed and passed on `--rerun` with nothing changed, so each is a **flake**: `scope-hosts-its-clients`, `scope-teardown` and `hosts-and-frames` timed out connecting to the deployed email-test Worker's socket, and `links-sign-in-once` lost a mail Resend reports it delivered.

### Phase 6

**For the human:** the flag for an answer that lands while its run is ending, and a moved post's tab answer, moved to § *Open decisions, in the order to take them*.

- The phase says the loop's dep "reports `run_in_tab` as a tool that leaves the Galaxy". That is now the dep's own shape: `run_in_tab(tab, code, at)` takes where its answer goes and returns once the call is sent. The `leaves` and `send` pair § *Phase 3* added for it is gone, since a dep that answered in place could no longer be built without the in-memory wait. A later tool that leaves takes the same shape.

**Retro notes:**

- `onTabAnswer` reads the round, finds the call by the provider's id, and writes the outcome building on the version the call was sent from. A version that moved with the call already holding the same outcome is a second delivery and is dropped. Any other moved version ends the turn as a conflict. The comparison sorts keys, since a stored value need not keep its keys' order (ADR-002).
- A passed-over tab's next tab is chosen under the claims of the post the turn took up, from the tab and code on the round's stored call.
- The warm and teardown markers carry the run's id, and a build's own teardown carries none. The loop's progress line for a tab call now reads *"asked the … tab to run code"*, at the send.
- `cast-from-a-tab` gains a check on the Worker's logs: the round whose `run_in_tab` call returned was written with that call unresolved before it was written answered.
- A mutation table entry whose replacement ends in a `//` comment can swallow the rest of its line. One did, and its run reported CAUGHT on a syntax error. Read the failing test's name before counting a catch.

**Close-out notes:**

- `.claude/rules/mesh.md`'s TEMP bullet on `Galaxy.runInTab` is replaced by the rule that a node MUST NOT wait in memory on a mesh call it sends. `.claude/rules/security.md`'s *The Galaxy* bullet covers `onTabAnswer`.
- The [backlog.md](backlog.md) row this task supersedes still describes the in-memory wait. § *Phase 7* deletes it.

**Mutations run** (each caught by the test named, unless it says otherwise):

- The trigger blind to the row: the second-person test, and the edited-post test.
- The next tab picked from the post's current record: the edited-post test, whose second tab then runs the code.
- A repeated answer written again: the twice-delivered test.
- A conflict dropped: the admin-overwrite test.
- The answer's run started with no deadline: the per-run deadline test.
- An answer while a run is live, dropped: **survived**, as the first item for the human says.
- The teardown taken from the run: the warm-and-teardown test, and `chat-trigger.test.ts` T5b.
- The loop recording a tab call's result in place rather than waiting: every case in `run-in-tab.test.ts`, and the loop's identical-call test.
- In `cast-from-a-tab`, no log line for a round write with a call still out: the new check, which found round 3 logged only answered. Its first run under the mutation died on the email-test Worker's socket before limb 1, so it was run again.

**Suites and sweep:** `apps/nebula`'s 143 files and 1320 tests passed with 2 skipped, which is § *Phase 5*'s 1313 and the 7 in `tab-call.test.ts`. The turn subset passed, `cast-from-a-tab` twice with its new check, under the real model's three `run_in_tab` calls across runs. `rounds-as-they-land` failed once on a mail Resend delivered and the email-test Worker lost, and passed alone with nothing changed, so it is a **flake**.

### Phase 7

**For the human:**

- Three edits this phase owes sit in files another session has uncommitted edits in, so I made none of them: deleting the [backlog.md](backlog.md) row this task supersedes, moving this task's row in [nebula-pre-alpha.md](nebula-pre-alpha.md) to § *Shipped*, and rewriting [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check* to what is left. The proposed text is in the hand-off note. That session already brought pre-alpha's section on reading turns back, and Item 17, up to rounds.
- What wakes a cut-off turn, a revoke at `chat`, the record a moved post's tab answer leaves, and the docs moved to § *Open decisions, in the order to take them*.
- The define-the-cast skill now reads another persona's records with `client.resources.query`, the one-time read § *Phase 1* added, where it subscribed and disposed. The model reads that skill on every turn.

**After the panel:** the verifiers found these, and each is fixed, with a test that reddens under its mutation unless it says otherwise.

- **A turn read rounds written anywhere.** A member with `write` at `chat` could write a `Round` there naming a running turn, and the turn would dispatch its calls under the poster's claims, an admin invite included. The store now reads only rounds at the `turns` node. Test: a member's round at `chat` written while round 1's build is out is never sent to the model.
- **A call answered as interrupted counted toward the identical-call detector**, so the model's retry of it ended the turn `loop-detected`. It no longer counts.
- **A decision the deadline cut off could pick a post when its call returned**, and write a row over the next turn's. A run's body now asks whether the deadline cut it, after a decision's model call and before a turn writes its row. The decision's check has a test; no test reaches the row-write check, which needs the deadline to pass during a turn's setup reads.
- **`onTabAnswer` passed over a tab before checking the round's version**, so an admin's rewrite could reach another tab. The version is checked first, and the whole handler sits in its `try`.
- **`cast-from-a-tab`'s new check could not fail**, since every round is written unresolved first. It now asserts that the run that sent the call tore down before the tab answered, and that the answer's run is another.
- **`rounds-as-they-land` limb 1 compared a push's time with a 250 ms poll.** It now stamps the message's push as it stamps the rounds'. No one-line edit writes rounds after the message, so the limb has no mutation of its own.
- **`deploy-cuts-a-turn` read an upgrade's lines while the socket was open**, which deployed never arrive. It now closes both Studios first, records both sockets' states, and bounds the redeploy at 15 minutes.
- **`codegen.rounds` counted a model call that failed**, which leaves no round. It now counts the turn's rounds, and the loop test that held the old count says why it changed.
- The rest were comments, JSDoc above the wrong method, a shadowing parameter (now `holdsDominion`), a `[C7]` handle in a test's log label, and prose describing a turn's message as its calls' record.

**Closing suites and sweep, on the tree after the panel's fixes:** Resources passed 11 files and 263 tests. Mesh passed 85 files and 1103 tests with 4 skipped, which is § *Phase 5*'s 1102 and the host test the panel's fixes added. `apps/nebula` passed 143 files and 1324 tests with 2 skipped, which is § *Phase 6*'s 1320 and those fixes' four. The full sweep passed 79 of 79 in 65.5 minutes, with no rerun and no flake, and parked `redeploy-strands-no-client` and `deploy-cuts-a-turn`, which run only deployed.

**The deployed pass**, on `test-nebula` deployed from 8b01493, whose self-check matched `HEAD`. The scenarios this build wrote or touched ran against it, two at a time:

- **`agent-invites`, `cast-from-a-tab`, `first-app-built`, `post-edited-mid-turn`, `shared-lists-turn`, `studio-codegen-rest`, `studio-guidance-loop` and `waiting-posts-answered` passed.**
- **`rounds-as-they-land` failed limb 4, and the fault was the scenario's.** Its wait returned at the first round-write line in, round 2's, before round 1's lines had arrived, since a deployed capture comes one invocation at a time. The wait now holds out for every multi-call round's lines, as its assertion reads them. Under § *Phase 4*'s mutation that holds a round's results back, limb 4 reddened locally with resolved counts `[0,2]`, and deployed it passed every limb.
- **`studio-guidance-loop` recorded (a) and (b1) as fails**: no `App.vue` was written and nothing was asked, the shape `nebula-pre-alpha-fast-follow.md` § *Item 20: Data-bound generation* records as variance three times. The same tree's local closing sweep passed both. That file is another session's, so the dated line is in the hand-off note.
- **`deploy-cuts-a-turn` passed, so C9 holds**, measured on an active Galaxy. Once the turn stored its first round, the scenario deployed again with `immediate`, and that deploy's self-check matched `HEAD` too. Both Studios went `connected`, `reconnecting`, `connected` twice, the Galaxy started again between the first round and the `Message`, and the turn ended in its `Message` with no call from the scenario. The eviction cut round 6's model call and left a call of round 5 answered as interrupted. The scenario counted three wakes beside two starts, counting lines as they arrived, and now counts them by when each was logged, as `live-scenarios.md` requires.
- **Workers Issues since the pass began show nothing new.** `scope-deleted` is standing. `teardown failed` with *"Durable Object reset because its code was updated"* has recurred 22 times since 2026-10-14; this time it was the scenario's cleanup, run just after its own `immediate` deploy.

### After the hand-off

**The wake moved to `onStart`, D17.** The Galaxy's `onStart` calls `#wake`, which continues any row it finds. Gone with it: Mesh's `onFirstClient()` hook, its override of `__executeOperation`, its tests in `hosted-clients.test.ts` and the test host's marker and alarm probe; the Galaxy's second flag, `#lookedForRow`; the commit trigger's call to wake a row, since a post beside a row now only waits; `#wake`'s check of the latch, which nothing set before `onStart`; and `GalaxyTest.armAlarmForTest`. `ScopedMeshDO` is again as it stood before § *Phase 5*. `GalaxyTest.onStart` now restores a test's deadline before `super.onStart()`, so a woken run reads it.

- `turn-wake.test.ts`'s last test now asserts the opposite of what it did: a reset Galaxy that no Client reaches continues its turn when a read from inside the object constructs it, and the turn commits its message.
- Checked that a run a teardown wakes writes nothing after the wipe: each round write checks the row first, and the commit checks it with no `await` before its write, as `#endTurn` does.

**Mutations run** (each caught by the tests named):

- No wake in `onStart`: the new test, and every test that resets a Galaxy holding a row.
- The trigger blind to the row: *starts no second turn for a post beside a row*.

**`chat` is the parent, D18.** Every `CHAT_NODE_ID` became `MESSAGES_NODE_ID`, keeping its id, so each write and invite that names it stays where messages live, and a new `CHAT_NODE_ID` names the parent. The seed hangs `messages` and `turns` under `chat`, puts the agent's one protected `write` there, and pairs an invite at `messages` with `read` at `chat`. `requireChatWrite` is now `requireChatFloor`, and every comment that said "the chat node" for where messages live now says `messages`. `galaxy-seeds-its-chat` limb 4 asserts the new revoke: one at `messages` leaves the `read` at `chat`, which one at `chat` then takes.

- **Studio's agent reads the rule** in `website/docs/nebula/access-control.md` § *Drawing the tree: a node for each audience*, embedded as `.platform/docs/`, with a sales team as its example. `calibration.md` gained entry 16, for us.
- **`teardown` is now `teardownScope`, and `beforeTeardown` is `beforeScopeTeardown`.** Larry read `beforeTeardown` as sensing an eviction; both run only when the Registry deletes a scope or creates one under a reused name, so the names now say so. `@rawRpc()` stays: the facade and the Worker's session routes call it after the Registry has decided, and `@mesh()` would let any admin wipe a live app.

**Mutations run** (each caught by `turn-rounds.test.ts`):

- No `inviteAlso`: both invite tests, and the member's read of a round.
- The agent's grant at `messages`: the agent's own round writes.
- `turns` under the root: the agent's round writes and the member's read.

**A call names its message by the snapshot's whole key, D19.** `post` on a stored call, on the turn's row and in `turnCalls` is now `messageSnapshot`, `{ id, validFrom }`, and the chat ontology is v7. `TookUp` folded into `MessageSnapshot` in `chat-constants.ts`, `ActedUnder` is now `CallClaims`, and the loop's `actsFor` dep is now `attribution`. The row copies the taken-up snapshot's claims, which a tab answer after an edit records, with the tab's own answer beside the moved-on error. Studio's marks carry the message's id as `message`, shown as `data-message`.

**Mutations run** (each caught by *a tab that answers after its post was edited* in `tab-call.test.ts`):

- No claims copied at take-up.
- The tab's answer dropped from the moved-on record.
- The message named by its id alone: the ontology refused the round, as it should.

**`#answered` is gone, D20.** `#continueAfterAnswer` returns when a run is live, and the run's `finally` no longer looks for an answer.

**ADR-006 gained the rule behind D19** (Larry, 2026-11-19): a reference names the id alone for the resource as it is now, `{ id, validFrom }` for the version something was done on, and a version current at some moment through the snapshots' `validFrom` and `validTo`. Its line in `workflow.md`'s ADR index carries the tripwire.

## Non-goals

- **Waking a turn nobody is watching.** D9 leaves it to the next call, and § *Beyond this task* keeps the alarm as a note.
- **A build that leaves the Galaxy.** It is awaited where it is made, and § *Beyond this task* says what would change.
- **Refusing a member's overwrite of a `Message` or a `ServedBuild`.** D14 puts rounds where members cannot write, and the rest stays with the [backlog.md](backlog.md) row *Only a message's author, or nobody, can change it*.
- **Posts that no turn took up, and a decision an eviction cut off.** They stay with [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*.
- **Showing a call in Studio while it is out.** Studio's marks move to rounds in § *Phase 4* and show what they show today.
- **Sorting, paging or limiting a query, and a query that names its node.** § *Phase 1* adds a backlog row for the first, and the second is [nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 21*.
- **A terminal `status` on the `Message`** other than what `codegen.stop` says. § *③ Capture live* owns that field.
