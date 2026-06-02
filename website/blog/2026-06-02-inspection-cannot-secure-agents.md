---
title: "You cannot inspect security into an agent"
slug: inspection-cannot-secure-agents
authors:
  - larry
tags:
  - security
  - architecture
  - ai-assisted-development
description: The control-plane model for agentic security gets the architecture right and the operating model wrong. Why per-action inspection fails the same way final inspection failed manufacturing — and what a process-control approach looks like instead.
draft: true
---

*Why the control-plane model gets the architecture right and the operating model wrong — and what a process-control approach to agentic security looks like instead.*

There is a quietly forming consensus about how to secure autonomous AI agents, and it goes like this: as systems move from advising to acting, the security boundary moves from the model's output to the agent's actions. So you put a gate in front of every action. Every tool call, file write, and API request passes through a control plane that evaluates it against the agent's stated intent and returns a verdict — allow, deny, modify, escalate to a human, or defer.

<!-- truncate -->

The Cloud Security Alliance has now codified this as a specification, AARM, and I think it is the most serious piece of work in the space. Its core instinct is correct in a way that a lot of AI-security commentary is not: it locates the boundary in the right place. The old world inspected model *outputs* for toxicity or leakage. The new world has to govern *actions*, because actions have consequences you cannot retract. AARM gets that. It also gets identity binding and tamper-evident receipts right, which most people hand-wave.

So this is not a takedown. It's a disagreement about one thing, and the one thing is load-bearing.

**The control-plane model treats security as inspection. And the central lesson of the last seventy years of quality engineering is that you cannot inspect quality in.**

## The thing Deming actually proved

In the 1950s, manufacturing believed quality came from inspection: build the parts, then check each one, reject the defects. W. Edwards Deming demolished this. His argument was not that inspection is bad but that it is structurally incapable of producing quality, for reasons that compound:

Inspection happens after the cost is already incurred — you've built the defective part before you catch it. It scales linearly with volume, so as you produce more, you inspect more, forever. It creates an adversarial relationship between the inspector and the line. And most damningly, it does nothing to the *process* that generated the defect, so the process keeps generating defects and you keep catching them, in perpetuity, at increasing cost.

What replaced it was statistical process control: instrument the process itself, watch the output distribution, and act when you see the process *drifting toward* its tolerance limits — before it produces a defect. You move the locus of control upstream, from the inspector at the end of the line to the process in the middle of it. Quality stops being a gate you pass through and becomes a property of a system you tune.

This was not a marginal improvement. It was the difference between post-war Detroit and the Japanese manufacturing that ate its lunch.

Now look at a per-action control plane. A gate in front of every action that evaluates each one in turn and passes or rejects it. That is final inspection. It has every property Deming identified: it acts late, it scales with volume, it is adversarial to the thing it inspects, and it does nothing to improve the agent that keeps proposing the actions it has to catch.

## Why this is not pedantic: the human is the bottleneck

Here is where the inspection model stops being merely inelegant and starts actively failing.

A control plane has five verdicts, but in practice only three matter to a user: it lets the action through, it blocks it, or it stops and asks a human. Blocking and asking are *friction*. And friction, in a tool people choose to use, is not a safety feature. It is a reason to use a different tool.

If your control plane denies too often, users turn it off or route around it — and a security control that gets disabled provides exactly zero security. If it escalates to a human too often, you get something worse than friction: you get alert fatigue, the well-documented phenomenon where a human faced with a stream of approval requests learns to approve reflexively. At that point the human-in-the-loop is not providing oversight. They are a rubber stamp manufacturing the *appearance* of oversight, which is more dangerous than no gate at all, because now everyone believes the actions were reviewed.

There's a common rejoinder here, and it's a good one: an agent critiquing another agent is not a real security boundary — it's two stochastic processes agreeing. That's true. But it misses how people actually behave. **Faced with a choice between a system that is secure-but-high-friction and one that is useful-but-probabilistic, people choose useful and accept the risk.** Every time. This is not a moral failing to be corrected with a better spec; it is the demand environment any real agentic product ships into. A security model that assumes the human will absorb unlimited friction is not modeling the human. It is modeling an oracle that does not exist.

So the inspection model has a fixed cost — human attention — and it spends that cost on *every gated action*, whether or not the action was risky. That is the linear-scaling-with-volume problem, wearing a security costume.

## What process control looks like for agents

The alternative is to do to agentic security what SPC did to manufacturing: move the locus of control off the individual action and onto the process that generates actions.

Concretely, run your adversarial evaluator — the skeptical sub-agent that checks proposed actions against intent — but run it in *shadow mode* for the overwhelming majority of actions. It does not gate. It records: where did the producing agent and the skeptical evaluator agree, and where did the producer proceed over the evaluator's objection? Those disagreements are your control chart. They are the signal that your process is drifting toward its limits.

