---
title: "You cannot inspect security into an agent"
slug: inspection-cannot-secure-agents
authors:
  - larry
tags:
  - security
  - architecture
  - ai-assisted-development
description: The emerging control-plane model for agentic security treats safety as inspection. Seventy years of quality engineering says you can't inspect quality in — you build it in with feedback loops that change the process. Here's what that looks like for agents.
draft: true
---

*Why the emerging control-plane model for agentic security gets the architecture right and the operating model wrong.*

The consensus forming around agentic security goes like this: as systems move from advising to acting, the boundary moves from the model's output to the agent's actions, so you gate every action. Each tool call, file write, and API request passes through a control plane that evaluates it against the agent's stated intent and returns a verdict — allow, deny, or escalate to a human. The Cloud Security Alliance has codified this as AARM, and it's serious work. It puts the boundary in the right place: actions, not outputs.

I have one disagreement, and it's load-bearing.

**A gate in front of every action is final inspection. And the central lesson of seventy years of quality engineering is that you cannot inspect quality in.**

<!-- truncate -->

## You build quality in; you don't inspect it in

Deming, Juran, and Crosby all converged on this from different directions. Deming's third point was *cease dependence on mass inspection*. Crosby's slogan was *prevention, not appraisal*. Juran framed quality as the continuous improvement of a process, project by project. The shared insight: inspection acts late, scales linearly with volume, and — the damning part — does nothing to the process that produced the defect, so the defects keep coming and you keep catching them, forever, at rising cost. What beat inspection was the **feedback loop**: instrument the process, watch for drift, and change the process so it stops producing the defect.

A per-action control plane is final inspection wearing a security costume. It evaluates each action in turn, acts late, scales with volume, and leaves the agent that proposed the action exactly as likely to propose the next one.

## The move: feedback that changes the process

So do for agentic security what continuous improvement did for manufacturing. Stop spending your effort on verdicts about individual actions and spend it on the **process that generates them** — the agent's system prompt, its skills, its tools, what it keeps in memory.

Run the adversarial evaluator — the skeptical sub-agent that checks a proposed action against intent — but run it in *shadow* for the overwhelming majority of actions. It doesn't gate. It records where the producer and the critic disagreed. Those disagreements are the signal. You feed them back, asynchronously, off the critical path, and the output is never a verdict on one action — it's an edit to the process: a sharper prompt, a new skill, a tool that's harder to misuse. Over time the agent proposes fewer bad actions because you improved what generates them instead of catching its output forever. The user feels none of it: zero friction on the live path, continuous improvement underneath.

## A retro is a feedback loop

This isn't theoretical — I run a hand-cranked version of it. My task-management skill ends every phase of work with a five-question retro: what did we learn, what did we struggle with, did any test fail unexpectedly, how does this change the plan — and the one that matters, *what should change about how we work?* That last question demands a concrete edit to a rule, a convention, or a skill file, and it forbids padding ("nothing this time" is a valid answer). It's the loop in miniature: this phase's friction becomes a change to the process before the next phase starts.

Note who approves what. The agent rewrites its own memory without asking me. It edits skills at its own discretion. Only changes to the top-level instructions — `CLAUDE.md` — come to me for approval. Most process changes involve no human at all; there's a full log of what changed and why if I ever care to look. That's the whole thesis applied to itself: a small, reversible tweak to a prompt doesn't earn a gate — only a high-blast-radius change does.

## The hard part: which actions are which

That distinction is the entire problem, and I won't wave at it. Start with the cost nobody prices: every gate is friction, and friction is lost utility. In a tool people *choose* to use, that's not a safety win — it's a reason to reach for something else, or to switch the gate off, and a control that gets switched off secures nothing. Gating is paid for in the only currency that keeps the product alive, so one pressure pushes hard in every case: gate as little as you possibly can.

The opposing pressure is irreversibility. Continuous improvement works on manufacturing defects because they're recoverable — the loop learns from a failure that already happened, which is fine when the cost is bounded. Some agent actions aren't. You can recall a defective car; you cannot un-send a wire transfer or un-leak a database. For those, "flag it for tomorrow's review" is no strategy, because the only way to get the training signal is to incur the harm. So some things you must gate, whatever the friction costs.

The **classifier that resolves that tension is the real artifact.** Route the reversible, low-blast-radius, high-volume majority — drafting, reading, writes you can roll back — to the improvement loop at zero friction. Keep a mechanical gate on the irreversible tail — moving money, changing permissions, deleting data, bulk reads shaped like exfiltration. The gate is affordable *precisely because the tail is small*: a step-up that fires rarely never fatigues anyone. Alert fatigue is what you get when you gate everything and the one critical approval drowns in a thousand trivial ones. Shrinking the gated set spends your scarce friction budget only where it's earned — which is also what *restores* real human oversight where it's warranted.

Here's the part I like most: **the loop improves the classifier too.** Usually that just means nudging a threshold. But sometimes the right move isn't to reclassify the action — it's to *de-risk* it. If an action sits in the gated bucket only because it can't be undone, then "give it a rollback" is a process change that moves it, safely, into the bucket that needs no human. The loop doesn't just sort actions; it changes what makes them dangerous.

## Do this first

Which is why I'd state the order plainly: **get the loop running before you build the control plane, not alongside it.** AARM's gate is the right tool for the irreversible tail — eventually. Stand it up first, over *everything*, and the friction tax comes due before it ever protects the tail: it gets switched off or rubber-stamped. Least privilege only deepens the bind — though I'd rather we said *least agency*; assume that's what we meant, since the point is the same: the less an agent is allowed to do on its own, the less useful it is, and the less likely anyone is to keep it turned on. A security model that assumes the human absorbs unlimited friction isn't modeling a human; it's modeling an oracle that does not exist.

The loop and the control plane hook into the same place — the agent's action surface — and so will everything else that wants to watch actions. The shift I'm arguing for isn't "do both." It's: instrument first, learn first, and let the loop *earn* the gate — including telling you, from real disagreement data, where the reversibility line actually belongs. When you do add the gate, point the same loop at *it*, and improve the classifier the way you improve everything else.

I don't have a good name for the loop yet. "Feedback plane" is wrong — it isn't a plane and it isn't separate. Maybe it's just the improvement loop. The name I'm sure about is the one I'm arguing against: the everything-gate. That's the conversation I'd like to have.
