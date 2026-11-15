# A turn is stored round by round, and continues from storage

**Status:** Pass 1 only, drafted 2026-11-15 and waiting for Larry's read. No phases are written. Larry decided the design's core on 2026-11-14 and named the record on 2026-11-15; § *Decisions* holds those, and § *Design intent* says which items are the drafter's. Where this sits in the pre-alpha order is Larry's to say. It grows out of the row *A turn an eviction cuts off resumes where it stopped* in [backlog.md](backlog.md) § *Other Nebula backlog*, which stays until the phases are written.

## Conventions

Items carry IDs, numbered in the order they were raised and never reused: `B` is something in today's code that stands in the way, `DI` an item of design intent, `C` a claim the design rests on that someone can check, `Q` an open question, and `D` a decision. D3 is the third decision made, wherever its row sits.

## Objective

**A turn of Studio's agent no longer lives in the Galaxy's memory. Each round is stored as it ends, and the turn continues from storage when a tab answers or the Galaxy wakes.**

Take a turn on the app `acme.crm`, working on Austen's post *"check that Gerry can see his own deals"*:

| Round | What the model asked for | Stored when |
|---|---|---|
| 1 | `read_file src/App.vue` | the round ends |
| 2 | `write_file src/App.vue`, then `build` | the round ends |
| 3 | `run_in_tab gerry`, code that lists his deals | the call leaves for Gerry's tab |

Suppose a deploy resets the Galaxy while round 3's call is out. Today the turn is gone. Nothing records its three rounds, Austen's post shows as waiting, and nothing happens until someone posts again. After this task, Austen's Studio reconnects and the Galaxy finds the turn in storage. It answers the tab call as lost, and round 4's model call is the first thing it pays for.

## Context

Larry, 2026-11-12: *"any time you need to hold a DO awake, you've designed it wrong."* A turn is the one place the Galaxy still does. `runCodegenLoop` is a single function call that runs for the whole turn, up to 32 rounds and 14 minutes, with the model's transcript in a local array. `ctx.waitUntil` keeps the Galaxy in memory for it.

The model itself never waits. It answers one request, and our loop does the waiting: for the next model call, for a build, for a tab. So between any two model calls a turn is only a transcript and a place to continue from, and that fits in storage.

The personas build made this pressing. `run_in_tab` asks a Studio tab to run code, which makes it the first tool call that leaves the Galaxy. It was built waiting in memory for the tab's answer, which `mesh.md` forbids for every other call and marks TEMP for this one.

These things in today's tree stand in the way:

- **B1.** `runCodegenLoop` (`apps/nebula/src/codegen-loop.ts`) keeps a turn's transcript, its record of tool calls and its counters in local variables until the turn ends.
- **B2.** A turn's tool calls are written once, on the agent's `Message`, as `codegen.toolCalls`. A turn that never reaches its end records none of them, so nothing says what it wrote or whose claims its calls ran under.
- **B3.** `Galaxy.#tabAnswers` holds a promise per tab call, and `onTabAnswer` wakes it. An eviction loses both.
- **B4.** `Galaxy.#takenUp`, the posts running turns took up, is a field on the instance. An eviction empties it while the post it named still waits.
- **B5.** A `read_file` call records the file's size, `{ path, bytes }`, and not the content the model was sent. So today's record cannot rebuild what the model saw.
- **B6.** An eviction skips the turn's `finally`, which is what destroys the build box, so a box can outlive its turn.

The rest of this file says what a round holds, what the turn's own row holds, how a turn continues from the two, and what a waking Galaxy does first.

## Goals

- **A restart pays for no model call twice.** Today an eviction at round 20 loses twenty model calls and the turn with them. After this, the waking Galaxy pays for round 21.
- **No call waits in memory for an answer from outside the Galaxy.** Today `run_in_tab` does (B3). After this the only thing a turn waits on in memory is a model call, since nothing else can.
- **A turn's record exists while the turn runs.** Today a turn cut off leaves no trace of its calls (B2). After this, each round is on record as soon as it ends, with the claims each call ran under.
- **What a turn has done is read from storage, never remembered.** Today the instance holds it (B1, B4), so an eviction and a hang look alike from outside.

