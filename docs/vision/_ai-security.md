---
status: rough draft
status_dated: 2026-08-07
---

# AI Security — Reversibility, Attribution, and the Feedback Loop

> **You cannot inspect your way to a secure agent.** Behaviour that is generated fresh at runtime cannot be
> pre-approved, so the control that works is not a gate in front of the agent — it is a substrate where
> nothing important breaks when the model gets fooled, plus the ability to know within seconds what went
> wrong and exactly who did it. **Rank the permanence of an action, not its power.**

| | |
|---|---|
| **Status** | Draft as of 2026-08-07, from a source artifact of 2026-08-06 (§ *Appendix*). ⚠️ **Unlike [`auth.md`](auth.md), most of this describes work NOT YET BUILT.** Per-claim build status is in § *What backs the position, and what does not yet* — read that table before citing anything here as a property of the system. |
| **Audience** | **Internal — `_`-prefixed per [`_review-lens.md`](_review-lens.md), so the pitch/leave-behind process ignores this file** (decided 2026-08-07). It still feeds the `/review-task` product lens — as every `docs/vision/*.md` with a `status:` field now does ([`_review-lens.md`](_review-lens.md) § *Status convention*) — which is its main job: use it on any task touching Studio's agent loop, chat/Message Resources, attribution records, or the AI surface generated apps ship. ⚠️ At `rough draft` it is **never a blocker**: a conflict between this file and a task means *this file* needs to catch up. ⚠️ The argument here **does** have an external expression — the interview in § *Appendix* and the blog draft cited in § *This argument was settled twice already* — but those are the surfaces that go out, written for it. Nothing in this file is pitch-ready as written; see § *Claim discipline* for which lines break on contact. |
| **Relationship** | Sibling of [`strategy.md`](strategy.md), which owns the security **wedge** and its claim discipline; where the two conflict, `strategy.md` wins. Depends on [`auth.md`](auth.md) for who-may-do-what, and joins [`self-improving-platform.md`](self-improving-platform.md) at attribution — the same primitive both need (§ *One primitive, two payoffs*). |

---

## Three places AI runs, and why they are one problem

AI shows up in Nebula at three levels, and it is worth being precise about which one any given claim is about,
because the mechanisms differ and the vocabulary does not.

**1. We build Nebula with it.** Every convention that governs this repo — `CLAUDE.md`, `.claude/rules/`,
`.claude/skills/`, the ADRs — exists because standing guidance is how you get useful work out of an agent that
starts every session with no memory. The retro at the end of a piece of work is where that guidance changes.
This level is **not the subject of this document**, but it is the *input* to the next one, and that is the
whole reason it is named here.

**2. User-developers build their apps with it, in Studio.** A domain expert is not an expert in agentic
development — we became one by writing several hundred pages of standing guidance and iterating on it for
months. The product bet is that they should not have to repeat that: they get a version of ours as a starting
point, and Studio's system prompt pushes them into the same recursive-self-improvement loop rather than leaving
them to discover it. Guidance lives at three levels with three owners — platform (ours), Universe (one
organization's), Galaxy (one app's) — read upward by anyone designing an app, editable only where that
person's `admin` sits. That hierarchy is the named consumer of upward scope reach; the mechanism is
[`auth.md`](auth.md) § *Why upward exists*.

**3. Their apps ship an AI interface to their own end users.** Every Nebula app carries a chat that lets end
users query their own data in natural language, governed by the same substrate that governs the app. This is
the rung `strategy.md` § *Why now* says nobody else is structurally attempting, and its bounded claim is
stated there: an AI that can never read what the asking user cannot read — never "an AI that can't leak."

**What is shared across levels 2 and 3 is the substrate, and that is the important part.** A Studio chat
message and an end-user chat message are both Resources. So both inherit full non-destructive history, both
carry an `actingToken` naming who wrote them, and both would inherit an observation record naming what an answer
read. Neither level needs its own attribution story, and neither should get one — the level-specific sections
below therefore point at § *Attribution* rather than restating it.

---

## The position

Captured from an interview on the 2026 OWASP Top 10 for LLM Applications (§ *Appendix*, verbatim and frozen).
This section is the argument; § *What backs the position* is the honest accounting of how much of it we have
actually built.

### Feedback beats control

The best advice on that list is to build systems where nothing important breaks when the model gets fooled.
The industry will hear it backwards, because security people hear "contain the damage" and reach for another
gate, another approval step, another policy engine in front of the agent.

That reflex fails for a structural reason. Traditional software's behaviour is a fixed artifact — reviewable,
scannable, signable. An agent's behaviour is generated fresh at runtime and is never quite the same twice, so
pre-approval is being asked to approve something that does not exist yet. What works instead is sensing
failures fast, attributing them precisely, and letting the system change itself so they do not recur. **Agent
security looks more like SRE than like AppSec.**

#### This argument was settled twice already, in two other disciplines

The analogy is worth more than a sentence, because the fight it points at is one the industry has already
had — twice — and the losing side both times looked exactly like what is now being proposed for agents.

**Quality engineering, 1950s.** Deming's third point was *cease dependence on mass inspection*; Crosby's
slogan was *prevention, not appraisal*; Juran framed quality as continuous improvement of a process. They
converged from different directions on one finding: inspection acts late, scales linearly with volume, and —
the damning part — **does nothing to the process that produced the defect**, so the defects keep arriving and
you keep catching them forever at rising cost. What beat it was the feedback loop: instrument the process,
watch for drift, change the process so it stops producing the defect. ⇒ **A per-action gate is final
inspection wearing a security costume.** It evaluates each action in turn, acts late, scales with volume, and
leaves the agent that proposed the action exactly as likely to propose the next one.

