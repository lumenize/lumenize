# High levels of agent agency in the agent loop

**Status:** `-alt` reframe, started 2026-10-15 (`/write-task` § *When to start OVER instead — the -alt route*). Larry writes the framing one increment at a time, and the agent checks each increment's premises without arguing from [nebula-agent-posts-as-itself.md](nebula-agent-posts-as-itself.md). Once the prose here is settled, that file is mined section by section, each piece carried, superseded or dropped on purpose, and this file replaces it at its path.

## Objective

**Give the agent enough agency to keep making progress towards the chat participants goals no matter the situation while still satisfying certain security requirements.** In response to a single participant's chat message is the most obvious condition. The next level of complexity involves two participants talking collaborating on the same goal. After that comes multiple participants focused on competing goals. Then there are anomoulous situations, like when an AI call times out, the Galaxy restarts unexpectedly or awakens from hibernation. The agent may hit the tool call limit or some other constraint. Under all these conditions, the agent must be able to assess the situation and do something. We still want actions taken by the agent to be secure in particular ways. For instance, it must not be able to access tenant Star data without doing so under clear authority of a participant with that authority and only under a token that shows the chat participant as the `sub` and the agent as the `act`.

## Context

Our philosophy on agent agency is the [Manifesto for AI Agency](../docs/vision/manifesto.md): seven "X over Y" lines, each argued in the doc it names. [`_ai-security.md`](../docs/vision/_ai-security.md) argues most of them, though it is a rough draft and already behind Larry's latest thinking, and [`auth.md`](../docs/vision/auth.md) has the details of who may do what. Three points from those lines bear on this task directly:

- **Every prior state is kept, but nothing restores one yet.** The temporal data model keeps every state a resource has been in, except short-lived intermediate states that one principal coalesced with nobody else's change between them. Git keeps every committed state of code and file-based configuration. No tool rolls either back yet.
- **Attribution has to survive a group chat.** Every resource change and every git commit is attributed to a chat participant. When it is unclear who in a group chat instructed the agent, the chat it judged from sits on the same timeline as the changes, if nothing ties them more explicitly.
- **This task builds the innermost feedback loop.** Its feedback is the difference between the participants' latest goals and the current implementation, and its output is the next change to the codebase. A second loop around it comes later, improving the app's standing guidance: its skills, workflows, rules, vision documents and ADRs.

## Scenes

The scenes about people live in [agent-first-ui.md](../docs/vision/agent-first-ui.md) § *Scenes*, where they outlive this task. This section maps each of them to the claims every step runs under, so the model can be measured against them. It also holds the failure scenes, which test the loop itself and die with this task.

A step's claims are written *Jennifer + agent* for `{ sub: <Jennifer's sub>, act: { sub: 'agent:lumenize' } }`.

> **Today's code differs.** A post that arrives mid-turn starts nothing and waits for someone to post again (`#onChatCommitted` in `apps/nebula/src/galaxy.ts`). A turn's reply commits with the poster's claims and the agent as actor. The generation deadline posts nothing: it releases the single-flight latch, and the turn keeps running. A turn an eviction kills is answered only if someone posts again.

### What the mappings assume

Each premise is a candidate for § *Design intent*, and striking one changes the tables that rest on it.

1. **The agent holds a participant's claims only in memory, while it answers their post.** They arrive with the post's call and leave when the post is answered or the Galaxy is evicted. They are never stored, since a stored scope set is a security bug ([ADR-013](../docs/adr/013-identity-profileid-resolution.md)). So the agent can hold several participants' claims at once, one per post it is answering, and holds none after a restart.
2. **The agent posts as itself:** `{ sub: 'agent:lumenize' }`, with no `act`, on its own `write` grant on the `chat` node ([ADR-025](../docs/adr/025-fine-grained-access-is-the-orgtree.md)). The tables leave those steps out.
3. **Everything else it does runs as *participant + agent*,** under the claims of a participant who asked for it or said yes when the agent proposed it.
4. **Two kinds of action take more than whatever claims the agent holds.** Reading or changing a tenant Star's data, and changing who can do what (an invite, a grant, the admin bit), each run only under the claims of a participant who asked for that action or said yes to it. The check refuses claims that lack the permission, as it refuses Austen's for tenant data. Which held claims to try is the agent's judgment, and whether that judgment is enough for these two kinds of action is open question 1.
5. **Every decision ends with a post that answers every post before it.** So the next decision never finds a post already answered, and a recovery that dies again cannot loop.
6. **A post wakes the Galaxy, and a turn's end is a decision point.** Any other wake reads the thread for unanswered posts and schedules a catch-up through `svc.alarms` only if it finds one. Which posts are answered is read from the thread, never written per turn.