## Relationships

- **[nebula-personas-are-real-members.md](nebula-personas-are-real-members.md)** built the in-memory tab wait as a temporary one, its D23. This task removes it.
- **[nebula-pre-alpha-fast-follow.md](nebula-pre-alpha-fast-follow.md) § *Item 15: The wake check*** lists what a recovering turn has to decide first. This task decides those for a turn that has a row, and leaves Item 15 the posts that no turn took up.
- **The same file's § *Item 17: Turn-log inspection v0*** reads a person's `Message` Resources to see how their builds went. After this it reads their rounds too.

## Current state

Built already, and what becomes of each part:

- **The work of one round** in `runCodegenLoop`: parsing the model's reply, validating each call, the two loop detectors, dispatching each tool, and the feedback after a build. **Carried over.** The `while` around it and its local variables are left behind.
- **`modelText`** (`codegen-loop.ts`), the one place a tool's result becomes the model's text. **Carried over unchanged.** It is what rebuilds a tool message from a stored result.
- **`Galaxy.actUnder`**, which runs a tool under the claims recorded on the post a turn took up. **Carried over unchanged.** It reads those claims from storage, so a waking Galaxy needs nobody's token to continue.
- **`Message.codegen.toolCalls`** and its readers: `toolCallMarks` in `participants.ts`, which Studio shows, and several `/live` scenarios. **Adapted:** the calls move to rounds, and the readers follow.
- **`#tabAnswers` and `onTabAnswer`** (B3). The handler is **adapted** to write to storage, and the map is left behind.
- **`#takenUp`** (B4). **Left behind:** the post a turn took up is on its row.
- **The generation deadline, the turn's heartbeat and the transient `streamProgress` push.** **Carried over.** Token deltas stay off storage.
- **The decision between turns, and the closing step.** **Carried over.** A decision is one model call and stores nothing.

Missing:

1. A `Round` type in the chat ontology (`CHAT_MESSAGE_TYPES`).
2. A row per running turn, in the Galaxy's raw storage.
3. A way to run one round from stored state, in place of the loop that runs them all.
4. A result handler for a tool call that leaves the Galaxy, which records the answer and continues the turn.
5. A waking Galaxy that finds a turn's row and continues it.

## Design intent

The core is Larry's, from 2026-11-14, and § *Decisions* holds it. DI5 and DI7 to DI12 are the drafter's, as is what the others add to his words, and all of that is Larry's to overrule.

- **DI1. A turn is its row and its rounds.** The row is written before the first model call. A `Round` is written for each round. Between rounds nothing about the turn lives on the instance.
- **DI2. A round holds what the model returned and what each call came to.** That is the model's text and reasoning for the round, each tool call as the model wrote it, and each call's result or error with the post it acted for and the claims it ran under. Every round is a new Resource at the chat node, written by the agent as itself.

  ```ts
  // Round 3 of the turn above, as stored when its call left for Gerry's tab.
  {
    chat: '…',            // the app's one chat, indexed, as on a Message
    message: '6f0c…',     // the agent Message this turn will commit (DI9)
    index: 3,
    text: 'I will check what Gerry sees.',
    calls: [{
      id: 'call_7', name: 'run_in_tab',
      args: { tab: 'gerry', code: '…' },
      post: 'a81e…',      // Austen's post
      claims: { sub: '…austen', act: { sub: 'agent:lumenize' } },
      // no `result` and no `error` yet: this call is out
    }],
  }
  ```