Then you do the thing inspection never does: you feed the disagreements back into the process. A reviewer — human, or another agent with a human auditing *its* aggregate behavior — adjudicates the deltas, asynchronously, in batch, off the critical path. And the output of that review is not a verdict on one action. It is an *adjustment to how the two agents work* — the prompts, the tools, the intent representation, the evaluator's thresholds. You are tuning the process so it drifts back inside the control limits. Over time, the agent that kept proposing questionable actions proposes fewer of them, because you improved the thing that generates them instead of catching its output forever.

The user feels none of this. Zero friction on the live path. Continuous improvement underneath. That is the six-sigma move, and it is genuinely better than per-action denial for the bulk of what agents do.

## Where the analogy breaks — and why that's the most important part

If I stopped here I'd be selling you something I don't believe, so let me argue against myself, because this is the objection that decides whether the whole frame survives.

SPC works because manufacturing defects are *stationary, independent, and non-adversarial*. A stamping press drifts out of tolerance because a die wears down — gradually, predictably, according to physics that does not know you are watching and does not change its behavior in response to your control chart. SPC is, at bottom, a theory of random variation around a stable mean.

The threats that AARM is built for are the opposite on every axis. Prompt injection, confused-deputy attacks, and data exfiltration are *adversarial and non-stationary* — the attacker reads your control chart and moves to the dimension you stopped measuring. They are *tail events, not central-tendency drift* — a process can be beautifully in control on 99.9997% of actions, and the 3.4-per-million that are not are the entire ballgame. And critically, some of their consequences are *irreversible*. You can recall a defective car. You cannot un-send a wire transfer or un-leak a database.

That last property is fatal to a pure feedback-loop model, and I want to be precise about why. A feedback loop learns from observed failures. It requires the failure to happen, be detected, and be *survivable*, so you can fold the lesson back in. For reversible actions, that's fine — the cost of the occasional bad action is bounded and recoverable, and the loop pays for itself. For irreversible actions, there is no gradient to descend, because the only way to get the training signal is to incur the unrecoverable harm. "Flag it for tomorrow's review queue" is not a strategy when the action empties the account today.

So the honest conclusion is not "process control beats inspection." It is: **these are two regimes for two different populations of action, and the entire engineering problem is the classifier that routes between them.**

## The real artifact: a reversibility taxonomy

For the reversible, high-volume, low-blast-radius majority of what an agent does — drafting, summarizing, reading, most writes you can roll back — the inspection model is malpractice. It spends scarce human attention on actions whose worst case is cheap and recoverable, and it does nothing to improve the agent. Use the process-control loop. Run the critic in shadow, learn from the disagreements, tune the process, ship zero friction.

For the irreversible or high-blast-radius tail — moving money, changing permissions, deleting data, bulk reads shaped like exfiltration — keep the mechanical gate. Here the asymmetry justifies the friction, and the friction is *affordable precisely because the tail is small*. If your taxonomy is any good, a true STEP-UP fires rarely enough that it never fatigues anyone. The reason alert fatigue happens in the first place is that the inspection model refuses to make this distinction — it gates everything, so the rare critical approval drowns in a sea of trivial ones. Shrinking the gated set is not just an efficiency gain. It is what *restores* the human's ability to provide real oversight on the actions that warrant it.

This reframes the relationship with AARM entirely. I am not trying to beat the control plane. I am arguing it has been scoped to the wrong population. AARM Core for the irreversible tail is correct. AARM Core for *everything* is final inspection, and it will be disabled or rubber-stamped into uselessness by the human bottleneck it refuses to model.

And here's the part that should make peace with the spec rather than war: the feedback loop *needs AARM's most inspection-flavored requirements to function*. Deming could not do statistical process control until he had measurement instrumentation on the line. Tamper-evident receipts and cryptographic identity binding — AARM's R5 and R6 — are that instrumentation. They are the data feed for the control chart. The receipts are not the inspector. They are what lets the process see itself drift. You cannot run my model without building most of AARM's spine; you just point that spine at a different operating model.

## The line that decides everything

Which leaves exactly one question, and it is the one I'd want to argue about in public: **where do you draw the reversibility line?**

Draw it too generously and your "learn from it later" loop becomes post-hoc inspection of unrecoverable events — the worst of both worlds, Deming in a costume over a corpse. Draw it too conservatively and you've rebuilt the everything-gate and reinvented alert fatigue. The taxonomy is the product. The classifier that sits in front of an agent's action surface and decides "this one we can learn from" versus "this one we gate now" is the actual security artifact of the agentic age — not the gate, and not the loop, but the thing that knows which is which.

I don't think the spec answers that question yet. I'm not sure I do either. But I'm increasingly sure it's the right question, and that a model built around the human as the binding constraint — rather than the human as an infinite-capacity approval oracle — is the only one that survives contact with users who can, and will, choose the useful thing over the safe one.

That's the conversation I'd like to have.