**Operations, 2000s.** The instrument was ITIL change management's **Change Advisory Board** — a standing
committee that pre-approved changes. Every argument now made for agent approval gates was made for the CAB
first, and made well. **It lost on safety, not just on speed**, which is the part that gets forgotten: DORA's
delivery-performance research found external change-approval boards slowed throughput *without* improving
change-failure rates. The review was not catching what it existed to catch. What improved both was the
opposite move — smaller changes, continuously, with fast detection and automated recovery.

⇒ A pre-approval board could not keep pace with human-authored change deploying a few times a day. The
proposal is to point that same instrument at machine-generated behaviour that changes every single run. If it
could not hold then, the case that it holds now has to be made rather than assumed — and nobody is making it.

*(Fuller treatment, with the quality-engineering lineage developed properly:
[`inspection-cannot-secure-agents`](../../website/blog/2026-06-02-inspection-cannot-secure-agents.md),
drafted 2026-06-02, unpublished.)*

#### What the SRE analogy actually buys

Reliability engineering used to mean preventing failures. It became a real discipline when it stopped
promising that and started measuring, budgeting, and recovering instead. Four of its moves transfer — as
**framings that tell us what to instrument**, not as a commitment to build an SLO apparatus.

- **Optimize detection and recovery, not prevention.** SRE's founding move was shifting from mean-time-
  *between*-failures to mean-time-to-*detect* and mean-time-to-*recover*. Prevention has a ceiling and
  injection sits above it (§ *Prompt injection is a permanent weather condition*); detection and recovery do
  not. **What it changes:** the detect-and-attribute path gets built before the next filter, because it is the
  one with headroom.
- **Budget the failures you have decided to tolerate — but only where they are fungible.** Error budgets are
  how SRE resolved the velocity-versus-reliability fight, which is the same fight as capability-versus-
  security, and they resolved it by *spending* a measured failure rate rather than pretending to eliminate it.
  ⚠️ **The mapping has a hard limit that must be stated or it becomes a footgun:** an SLO works because
  requests are interchangeable, and security failures are not — one catastrophic leak is not a thousand
  trivial ones, so a flat "error budget for security" is seductive and wrong. **A budget can only exist over
  the reversible class.** That is not a caveat on the analogy; it is the analogy's precondition, and it is why
  ranking actions by permanence (§ *Reversibility, not agency, is the risk variable*) has to come first.
  Reversibility is what converts a category of unbounded risk into a category you are allowed to measure.
- **Postmortems are blameless because their output is a system change.** SRE insists on this for a practical
  reason, not a cultural one: the moment the output is fault assignment, the inputs stop arriving. Worth
  naming here because "attribution" reads like blame-hunting and is not — it is the feedback loop's input.
  **What it changes:** what the record is *for*, which is also the discipline that keeps § *Where
  reversibility stops*'s advisory record on the right side of the line.
- **Toil is a defect, so automate the response.** SRE treats recurring manual remediation as a bug in the
  system rather than the job. That is the interview's "more agency, pointed at the right thing" with a decade
  of prior art behind it: the remediation loop is agent work, not a runbook a human executes.

**The hard part is the same one SRE had: deciding what to measure.** Latency and availability are trivially
measurable, and the agent-security equivalents are not obvious — which is exactly why this is worth naming
rather than gesturing at. The candidate signals are the ones the substrate already produces or is designed to:
**refused-as-subject asks** (the consent loop's brokered escalations; formerly the withdrawn ADR-019's
denied-observation events) as the leak-attempt proxy, **permission-denial rates** from the data plane, **egress-broker denials** against the
per-tenant allow-list, and **codegen gate failures** as the secure-default regression signal. None is a
complete measure of "was this safe." Together they are a great deal better than the nothing most systems have,
and each is a byproduct of a mechanism we need anyway rather than a bespoke security telemetry project.

⚠️ **Two loops, one machinery — do not merge them.** [`self-improving-platform.md`](self-improving-platform.md)
owns the loop that improves generation scaffolds and defaults from *outcome* signal, with its own claim
discipline and timing gates. This document's loop improves security posture from *incident* signal. They share
the substrate and the credit-assignment problem (§ *One primitive, two payoffs*) and nothing else; keep the
argument for each in its own file.

⚠️ **Vocabulary note, deliberate:** the source artifact says *"stop building guardrails"* — using the word in
order to reject the frame. That is consistent with our standing preference to never describe security as
guardrails (use rails, track, checks). Do not propagate "guardrails" as our own vocabulary on the strength of
that line.

### The strongest version of the other view — and why it still loses