- **DI3. A round is written once, when it ends, unless one of its calls leaves the Galaxy.** Then it is written as that call leaves, and again when the answer comes back, as a second snapshot of the same round (ADR-004). In the example, round 3 is written twice and rounds 1 and 2 once each.
- **DI4. The turn's row holds only what no round holds, and is deleted when the turn's `Message` commits.** That is the opening prompt as the model was first sent it, the post the turn took up with the `validFrom` it read, the agent `Message`'s id, the source commit the turn started from, and when the turn started.
- **DI5. Everything else the loop carries between rounds is worked out from the rounds.** The model's messages are rebuilt from the opening prompt and each round, through `modelText`. The round count, the files written, the last build, the detectors' memory of earlier calls and text, and whether the next round is a fix round all come from the same rounds. Larry's 2026-11-14 wording put "the loop's counters" on the row; each one can be counted from the rounds, so the row holds none.
- **DI6. A tool call that leaves the Galaxy names a result handler, and nothing waits for it.** The handler carries the turn's id and the call's id. It writes the answer onto the round and continues the turn from storage. An answer for a call that already has one is dropped. `run_in_tab` is the only such call today, and `build` could become one (§ *Beyond this task*).
- **DI7. Where a turn stands is read from its rounds.** If the last round has a call with no result, that call is next. If every call has one and the round did not end the turn, the next model call is next. Nothing stores a position, so a handler, a wake and the ordinary next step all continue the same way.
- **DI8. A waking Galaxy that finds a turn's row first settles what the eviction left, then continues.** A tab call found out is answered as lost and never sent again, since the code may have run. The build box is destroyed, since no build outlives its Galaxy (B6). A round that was cut off before it ended was never written, so its model call is made again, and the model is told the turn was interrupted and that files may have changed since its last result.
- **DI9. Every turn that has a row ends in an agent `Message`.** A turn that cannot go on says so in a fixed line of ours, the way a turn that uses all 32 rounds falls back to one today. So the `message` a round names exists once the turn has ended, and Austen never waits on a turn that is gone. A waking Galaxy that finds the `Message` already committed deletes the row and does nothing else.
- **DI10. A turn continues only from rounds the agent itself recorded.** A round sits at the chat node, where any member with `write` can put a new snapshot over it, as over a `Message` (C3). The model's next call would then run under the poster's claims on a history someone else wrote. So a round whose current snapshot the agent did not record stops the turn with a message saying so, as a post edited mid-turn does today.
- **DI11. The `Message` stays the crafted reply.** It keeps `content`, `thought`, `answers` and the turn's summary in `codegen`: the model, the source commit, the round count, how the turn stopped, the files written and the last build. `toolCalls` leaves it, and Studio reads its tool-call marks from the rounds.
- **DI12. The deadline bounds each run of a turn, not the turn.** Today 14 minutes covers the whole turn, set by the 15 minutes `waitUntil` holds one promise. A turn that wakes starts a new run with a deadline of its own, and Q2 bounds how many runs a turn gets.

### Claims this rests on

- **C1. Nothing checks that an id a resource names exists.** A field typed as another ontology type is validated as a string id (ADR-006) and nothing reads the store for it. So a round can name the agent `Message` before that `Message` is committed. Checked 2026-11-15: an ontology's `relationships` reach only the generated validator.
- **C2. The model's messages are a function of the opening prompt and the rounds.** Each message the loop sends comes from one of these: the model's own reply, a tool's result through `modelText`, or build feedback computed from the build's report and the files written. Checked 2026-11-15 by reading every `messages.push` in `runCodegenLoop`. One exception was found, B5, and Q1 is about it. Unchecked: whether the provider's tool call carries anything the next request needs beyond its id, name and arguments, and what the closing step adds after the loop, which its JSDoc says are the posts that arrived mid-turn.
- **C3. Any chat member can write over a round.** [backlog.md](backlog.md) § *Other Nebula backlog* says so of messages: a `put` at the chat node needs only `write`. Not run against a round, which does not exist yet.
- **C4. A turn's tools need nobody's live call.** They run under the claims recorded on the post, read from storage (`actUnder`). Checked 2026-11-15 by reading `runCodegenTurn`.
- **C5. Each run of a turn gets a hold of its own.** A handler's call and a wake are each a new event, so each can hand `waitUntil` a new promise. Not measured.
- **C6. An eviction can be tested where storage survives it.** The vitest-plugin lane's `ctx.abort()` keeps storage and a local `wrangler dev`'s wipes it (`durable-objects.md`). `waiting-posts.test.ts` already resets a Galaxy mid-turn there.

