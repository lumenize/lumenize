---
status: rough draft
status_dated: 2026-10-16
---

# Manifesto for AI Agency

We are learning to work with AI agents by building Lumenize with them, and by helping domain experts build their own apps with them. Through that work we have come to value:

**Reversibility** over prevention

**Attribution** over least privilege

**Feedback** over control

**Tripwires** over human in the loop

**Fidelity** over simplicity

**Laying new track** over putting up guardrails

**Chat** over components

The things on the right have value, but we value the things on the left more.

## What each line means

### Reversibility over prevention

An action that can be undone doesn't need stopping before it happens. Every write to an app's data keeps its history ([ADR-004](../adr/004-snodgrass-temporal-resources.md)), and all code and file-based configuration lives in git, where no committed state is lost. So when an app's agent marks all 400 of a user's invoices paid instead of one, the old values are still there to write back. Prevention keeps its place for the few actions that cannot be undone, like a payment taken or an email sent. [_ai-security.md](_ai-security.md) § *Reversibility, not agency, is the risk variable* argues this line.

### Attribution over least privilege

Some refusals are critical, like one tenant reading another's data, and the platform enforces those. For the judgment calls, the usual advice is the narrowest grant that works. We rely on deterrence instead. Every data change and every git commit names the chat participant it was made for, and the chat the agent decided from sits beside them on the same timeline. Someone who takes a bad action knows it will be traced to them. The agent attributes out loud as well: before it acts, it says whose access it is using, as in "Responding to what Austen said, I'm going to proceed under Austen's authority because she asked." [_ai-security.md](_ai-security.md) § *Attribution* and [ADR-016](../adr/016-record-the-acting-principal.md) carry the mechanism.

### Feedback over control

Control tries to stop this bad thing; feedback makes the next one less likely. Nothing prevents every bad thing, and friction and inefficiency are bad things too. A feedback loop finds a mistake fast, traces it, and changes what produced it. Say the invoice mistake above traces to an ambiguous tool description. The fix is a line in the app's guidance, and the next turn is less likely to repeat it. [_ai-security.md](_ai-security.md) § *Feedback beats control* argues this line, from Deming's case against mass inspection to DORA's measurements of change approval boards.

### Tripwires over human in the loop

A human in the loop approves each action, and in practice approves nearly all of them: users approved 93% of the permission prompts Anthropic measured across Claude Code and its API. The friction also pushes people toward tools that ask less. And even a careful approval changes nothing about the next turn. A tripwire stays silent until one specific anomaly, such as 400 writes in a turn meant to change one record. Then it commits us to a review whose output is a change to the process, never just a verdict on the action. [_ai-security.md](_ai-security.md) § *Tripwires, not a human in the loop* argues this line.

### Fidelity over simplicity

Einstein's advice is usually paraphrased as "as simple as possible, but not simpler", and the *not simpler* is fidelity: a model has to keep matching what it describes. Roles fit an org chart drawn on a whiteboard. Relationships fit the real one, where people are on loan to another department and a team reports into two business units. So each Star's access control is relationship-based: a graph whose nodes may have several parents, where a grant on any path down reaches the node. A shared shopping list is one node, with its creator holding `admin` and each person it's shared with holding `write`. Fidelity matters more with an agent in the loop, because the agent acts with a person's access, and a coarse model either starves it or lets it overreach. Simplicity keeps its place where it still fits: the admin bit on a membership is a plain role, for coarse policy. [auth.md](auth.md) § *The data plane and fine-grained access control* describes the model.

### Laying new track over putting up guardrails

A guardrail stops you at the edge; new track takes you where you were going by a route that's safe. When Austen asks for numbers only the app's tenants' data holds, the agent doesn't just refuse. It asks Jennifer, who can share a one-time answer without giving Austen access to the data. Inside an account, the track is often one more grant. Every member can see who holds which grant ([ADR-008](../adr/008-full-org-tree-visibility.md)), so when Sam asks the shopping app's agent for a list he can't read, it knows whom to ask, and the owner's yes adds Sam to that list's node. [agent-first-ui.md](agent-first-ui.md) § *Austen joins* is the scene, and [_ai-security.md](_ai-security.md) § *A worked scenario — why the refusal is structural* takes it apart.

### Chat over components

Most of what a form or a button does, a person can ask an agent for in a sentence. So an app's first draft can be read-only views and a chat. Behind the chat, the human supplies goals and the criteria for judging them, not steps: Jennifer asks for items grouped by department and never says which field to add. The agent can also judge where a control can't. Studio's wipe button could only wipe, while the agent sees the wipe serving a goal, exploring the app as each persona, and reseeds the data that goal needs. A component earns its place when a person does the same thing many times a session: Jennifer asks for a checkbox after marking items complete through the chat. [agent-first-ui.md](agent-first-ui.md) argues this line, scene by scene.

## Open questions

- **Values and principles.** The Agile Manifesto pairs its four values with twelve principles. Goals and criteria over instructions, judgment over rules, and transparency over strictness each fit inside a line above rather than needing one of their own: the first two under Chat over components, the third under Attribution over least privilege. When an idea arrives that fits no line, a list of principles is where it goes.
- **When to publish.** Once each line has held up in practice, on the Lumenize site first. At publish time each line links to a public argument, such as the unpublished [inspection-cannot-secure-agents](../../website/blog/2026-06-02-inspection-cannot-secure-agents.md) post, rather than to these files.
