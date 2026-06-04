---
title: "Past spec-driven: notes toward feedback as a primary artifact"
slug: past-spec-driven
authors:
  - larry
tags:
  - ai-assisted-development
  - methodology
  - studio
description: A working draft. Reading Kapil Viren Ahuja's "Spec-Driven Development Isn't Broken. It will collapse." and asking what comes after — when feedback, not spec, becomes the artifact you build the methodology around.
draft: true
---

This is a working draft, not a finished argument. I'm publishing it to myself first as a way to find the load-bearing pieces. The thinking owes a lot to Ahuja's [Spec-Driven Development Isn't Broken. It will collapse.](https://medium.com/activated-thinker/spec-driven-development-isnt-broken-it-will-collapse-c00609f72496), to back-and-forth with an LLM I was using to react against it, and to whatever Studio turns into as I build it.

The piece below is part claim, part critique, part loose ends. The unanswered questions are not throat-clearing. They are the actual structure of the next draft.

<!-- truncate -->

## The thing Ahuja gets right

Ahuja's central move is to take "the spec" — the document that's supposed to bind everything together in spec-driven development — and split it into three separable layers: **intent**, **spec**, **implementation**. His failure mode is that teams compress all three into a single document. Every problem (drift, ceremony, agents ignoring instructions, archaeology to recover what was meant) traces back to that compression.

His litmus test for spec is the part I keep coming back to: *can this be converted into an eval that passes or fails?* If not, it isn't spec — it's intent in disguise, or noise. A real spec is test-shaped.

That litmus is what's been bothering me about Nebula's ontology. The ontology captures resource shapes, per-type behavior (debounce annotations, conflict-resolver registration via `@longform` and similar), and DAG attachment patterns. It's the closest thing Nebula has to a spec layer. But by Ahuja's litmus it's only *data spec*. It doesn't capture:

- "When two users edit the same todo simultaneously, the result is X."
- "When a user reconnects after an offline period, pending writes resolve in order Y."
- "When the list has 200 items and the user scrolls fast, no skeleton ever shows after the first second."

Those are eval-shaped. They could be Vitest cases, browser-driven scenarios, or replayable traces. They are absent today. The intuition I've been calling "validation bullets" is exactly what Ahuja means by eval-shaped spec, and the gap is real.

So one concrete thing I want to write down: the ontology, as it ships today, is not yet spec in Ahuja's sense. It's data spec plus admin metadata. The behavioral acceptance layer — the part that says *when X happens, the system does Y* — lives only in the conversation history between developer and Studio, and that conversation history is not currently an artifact. It dissolves.

## The thing Ahuja gets wrong (or one generation early)

He proposes Four Crafts: Intent, Spec, Context, Prompt. He splits ownership 2/2 — human does Intent and Spec, system does Context and Prompt. He puts himself at Level 2.5–2.75 on his own Substrate Stack and admits he hasn't lived Level 3.

I think Studio is structurally further along than that, and the split isn't 2/2.

In Studio:

- **Intent** — human. Stated in conversation.
- **Spec** — *Studio drafts; human reviews*. The vibe coder doesn't write the ontology. Studio derives it from the conversation. The human reviews in chat. There may not even be a file editor surface.
- **Context** — Studio. Framework defaults, `@lumenize` conventions, the choice of Vue 3 in-DOM mode, the debounce defaults, the conflict-resolver inventory. The vibe coder never picks these.
- **Prompt** — Studio. Internal generation patterns (Ahuja's "plays"). Invisible to the user.

That's not human-2, system-2. That's human-1 plus a light review, system-3. My LLM conversation partner pushed back on me here: *if three of the four crafts live inside the system, are they crafts in any meaningful sense, or are they just modules of the system?* I think the answer is they're modules. Calling them crafts dresses up internal architecture as if the human is doing four separate things.

What does the human actually do, then? State intent. Recognize when the running output diverges from what they wanted. Articulate the gap. That's one craft. Calling it one is more honest than dressing up Studio's internals as four.

I don't know yet how Ahuja would respond to this. He might say I'm describing Level 4. He might say I've conflated "Studio does it on the user's behalf" with "Studio has automated it." There's a real distinction there I don't fully have words for. Loose end.

## The thing nobody seems to be writing about

Ahuja ends at "memory across time is the prerequisite for Level 4." He says the system needs to remember why it built what it built, not just what it was told to build on day one. Fine. But he doesn't describe what *generative use of that memory* looks like. He treats spec drift as decay. A "drifted spec is worse than no spec because it lies with confidence." His response is discipline plus archaeology.

I think there's a better move, and I think it's the publishable kernel of whatever this becomes:

> Instead of trying to keep spec aligned with intent through discipline, treat tension as a generative signal. Create tension on purpose. Resolve it explicitly. Make the resolution — not the spec — the primary artifact.

The shape of it:

1. **Explicit intent** — what the developer said they wanted, captured (somehow) as an artifact.
2. **Implementation** — what's actually running, observable.
3. **Emergent intent** — what the developer's mental model has *become* now that they've used the running output for an hour. They couldn't have articulated this upfront.

When the developer says "actually I want this to behave differently," they're surfacing a tension between the three. There are exactly three resolutions:

- **Intent was wrong.** Doing it taught them. The original intent should be updated.
- **Implementation was wrong.** Intent was clear, but the code diverged. The code should be updated.
- **Spec was wrong.** Intent and code agree, but the spec failed to capture some behavior that's now obvious. The spec should be updated.

Today's tooling collapses all three into "talk to the LLM, the LLM figures it out, no artifact, no diff, no record." That's lossy. You can't learn from tensions you didn't notice you resolved.

What I want is a system that forces the three-way resolution to be explicit. When a tension fires, Studio names it: *you said X. The system does Y. You just asked for Z. Which one is wrong?* The developer picks. The pick updates one of the three artifacts. The history of picks is itself an artifact.

The further extension — and this is the part I'm least sure about — is that Studio could *generate* tensions on purpose, ahead of the developer encountering them. Headless exploratory use of the running app. Not scripted tests (those are regression). More like: a confused new user pokes the UI and tells Studio "I tried to click the todo title to edit it; nothing happened — was that supposed to happen?" Each probe is a forced choice for the developer. Each forced choice tightens one layer of the stack.

This is a different shape from "agent evaluates its own work." It's the agent *generating the evaluation surface* by acting like a stranger to the intent.

## The thread about process feedback

This is the part I'd missed until just now. Nebula's task-management skill has a built-in 5-bullet retro after each phase. The intent of that retro is feedback on *the process itself*, not on the work product. What worked, what didn't, what to change next time.

It strikes me that Studio should have this too, and that there's an interesting symmetry once you split who the retro feeds back to:

**One retro feeds back to me** (Studio's author). Aggregated, sanitized, anonymized — patterns across many vibe coders. *Studio kept asking the same clarifying question and the answer was always the same; ship a default.* *Vibe coders consistently bounce off the same explanation; rewrite that part of the system prompt.* This is Studio learning at the species level — its system prompt evolves over time based on what the population of users found friction with.

**The other retro stays local with the developer.** A profile that captures what this particular developer knows, what they prefer, what they keep tripping over, what shortcuts they've earned. Studio adjusts its behavior toward them: less hand-holding once they've shown they don't need it, faster shortcuts for patterns they use repeatedly, gentler scaffolding for areas they're still learning. The developer can read and edit this profile. It follows them across projects.

And — this is the part I think is genuinely new — Studio can use the retro signal *to recommend process changes*, not just diagnose what went wrong. *You've been editing the title field by hand every time; want me to set up a shortcut?* *The last three sessions, you skipped reviewing the ontology and then asked for changes later. Want to enforce a review step?* Studio becomes a subtle learning instrument, not just an app-creation tool.

The instinct I'm working from is that the developer growing IS the product, more than the app they shipped. The app is the artifact; the practice is the value. Most tools optimize for the artifact. The interesting move is to optimize for the practice and let the artifact fall out of that.

## What I don't know yet (the actual structure of the next draft)

These are the questions I can't answer cleanly yet. If a finished version of this argument exists, it answers most of them.

**On intent capture:**

- How is the conversation captured? Verbatim transcript? Distilled artifact? Both with a link? If distilled, who reviews the distillation, and what happens when the developer says "no, that's not what I meant"?
- Does the captured intent become part of the deployed bundle, or does it stay in the authoring tool? (The conversation history *about* the production app might be sensitive in ways the production app itself isn't.)
- For a multi-developer app, whose intent counts? Are intents per-author, per-team, or merged?

**On tension resolution:**

- When a tension fires, who proposes the resolution — Studio or the developer? Does Studio offer "I think this is an implementation bug, not an intent change" and the developer accepts or overrides?
- What's the audit trail look like? A timeline of tensions and resolutions? Is that valuable to look back at, or is it noise?
- Can the developer *replay* the resolution history to see how their thinking evolved? Would they want to?
- What stops the system from just constantly proposing tensions and overwhelming the developer? (Coverage-guided exploration with a budget, I think, but I don't have the shape of it.)

**On the two retros:**

- Where does the developer-local profile live? In Studio's storage? On the developer's device? Inside their account? Does it survive Studio shutting down?
- What does the developer see of the profile? Everything? A summary? Can they delete entries they disagree with?
- How does the back-to-author retro get sanitized? Differential privacy? Hand-curated aggregation? The answer matters for whether the population-level learning is actually trustworthy.
- Should the back-to-author retro be opt-in, opt-out, or unavoidable? Each has consequences for adoption vs. quality of signal.

**On where Studio diverges from Ahuja's substrate stack:**

- Ahuja treats plays (his term for the structured generation patterns) as scaffolding to be dissolved at Level 5. For a vibe-coder audience, I'm not sure that's right. Vibe coders need pattern-shaped affordances, not raw model access. Plays-as-permanent isn't a maturity failure; it might be the optimization target.
- Empirical memory across projects is Ahuja's differentiator for Level 3. For Studio's audience, where each developer is mostly doing one app at a time, does cross-project memory matter, or is in-project memory enough? I lean toward in-project being enough, but I'd like to be wrong about this — cross-project memory is where Studio could become genuinely educational.

**On behavioral spec, specifically:**

- How does a non-technical user review a behavioral acceptance bullet? "When user A and user B edit the same todo simultaneously, the result is X" is reviewable in plain English, but only if the user has the mental model to evaluate X. Does Studio show a small interactive simulation? A two-pane mock? A natural-language description with a "try it" button?
- When the behavioral bullet fails (an eval breaks), what's the user's recourse? They didn't write the eval, but they need to be able to say "yes, that's the right behavior" or "no, change it." UX for that loop is unsolved.

**On Studio as learning instrument:**

- Should the "subtle learning tool" framing be visible to the developer, or operate invisibly? If visible, it risks performing teacher-ness in a way that grates. If invisible, the developer has no language for what's happening, which limits how much they can grow on purpose.
- Does the framing change Studio's pricing model? "App-creation tool" prices by app. "Learning instrument" might price by developer-month, like a teacher's hourly rate.

## Why this might be worth writing properly later

Three reasons.

One: Ahuja's piece will be widely read. It's well-argued and lands on a real failure mode. The Gen 3 hypothesis he sketches — intent-driven plus knowledge base — doesn't have a load-bearing answer for what to do about drift. He admits this in the confessions. Someone is going to write the answer. The answer I keep landing on is that *feedback, not spec, is the primary artifact*. If that's right, it's worth getting the framing out before the field calcifies around a worse one.

Two: The vibe-coder audience is real and growing fast. The substrate stack as Ahuja describes it doesn't quite fit them — his audience is enterprise engineering teams. A version of the same model that takes the vibe coder seriously as a competent practitioner whose practice is the product would be useful to that audience.

Three: The two-retros idea — author-facing and developer-facing — feels like it's pointing at something I haven't seen articulated elsewhere. Whether or not it ends up in Studio, it's worth writing down to see if it survives contact with reality.

The next draft probably has fewer hedges and tighter resolutions of the open questions above. This one is for me, mostly. If you're reading it, you're either me at a later date, or you're the LLM that helped me write it, or you're someone Larry sent the draft URL to and you should consider it provisional.