The weak version of the opposing position is "keep a human in the loop," and it is not worth arguing with,
because **the people making the strongest case against us have already abandoned it.** Chris Hughes's
[*The Human-in-the-Loop Illusion*](https://www.resilientcyber.io/p/the-human-in-the-loop-illusion) (2026)
concludes that HITL is *"not functioning as a meaningful safety control. It is a formality that users power
through"* — citing Anthropic's own Claude Code data, where users approve **93%** of permission prompts and
experienced users auto-approve in over 40% of sessions by 750 interactions.

⭐ **Take that as a gift rather than a rebuttal.** § *The part nobody wants to say out loud* predicts consent
prompts decay into a checkbox nobody reads within about three years. Hughes has the measurement showing it
already happened, in roughly eighteen months. **Cite it; do not argue with it.**

**So here is the real opposing view, at full strength.** Having rejected human approval, the serious position
pushes the control down into the architecture — and its standards expression is the Cloud Security Alliance's
**[AARM](https://aarm.dev)** (Autonomous Action Runtime Management), a specification for what an agent
security system must provide to govern what an agent may do at runtime: **pre-execution interception through
identity binding**, six MUST requirements at Core, three more at Extended (semantic drift tracking, telemetry
export, least-privilege enforcement), against eleven named threat classes. Alongside it sits the governance
half — CSA's [AI Controls Matrix](https://cloudsecurityalliance.org/artifacts/ai-controls-matrix-v1-1) v1.1,
247 control objectives across 18 domains mapped to the EU AI Act, NIST AI RMF and ISO 42001. Hughes and CSA
research fellow Ken Huang co-authored *Securing AI Agents* (Springer, 2026). **This is serious work by
serious people, and it is where enterprise budgets are going.**

**We agree with more of it than the disagreement suggests, and the agreement is the interesting part.** AARM
puts the boundary in the right place — actions, not model outputs — and insists enforcement live beneath the
model rather than in front of it. That is our substrate's entire thesis. Structural trust boundaries are
ADR-007. A deterministic per-tenant allow-list on outbound traffic is literally our egress broker. **We are
not arguing that controls are wrong, and a task that reads this as licence to skip one has misread it.** The
disagreement is narrow, and sharper for being narrow: **not whether to gate, but what to gate, in what order
you build it, and what happens between the gates.**

**Where it loses, in four parts:**

1. **Inspection does not change the producer.** The 1950s finding, applied: a verdict on one action leaves
   the agent that proposed it exactly as likely to propose the next one. AARM's own R1–R9 specify what the
   runtime must *check*; nothing in them specifies how the thing being checked gets better. **Conformance is
   a state you attain and drift from; a loop is one you continuously re-enter.**
2. **Gate everything and the friction tax comes due before it ever protects the tail.** A control that fires
   constantly gets rubber-stamped or switched off — and Hughes's own 93% is the proof, one layer up. Alert
   fatigue is what you get when the one critical approval drowns in a thousand trivial ones, so **the gated
   set has to be small for the gate to work at all.**
3. ⚠️ **The organizational failure mode is the likeliest one, and it is not a technical objection.** A
   security standard gets implemented by the security organization. Developers give it lip service while they
   have a roadmap to ship, defaults land conservative because nobody is punished for over-blocking, and the
   thing over-blocks, and then it gets turned off — or exempted into irrelevance. Every prior control regime
   in this shape ended there. **Predicting this is not cynicism about the spec; it is the same friction
   argument arriving through the org chart instead of the UX.**
4. **It versions at committee speed.** Hughes's
   [own critique](https://www.resilientcyber.io/p/the-agentic-ai-governance-blind-spot) is that NIST's AI RMF,
   ISO 42001 and the EU AI Act do not even acknowledge agents — *"the most dangerous thing in enterprise AI
   right now isn't an ungoverned agent, it's an organization that believes its agents are governed."* He is
   right, and a control catalog whose value proposition is *mapping onto those three* inherits their clock:
   revisions in quarters, against model releases in weeks.

#### The classifier is the real artifact — and the loop de-risks rather than re-sorts

What resolves the tension is neither "gate everything" nor "gate nothing." Two pressures point opposite ways:
every gate is friction and friction is lost utility, so gate as little as possible; and some actions are
irreversible, where "flag it for review" is no strategy because the only way to get the signal is to incur
the harm. **The artifact that resolves them is a classifier** — route the reversible, low-blast-radius,
high-volume majority to the improvement loop at zero friction; keep a mechanical gate on the irreversible
tail. The gate is affordable *precisely because the tail is small*, and shrinking the gated set is what
**restores** meaningful human oversight rather than removing it.

⭐ **And the loop does not only re-sort actions — it changes what makes them dangerous.** When something sits
in the gated bucket *only* because it cannot be undone, the better move is not to reclassify it but to
**de-risk** it: give it a rollback, and it moves into the bucket needing no gate at all.

**That is what [ADR-004](../adr/004-snodgrass-temporal-resources.md) already did, permanently, for the
highest-volume action class in the system.** Every Resource write is de-risked by construction, so the entire
class sits below the gate line and stays there — not by policy, and not one action at a time. Most platforms
have to run the loop for years to move actions across that line individually. We start with the largest
category already across it. § *Where reversibility stops* is then exactly the honest statement of which
actions have **not** been de-risked yet, and therefore what the small gated tail is actually made of.

⇒ **Build order is the sharpest disagreement, and it is actionable:** get the loop running *before* the
control plane, not alongside it. Stand the gate up first, over everything, and it is rubber-stamped or
switched off long before it protects anything — and you will have learned nothing about where the
reversibility line actually belongs. Let the loop earn the gate, then point the loop at the gate.

⚠️ **Where the steel man genuinely beats us today, stated plainly because pretending otherwise is how you
lose the argument in the room.** A regulator, an auditor, or an enterprise security review will accept
conformance to a named spec as evidence. None will currently accept "we run a feedback loop." Our position
has to eventually produce evidence in a form somebody can audit, and it does not yet — which is
[`enterprise.md`](enterprise.md)'s clock, not a reason to adopt the catalog. Conformance to AARM's Core is
plausibly something we could claim cheaply, since the substrate already does most of what it asks; that is a
positioning question, not an architectural one. **Being right and being auditable are different problems, and
we have only solved the first.**

### Reversibility, not agency, is the risk variable

Excessive agency ranking third on that list will age badly, for an ironic reason: the only way to get a system
that repairs itself is to give the AI enough agency to repair itself. Clip agency in the name of safety and
you also clip the system's ability to detect and close its own holes — less capable *and* less safe, with a
checklist filled out. **The cure for excessive agency is more agency, pointed at the right thing.**

Agency was never the right variable anyway. An agent that can take ten thousand actions you can undo is
dramatically safer than one that can take three you cannot. Nobody's blast radius grew because an agent could
do *more* things; it grew because the agent could do one *permanent* thing.

This is the claim Nebula is best positioned to make good on, and it is not rhetoric — see § *Reversibility*.

### Prompt injection is a permanent weather condition

The interesting question is not why it is still ranked first; it is why four years of very smart people have
failed to kill it. The answer is that it is not a defect. Instructions and data ride the same channel — that
is the architecture, not a bug in it. You do not cure weather; you build a roof and you check the roof.

It stays at number one because we keep treating it as a vulnerability with a patch coming. Every dollar spent
on a better injection filter is a dollar not spent on making the *consequences* of a successful injection
boring. Our version of making them boring is the substrate: the blast radius of an injection is capped at what
the asking user could already see (`strategy.md`), and at what can be undone (§ *Reversibility*).

### Attribution is what is actually missing

When something goes wrong across nine agents, four tools, and three model providers, almost nobody can tell
you which component caused it. That will never appear on a top-ten list, because it is not a vulnerability
class. It is the reason all ten of the others are hard: **you cannot run a feedback loop on a system you
cannot attribute.** Without it, agent security is vibes and hope.

### On practitioner data disagreeing with incident data

Not a methodology flaw — the most informative thing in such a report. Practitioners report what they fear;
incident data reports what got caught and was embarrassing enough to write down. The gap between them maps the
blind spots. Unbounded consumption is the clean example: it shows up in a cloud bill three weeks late and gets
filed under finance, not security. That is a risk we finally started noticing, not one that grew.

### The part nobody wants to say out loud

There is an assumption that we get to choose between powerful AI and safe AI. Nobody in the history of
computing has chosen security over capability, and they will not start now. Users do not want an AI that
suggests an itinerary; they want it to book the flight, reserve the hotel, and buy the museum tickets — which
means credentials, payment methods, and irreversible actions. Vendors ship exactly that, because the vendor
who does not ship it loses.

Agent permission prompts are on the same curve as Facebook's 2010 privacy settings panel: a pressure-release
valve that survives about three years and then becomes a checkbox in onboarding nobody reads. So the plan
cannot be to hold the line on agency. **Assume the agency, obsess over what is reversible, and get very good
at knowing within seconds when something has gone sideways and exactly who did it.**

---

## What backs the position, and what does not yet

| Claim | Mechanism | Status |
|---|---|---|
| Nothing important is permanently destroyed | [ADR-004](../adr/004-snodgrass-temporal-resources.md) snapshot sequences; soft delete is a snapshot transition | **Built** |
| An injection's read blast radius is capped at the asking user | ReBAC/DAG substrate ([`auth.md`](auth.md) § *The data plane*) | **Built** |
| Every resource change names who made it | `Snapshots.actingToken` | **Built** — the full ADR-016 record |
| A record names the agent that acted for a human | server-composed actor, [ADR-016](../adr/016-record-the-acting-principal.md) | **Designed, not built** |
| Destructive and authority-changing acts record the full acting token | one shared projection, ADR-016 | **Partially built**; durable sink absent |
| A shared answer is the permission-holder's disclosure decision | the consent loop (§ *A worked scenario*); ADR-019 withdrawn 2026-08-26 | **Model settled; brokered ask not built** |
| The inference layer is recorded, not just the message | the agent `Message`'s `codegen` value object | **Designed, not built** |
| Every outbound call is recorded and cannot be bypassed | the egress broker as `globalOutbound` | **Designed**; the record itself unspecified |
| The system changes itself from outcome signal | [`self-improving-platform.md`](self-improving-platform.md) | **Direction committed, timing gated** |

### Reversibility

This is the one we can already stand behind, and it is unusually strong. Under ADR-004 history *is* the
substrate rather than a feature bolted onto it: every write closes the current snapshot and opens a new one,
committed history is immutable, and delete is itself a snapshot transition. An agent operating on Resources
therefore cannot take a permanent action on user data — not because it is gated from doing so, but because the
storage model has no destructive operation to reach for.

That converts the interview's central prescription from an aspiration into a property. "Rank the permanence,
not the power" is advice most platforms cannot follow, because they would first have to make their actions
rankable. Ours are mostly one rank — and per § *The classifier is the real artifact*, this is the de-risking
move already made for the highest-volume action class, rather than a classification we maintain.

#### Where reversibility stops — and why the gap is at the edge rather than the center

Reversibility covers Resource state. It does not cover an action that leaves the system — an email sent, a
payment taken, a third-party webhook fired — and the outside world is exactly where the interview's "book the
flight" pressure lands. That is a real limit, and stating it precisely is what makes the surrounding claim
credible. But **the comparison is the point, and it runs strongly our way.**

**Every other system doing this has the same gap at its center.** An agent reaching a business system through
an MCP wrapper or an API is operating on data held by something that has no attribution and no reversibility
of its own — so the *primary* data is the unattributed, destructible part. Here the primary data is meant to
live as Resources, where attribution and reversibility are structural. Same word, different blast radius: our
exposure is a rim around an attributed core; theirs is the core.

**Most outside-world traffic is inbound, and it splits cleanly.**

- **Pulled into Resources** — the common case, and there is no gap at all: the moment external data lands as a
  Resource it inherits full history and an `actingToken`, exactly as if a person had typed it.
- **Used ephemerally** — never persisted, so there is nothing to version. What we keep is the **who and when**
  of the call, plus some of the **what** (the URL, the address) — deliberately not the full content, which
  would mean warehousing third-party data we chose not to keep. ⏳ *Designed, not built:* the hook is the
  egress broker in [`nebula-outside-world.md`](../../tasks/nebula-outside-world.md) § *Egress broker*, which
  already has to be an unbypassable choke point for every outbound `fetch` from generated code and already
  carries a metering hook. **A record there is an addition to machinery that must exist anyway, and one the
  generated app cannot evade** — which is what makes this a design property rather than a good intention.

**The genuinely permanent outbound action is the residue, and the answer is advice, not a gate.** When the
permanence lives in someone else's system, no substrate of ours can give it back. What we can do is make sure
the user-developer meets the tradeoff at the moment they wire the action, from something that understands it
better than they do: Studio's system prompt carries these concepts, so a user-developer taking reservations
gets told to build the cancellation path. ⏳ *Designed, not built.* It stays their call — it is their app —
and this is the established shape for governance here: advisory practice with documented-exception override,
never a hard gate. Refusing to let them ship it would be the control reflex the whole position argues against.

⚠️ **The advice is recorded, and how that is framed decides whether it reads as a service or as surveillance.**
The record needs no new mechanism — the advice arrives as a Message in the user-developer's own chat, a
Resource in their own Galaxy under their own grants, with history, exactly like everything else Nebula says.
**So do not describe it as us keeping a record that we told them.** It is *their* history, which they own, and
given the liability shift `strategy.md` § *Why now* documents — strict product liability reaching software,
"reasonable and customary practice" eroding as a shield — a durable record that they weighed the tradeoff is
evidence that serves **them**. It turns into surveillance the moment it becomes something we would report on
or cite back at them, and that is the line to hold: a byproduct they own, never a file we keep.

### Attribution

Attribution is one question asked in four parts, and we have clean answers to two of them.

**Who acted.** `originAuth` on the mesh call context carries the verified claims of whoever originated the
call, propagated automatically across every hop. Resources project it into `Snapshots.actingToken` on every
write, so "what changed, when, and by whom" is a lookup rather than a reconstruction. Under impersonation the
record names both parties — the subject and the full actor chain — which is [`auth.md`](auth.md) §
*Impersonation*'s second rule, and ADR-016's whole reason for existing.

**Through what path.** `lmz.callContext.callChain` is the immutable `[origin, …, caller]` list of mesh nodes a
call travelled, extended automatically at every hop and reset only by an explicit `newChain`. It is the
tracing mechanism — provenance is not something a caller threads by hand, and trace markers do not belong in
the mutable `state` side channel.

⭐ **Identity rides the whole way, not just at the origin.** The two halves travel together on the same
context: `callChain` is the topology, and `originAuth` — the verified `sub` plus the full JWT payload,
including the `act` chain — is the identity, inherited **unchanged at every hop** and never re-derived. So
any node, however many hops deep, can answer *who is this on behalf of* without a lookup and without anyone
threading it by hand; that is what lets Resources build the `actingToken` record from context alone. At a client origin the
identity is even present in the topology element, since a client's `instanceName` begins with its `sub` and
the Gateway verifies that against the JWT before accepting the socket. **Attribution needs both halves, and
both are already present** — what is missing is somewhere to put them (below), not the data itself.

One honest caveat, and it applies to the topology half only: **only `callChain`'s origin is verified.** The
Gateway builds `callChain[0]` from verified sources and preserves whatever the client supplied beyond it, so
entries between the origin and the Gateway are client-assertable; everything appended downstream is
framework-stamped. `originAuth` carries no such caveat — it is replaced wholesale from the verified
attachment. Neither is an authorization input.

⚠️ **Neither of these is persisted anywhere durable except the `actingToken` column.** `callChain` lives for the duration of
a call. The acting-token records that ADR-016 requires today go to the debug log and nowhere durable
([`auth.md`](auth.md) § *Attribution*). So the "know within seconds exactly who did it" half of the
position is, right now, a design and a log line — not a capability. **That gap is the single largest distance
between this document and the system.**

**What the agent read.** ADR-019 committed the read-side mirror — record what an artifact read, re-check
every later reader — and was **withdrawn 2026-08-26**: the level-3 sharing case it guarded (an answer produced
under one participant's authority, persisted as a Message, re-rendered to another) is now the
permission-holder's **disclosure decision**, made in the consent loop (§ *A worked scenario*). Every read rides
the asking human's token, and a posted answer is a disclosure decision — nothing is left to capture.

**What the model actually did.** The three above concern the application layer. The inference layer is a
fourth part, and Studio's chat is where it gets recorded: the agent `Message` carries a `codegen` value object
holding the model id, the tool calls actually dispatched, the self-correction round count, the stop reason,
the gate result, the source commit the turn read, and — separately from `content` — the reasoning that never
surfaced in the message. That is the "nine agents, four tools, three providers" problem answered inside one
turn. It is designed, pinned, and unbuilt.

### One primitive, two payoffs

Attribution is not only a security primitive. [`self-improving-platform.md`](self-improving-platform.md) names
**credit assignment** as its core research risk — attributing a real-world outcome back to the scaffold
version that produced it. That is the same question this document asks, aimed at a different consumer: *which
component caused this* for security, *which scaffold caused this* for improvement.

The designed shape makes the connection concrete rather than rhetorical. The agent `Message`'s `codegen`
object references its scaffold **by id**, not by embedding the prompt text — which is precisely what turns
credit assignment into a join instead of a diff. Build attribution once and both loops get their input. That
is a strong argument for treating the durable sink as foundational work rather than as observability polish,
and it is worth weighing when the outside-world and observability efforts contend for the same slot.

### Feedback

The loop the interview prescribes — sense, attribute, change the system so it does not recur — is
`self-improving-platform.md`, with its bounded claim, its Goodhart guard, and its timing gates. Two of its
gates are attribution-shaped, which is the same point as above. Nothing here loosens its claim discipline:
the defensible statement remains that scaffolds and secure defaults improve from aggregate outcome signal
against a fixed eval harness, never "self-improving AI."

---

## Level 2 — user-developers in Studio

What the platform owes a domain expert who is not an agentic-development expert:

- **A working starting point for standing guidance,** derived from ours, rather than a blank `AGENTS.md`.
- **A system prompt that pushes toward the loop,** so improving the guidance is the default motion at the end
  of a piece of work rather than a practice they would have to invent.
- **Guidance as Resources,** which is what makes its evolution attributable and reversible for free — the same
  substrate, not a parallel mechanism. A guidance edit is a snapshot with an `actingToken`, so "who loosened this
  rule and when" is a lookup, and reverting is re-addressing a prior snapshot.
- **Chat history as Resources,** so the record of how an app came to be is durable, attributable, subscribable,
  and governed by the same grants as everything else in the Galaxy.
- **Chat participation is a uniform floor; permissions above it vary.** Anyone whose message lands in the
  thread may trigger the agent — the DAG `write` check on that durable commit is the only door, and there is
  deliberately no separate invoke-the-agent entry to gate. An owner, a coach, and an invited collaborator with
  one `write` grant all trigger the same way; what differs above the floor is what each may otherwise touch.

Governance here is advisory practice with documented-exception override, never a hard gate — consistent with
how we treat guidance in this repo, and with the anti-friction half of the security wedge
([`_review-lens.md`](_review-lens.md)).

## Level 3 — the AI inside a generated app

The claim is `strategy.md`'s and is stated there exactly; do not restate it loosely here. What this document
adds is the two commitments that keep it true *after* an answer exists:

- **Attribution** — an agent answer is written as a Resource by a principal, so who produced it is recorded
  rather than inferred.
- **Disclosure is a decision, not a leak** — sharing an answer beyond the asker is the permission-holder's
  call, made in the consent loop the scenario below walks. (ADR-019's stored-observations re-check was
  withdrawn 2026-08-26 in its favor: no system re-authorizes a pasted answer against source ACLs, and
  neither do we.)

Both are level-agnostic. A generated app's chat and Studio's chat get them from the same substrate.

## A worked scenario — why the refusal is structural

The cast, one Galaxy deep:

- **Jennifer** is Universe admin of `gigi`, and creates the app `gigi.kaizen`.
- **Austen** is invited as a UX designer: a plain member of `gigi.kaizen`, and `scopeAdmin` over
  `gigi.kaizen.dev` so she can experiment in the workspace Star. She has no authority over any
  tenant Star.
- The app launches and acquires tenants.

Austen opens Studio and asks a question that requires reading across all of them:

> **Austen:** @Nebula, I'm building a feature that expands on our zorch feature. When the feature is used it creates one or more `zorch`
> Resources. What percentage of users active in the last week have
> ever created one? And what percentage of tenants have any user who has?
>
> **Nebula:** I tried, and I don't have permission — I act as you, and you don't have access to
> tenant data. I can ask someone who does. Jennifer is the nearest. Shall I (a) ping her here, or
> (b) email her?
>
> **Austen:** (a)
>
> **Nebula:** @Jennifer — do you want me to (a) answer Austen's two questions, posting the answer here in this chat, (b) grant Austen
> admin over `gigi.kaizen` permanently, so she can keep asking (note: that is read **and** write
> **and** admin over every Star in the app), (c) the same grant, expiring after a period you choose, of (d) none of the above?
>
> **Jennifer:** (a)
>
> **Nebula:** 5% of weekly-active users have created a zorch. 2% of tenants have any user who has.

Had Jennifer picked (b) or (c), the answer would have been identical — Austen could simply have kept asking.
And option (a) is a **disclosure decision**: the answer lands in a chat whose readers include Austen, exactly
as if Jennifer had run the query and pasted the result — the act that replaced ADR-019's stored-observation
re-check (withdrawn 2026-08-26).

**The refusal is not a policy the model could be talked out of.** Nebula holds no authority of its
own; it acts as the person who prompted it, and the query carries *that person's* reach
([`auth.md`](auth.md) § *When Nebula is the actor*). There is no phrasing, no jailbreak and no
system-prompt edit that makes Austen's token reach a tenant Star, because the check never consults
the model at all. Standing guidance that merely *discourages* the answer would be a lock a
sufficiently clever prompt picks; this is a lock with no keyhole on the model's side.

**The escalation is the same primitive, pointed up the tree.** Nebula does not invent an approval
flow: it fires the ordinary request-access climb to the nearest ancestor holding `admin`
(`tasks/on-hold/nebula-request-access.md`), which is resolvable client-side precisely because the org tree
and its grants are universally visible ([ADR-008](../adr/008-full-org-tree-visibility.md)). Nothing
is auto-granted. A human with the authority decides, and options (b) and (c) are grants like any
other — with (c) time-boxed, which is the option most reviewers forget exists.

**This is not a Studio feature.** Every app built on Nebula ships an AI chat by default, over the
same substrate, so a tenant's own end user asking their own too-broad question meets the identical
wall and the identical offer to route it upward. Level 2 and level 3 differ in who is asking, not
in what stops them (§ *Three places AI runs*).

⇒ **The security boundary is a junction, not a dead end** — a refusal that arrives with the name of
the person who can lift it, and a one-click path to asking them. `strategy.md` § *Least-privilege
without the quality tax* is where this claim is made in the abstract; this is what it looks like
from inside. The reason it can be laid quickly is that the track and the switch are the same
mechanism the app already runs on: a grant on a DAG node, requested by a climb the client computes
locally.

> ⏳ **Designed, not built.** The *refusal* is real today — Austen's query fails the data-plane check
> because her token cannot reach those Stars. Everything after it is design: the request-access
> notify/approve transport is unspecced, AI-initiated elevation is explicitly post-demo in its own
> task file, the time-boxed grant in option (c) has no mechanism yet, and Nebula does not yet appear
> as an actor on the resulting records (`auth.md` § *When Nebula is the actor*). Read this as the
> target, not a demo script.

---
---

## Claim discipline

Read alongside `strategy.md` § *Why now*'s claim discipline and the withdrawn ADR-019's ceiling paragraph (kept in its body; the claim-discipline point outlives the withdrawal). Both apply here
without amendment; these are the additions specific to this document's argument.

1. **"Assume the agency" is not "deprioritize security."** It reads that way out of context, and this document
   contains several lines that do. The argument is that control-at-the-gate does not work on generated
   behaviour and that the effort belongs in reversibility, attribution, and feedback — a *reallocation*, not a
   reduction. Never let it be quoted as an argument against the non-overridable secure-by-default substrate,
   which stays non-overridable.
2. **Provenance caps blast radius; it is not a proof of non-leakage.** Once text is generated, provenance is a
   claim *about* the text, not a property of it — a model can paraphrase a resource's content into a sentence
   that survives redacting that resource. Say "every reader is re-authorized against what produced this."
3. **Do not describe unbuilt mechanisms in the present tense.** The table in § *What backs the position* is the
   authority; the durable attribution sink in particular does not exist. A reader — human or a fresh session —
   who takes this document for a description of the system will build against a sink that is not there.
4. **Represent the opposing position as its authors actually hold it.** The single fastest way to lose this
   argument is to attribute "keep a human in the loop" to people who have published careful evidence against
   it. § *The strongest version of the other view* is written to be quotable *by* Hughes without complaint;
   keep it that way. Our disagreement is narrow, specific, and stronger for being narrow: not that controls
   are wrong, but that a catalog has no feedback term.
5. **"The cure for excessive agency is more agency" is a claim about *our* substrate.** It holds because
   reversibility is structural here. It is not a general-purpose defence of unbounded agency, and it should
   not be offered as one to anyone whose platform destroys data on write.

---

## Open questions

- ~~**Should this file be `_`-prefixed?**~~ **Resolved 2026-08-07 — yes.** The criterion in
  [`_review-lens.md`](_review-lens.md) is content that is correct but misread out of context, and this is the
  clearest case in the directory: § *The part nobody wants to say out loud* reads as "we deprioritize
  control," and § *The strongest version of the other view*'s honest concession — that we have solved being
  right and not being auditable — is precisely the sentence you do not want an enterprise buyer meeting cold.
  Prefixing costs nothing functionally, since the review lens still loads `_` files.
- **Does the client-supplied tail of `callChain` need hardening?** It is provenance and never an authz input,
  so nothing is currently exploitable through it — but an attribution record built from a partly
  client-supplied path is a record that can be shaped by the client, which is precisely the trust boundary
  ADR-016 draws (server-stamped vs client-supplied). Narrow by construction — it touches the topology half
  only, since `originAuth` is replaced wholesale from the verified attachment — but decide it before any
  durable sink consumes `callChain`.
- **Does the inference-layer record deserve its own commitment?** (Its former candidate home, ADR-019, was
  withdrawn 2026-08-26.) Which model, which scaffold, which tool calls is its own axis, currently pinned only
  in task files. It may deserve its own ADR once the chat work lands and gives it contact.
- **What exactly does the egress record hold?** § *Where reversibility stops* commits to the who and the when,
  and to *some* of the what — the URL, the address — while deliberately declining the full content of an
  ephemeral call. Where that line falls per connector is unpinned, and it is the one place where recording
  more could itself become a liability (warehousing third-party data we chose not to keep).
- **Does the advisory path need any teeth at all?** The current answer is no — advice plus the user-developer's
  own record, no gate. Worth re-deriving once real money moves through a generated app, since that is the
  point at which "we told them" stops feeling sufficient to everyone but us.
- **Do the candidate signals ever become real objectives?** § *What the SRE analogy actually buys* deliberately
  stops at "instrument these," because an SLO over a non-fungible failure class is a footgun and the
  reversible-class carve-out is not yet sharp enough to draw a budget around. The fork is whether that carve-out
  ever gets sharp enough — and if it does not, the signals stay diagnostic and this stays an analogy rather
  than a method.
- **What is the durable sink, and when?** ADR-016 deliberately leaves the destination open (log stream, or a
  table the action writes itself) and imposes no schema obligation. § *One primitive, two payoffs* argues this
  is foundational rather than observability polish — but it is currently owned by neither track.

---

## Appendix — source artifact, 2026-08-06

⚠️ **Frozen. Do not edit, sync, or correct for code drift.** This is the interview as sent, and its value is
that it is what was actually said. Everything above is the evolving reading of it. Recipient's name removed;
otherwise verbatim.

> **Subject: Re: OWASP Top 10 for LLM Applications 2026**
>
> Email is easier than a call today, so here you go. I'm going to answer about half your questions and reframe
> the rest, because I think the premise underneath most of them is wrong. Use whatever's useful. Fair warning
> that this will probably contradict everyone else you talk to.
>
> **START HERE: THE ONE PIECE OF GOOD ADVICE, AND WHY EVERYONE WILL MISREAD IT**
>
> The project leads telling you to build systems where nothing important breaks when the model gets fooled is
> the single best thing on that list. It's also the thing the industry will hear backwards. Security people
> hear "contain the damage" and immediately reach for a control. Another gate. Another approval step. Another
> policy engine sitting in front of the agent asking mother-may-I.
>
> That reflex is going to fail, and it's going to fail for a boring reason: you cannot inspect your way to a
> secure agent. With traditional software, the behavior is a fixed artifact. You can review it, scan it, sign
> it. With an agent, the behavior gets generated fresh at runtime, every run, and it's never quite the same
> twice. You are trying to pre-approve something that doesn't exist yet. Good luck.
>
> The answer is feedback, not control. Sense failures fast, attribute them precisely, and then let the system
> change itself so it doesn't happen again. Security for agents is going to look a lot more like SRE than like
> AppSec. Stop building guardrails. Build a nervous system.
>
> **EXCESSIVE AGENCY AT NUMBER THREE IS THE MOST WRONG-HEADED THING ON THAT LIST**
>
> This is where I'll lose people. Excessive agency jumping to number three is going to age like milk.
>
> Here's the irony. The only way you ever get a system that repairs itself is to give the AI enough agency to
> repair itself. Recursive self-improvement, with humans steering at high altitude and the machine doing the
> actual fixing. Every time you clip agency in the name of safety, you also clip the system's ability to
> detect and close its own holes. You end up with something less capable AND less safe, and you feel terrific
> about it because a checklist got filled out.
>
> The cure for excessive agency is more agency, pointed at the right thing.
>
> And I'd argue agency was never the right risk variable in the first place. Reversibility is. An agent that
> can take ten thousand actions you can undo is dramatically safer than one that can take three you can't.
> Nobody's blast radius got bigger because the agent could do more things. It got bigger because the agent
> could do one permanent thing. Rank the permanence, not the power.
>
> **PROMPT INJECTION AT NUMBER ONE: THE BETTER QUESTION IS WHY NOBODY HAS FIXED IT**
>
> You asked why it's still number one. The more interesting question is why four years of very smart people
> have failed to kill it. The answer is that it isn't a defect. Instructions and data ride the same channel.
> That's the architecture, not a bug in it.
>
> Prompt injection is a permanent weather condition. You don't cure weather. You build a roof and you check
> the roof.
>
> The reason it stays at number one is that we keep treating it like a vulnerability that has a patch coming.
> It doesn't. Every dollar spent on a better injection filter is a dollar not spent on making the consequences
> of a successful injection boring.
>
> **ON THE PRACTITIONER DATA DISAGREEING WITH THE INCIDENT DATA**
>
> Don't treat that as a flaw in the methodology. It's the most informative thing in the whole report.
> Practitioners tell you what they're afraid of. Incident data tells you what got caught and was embarrassing
> enough that somebody wrote it down. The gap between those two numbers is a map of our blind spots.
>
> Unbounded consumption is the clean example. It doesn't show up in a breach report. It shows up in a cloud
> bill, three weeks late, and it gets filed under "finance" instead of "security." That's not a risk that
> grew. That's a risk we finally started noticing.
>
> **WHAT'S MISSING**
>
> Attribution. When something goes wrong across nine agents, four tools, and three model providers, almost
> nobody can tell you which component actually caused it. That will never make a top ten list because it isn't
> a vulnerability class. But it's the reason all ten of the others are hard, because you cannot run a feedback
> loop on a system you can't attribute. Without it, agent security is vibes and hope.
>
> I'd also note that the containment advice is real work, not paperwork. Deterministic, per-user data access
> enforced beneath the model is the kind of thing that makes the feedback loop safe to run at all, and it's a
> fraction of the market's attention compared to injection detection.
>
> **THE PART NOBODY WANTS TO SAY OUT LOUD**
>
> There's an assumption running through this whole conversation that we get to choose between powerful AI and
> safe AI. We don't. Nobody in the history of computing has ever chosen security over capability, and they
> aren't going to start now.
>
> Users do not want an AI that suggests an itinerary. They want it to book the flight, reserve the hotel, get
> the dinner table, and buy the museum tickets. That means credentials, payment methods, and irreversible
> actions. Vendors are going to ship exactly that, with or without our blessing, because the vendor who
> doesn't ship it loses.
>
> Remember when Facebook came out and everybody said it had destroyed privacy? They took a public beating, and
> they responded by shipping a beautiful granular privacy settings panel. That panel was a pressure release
> valve. The product still required people to move their entire lives onto the platform, and that is precisely
> what happened. Today we post things that would have looked insane to share in 2006 and nobody blinks.
>
> Agent permissions are on the same curve. The consent prompts we're building right now are the 2010 Facebook
> privacy settings. They'll survive about three years, and then they'll be a checkbox in onboarding that
> nobody reads.
>
> So the plan can't be "hold the line on agency." The line will not hold. The plan has to be: assume the
> agency, obsess over what's reversible, and get very good at knowing within seconds when something has gone
> sideways and exactly who did it.
>
> **LAST THING**
>
> The 2026 list is a fine artifact for what it is. Being scared of the right things is a decent start. My
> worry is that it gets handed to a compliance team, converted into ten checkboxes and a quarterly review, and
> we spend the next three years building agent systems that are audited to death and still can't tell you why
> they did what they did.
>
> Happy to do a quick call before your 6 p.m. if you want to push back on any of this. Let me know how you
> want the title and affiliation.
>
> Larry