### Austen joins

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Tries Austen's two questions | Austen + agent | Austen asked. **Refused** by passage into each tenant Star: her plain membership in the app reaches upward, not down. |
| Answers them | Jennifer + agent | Jennifer said yes to (a), and her Universe admin membership holds dominion over every tenant Star from the app's host (premise 4). The answer is her disclosure decision. |

### Two people, one goal

| Step | Claims | Why it may, or what refuses it |
|---|---|---|
| Builds the "Shared with me" section | Jennifer + agent | Jennifer asked. Her `write` on the `chat` node is the floor for source and builds. |
| Keeps Austen's post waiting | Austen's, held in memory | Her post's own call carries them (premise 1). |
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
| Leaves Jennifer's held claims unused | — | Premise 4: an invite changes who can do what, and Jennifer has not asked for this one. |
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

The post after the deadline is the agent's own (premise 2) and answers Jennifer's post (premise 5), so no catch-up starts. The model cannot write it, since the model is what hung (open question 3). The retry runs under the claims Jennifer's yes brought.

#### The Galaxy restarts mid-turn

*Jennifer asks for a "recently bought" list and closes her laptop. Mid-turn, a deploy restarts the Galaxy, and the turn dies with it. Nothing wakes the Galaxy until Austen opens Studio the next morning.*

**Studio's agent:** Jennifer, I was interrupted while adding the "recently bought" list you asked for yesterday. Part of it may be in the source. Shall I pick it up?

**Austen:** Yes, go ahead. Jennifer and I talked about it.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she said yes. *(codegen...)* Done: completed items now move to a "recently bought" list.

The restart took Jennifer's claims (premise 1). Austen's page wakes the Galaxy, and its wake finds Jennifer's post unanswered and schedules a catch-up (premise 6). The catch-up runs with no call context, so it holds no participant's claims and can only post. Austen's yes brings her claims, and the work runs under them, though Jennifer asked for it.

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

## Design intent

- Give the agent a tool that allows it to make any `lmz.call()` but only if it has a user token, it attaches itself as the `act` for that token, and only if it has clear authority from the user. It need not know the user's permissions before attempting the call on their behalf. If that call is denied for a lack of permission, it will need to adjust for instance, by asking a user who it believes has that permission if it's OK to satisfy that user who lacks it's permission. In which case, it attempts the call under that new person's token.

## Constraints

- **The whole chat is read every turn, so what changes goes last.** Until the agent has a memory, each turn reads the chat in full. Keeping what changes at the end of the prompt lets the model provider's prompt cache reuse everything before it.

## Future state

- **Threads, which are sessions and branches.** The agent will encourage moving a piece of work into a thread. Unlike a thread in Discord or Slack, its first post is the agent's: a compacted summary of what in the main chat bears on the work, so the session starts with the context it needs.
- **A memory the main chat and every thread share.** What the agent learns about who can do what is a natural first thing to keep there.

## Open questions

1. **Is the agent's judgment enough for premise 4's two kinds of action?** Partly answered 2026-10-16 (Larry): a mix. The check is hard on every call between nodes, and tools may add permission checks of their own. Which held claims to try is judgment, more often than earlier designs assumed. The right-hand side of each manifesto line still has value; we only value the left more. What stays open is the case where the agent holds claims that would pass. In § *Austen asks to invite a friend* it holds Jennifer's, which the invite would accept, so only its judgment keeps it from inviting Riley without her yes. A check could bind each piece of work to the post it answers, running under that post's claims or a later yes's, never another held post's. If judgment is the answer, `_ai-security.md` § *A worked scenario — why the refusal is structural* overclaims when it says "the check never consults the model at all".
2. **Can the agent hold more than one participant's claims at once?** Decided 2026-10-16 (Larry): yes, in memory and never in storage. The agent knows whose claims it holds, picks the best ones for the work, or asks the person whose claims it should use. Larry's worry is that it has no way but trial and error to learn who can do what, plus what the chat has already shown. Part of that is readable, though. Every member of a Star can see who holds which grant in its tree ([ADR-008](../docs/adr/008-full-org-tree-visibility.md)), and the claims the agent holds say what each holder may do, since passage and dominion are computed from them. What it cannot read is the admin bit of someone whose claims it does not hold.
3. **Who writes the agent's post when the model can't?** Deferred until the multi-player happy path is settled (Larry, 2026-10-16). The question: when the model call hangs, or the turn uses all 32 of its tool-call rounds, the model itself cannot write the reply that ends the turn, so our own code must, either a fixed message or one more short model call.