## Constraints

- **ADR-003:** no node holds a reply promise open across a hop. It is why the tab wait goes, and why the handler carries only two ids.
- **ADR-004 and ADR-006:** a round is a snapshot sequence, its second write is a new snapshot, and it names its chat and its `Message` by id.
- **ADR-002:** a result is stored as the value itself and becomes text only in `modelText`.
- **ADR-016 and ADR-025:** each call's record names the claims it ran under, and the agent writes each round as itself, under its own grant at the chat node.
- **ADR-001:** `Round` is declared in `CHAT_MESSAGE_TYPES`, and the change bumps `CHAT_MESSAGE_ONTOLOGY_VERSION`.
- **`durable-objects.md` § *Wall-clock billing* and § *No mutable instance state*:** no design depends on a Durable Object staying awake, and storage is the source of truth.
- **`live.md`:** the scenarios come first. Which tool the model calls is its own choice, so an eviction at a chosen round is gated in the lane that scripts the model's output, and its scene still runs in `/live` (C6 says where an eviction can be tested at all).
- **The pre-alpha wipe:** the `Message` shape changes, which rides the wipe if this lands before it.

## Beyond this task

- **Item 15's wake check gets smaller.** It is left with posts that no turn took up, and a decision an eviction cut off.
- **`build` can leave the Galaxy the same way.** It is the longest wait a turn has after the model. A round's call with no result yet is not particular to tabs, so a build that names a result handler needs no new shape.
- **Studio can show a turn's calls as they happen.** Rounds reach the chat's subscribers as they are written.
- ⚠️ Design consideration: **nothing here wakes a Galaxy that nobody calls.** After a deploy, an open Studio reconnects and that wakes it. With no Studio open, the turn continues when someone next opens the app. An alarm set as the turn starts could wake it sooner, and nothing here rules one out.
- ⚠️ Design consideration: **the model call could leave too**, if Cloudflare offers a callback that streams. On 2026-11-12 neither AI Gateway's background runs nor Workers AI's async queue did.

## Open questions

- **Q1. Where does the content of a `read_file` go?** The model's messages cannot be rebuilt without it (B5), and a platform doc can run to tens of kilobytes.
  1. **In raw storage beside the turn's row, deleted with it.** The round keeps `{ path, bytes }` as today. Nothing large reaches the chat's subscribers or stays after the turn. *Recommended:* it is what D2 already does with the opening prompt, the other large thing only a running turn needs.
  2. **On the round.** One home for everything, and a turn can be replayed long after it ended. Every Studio on the app then receives each file the model read, and the Galaxy keeps every copy for good.
  3. **Read again at rebuild.** Stores nothing, and shows the model a file as it is now in place of the one it read, which a write or a deploy in between changes.
- **Q2. How many times may a turn wake before it gives up?** A turn that kills its Galaxy on every run would otherwise try again on each wake, forever. *Recommended:* three runs, counted on the turn's row, then the fixed line of DI9. The row then also says where each interruption fell, which DI8's note to the model needs.

## Decisions

| ID | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | The per-round record is named `Round` (Larry, 2026-11-15). | `TurnRound` repeats what its reference to the turn says. `Step` is what the loop already calls a progress line. |
| D2 | A round is a Resource, a new one per round. The opening prompt sits in one raw row per turn (Larry, 2026-11-14). | Raw storage for the rounds too. As a Resource, a round reaches the chat's subscribers and records who wrote it with no code of ours. One transcript Resource updated every round: each update would store the whole transcript again. |
| D3 | The transcript stays in storage, and the result handler carries two ids (Larry, 2026-11-14). | Carrying the transcript in the handler, out and back: it is large, and it belongs in storage. |
| D4 | A tab call found out on a wake is answered as lost and never sent again (Larry, 2026-11-14). | Sending it again: the code may have run, and running it twice can write twice. |
