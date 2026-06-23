# The Iron Triangle of Agentic Development

*Draft — 2026-06-22. Open questions flagged in **[brackets]**. Strategy source of truth: `docs/vision/strategy.md` (internal). Real-source list at the bottom.*

> **[OPEN — the third corner is "Swift" or "Fearless," undecided.** Draft runs with *Swift* (keeps the alliteration, classic-iron-triangle resonance). *Fearless* is the more empowering, more on-theme word for a security audience — "build fearlessly *because* the track holds" — but it muddies one row of the table. Decide before publish.**]**

Every craft has an iron triangle. In project management it's the oldest joke in the book: **good, fast, cheap — pick two.** You never get all three, and pretending otherwise is how projects die.

Agentic development has its own iron triangle. And almost everyone building in the space has quietly accepted picking two:

- **Secure** — the app, and the AI assistant inside it, only ever touch data the user is actually allowed to see.
- **Smart** — the AI's answers are as good as they would be if it could see *everything*.
- **Swift** — you build and ship at the speed of thought: no security team, no ticket queue, no admin army between you and done.

Pick two. That's the law. Watch everyone obey it.

## The three compromises you're choosing between

**Lock it down by default, and you get a dumb app.** Restrict the AI to a thin slice of data and it answers like it's been lobotomized. Secure and swift — and useless. Nobody stays here long.

**Open it all up, and you get a data breach.** This is where most of the vibe-coding industry sits *right now*, whether it admits it or not. Escape Security scanned 5,600+ apps built with these tools and found the vast majority of vulnerabilities reachable with **no authentication at all**. Lovable shipped a missing-row-level-security flaw (CVE-2025-48757, CVSS 9.3) that let *anyone* read and write arbitrary tables — one scan found 170 live apps leaking emails, phone numbers, payment details, and API keys. And the AI layer is worse: "EchoLeak" (CVE-2025-32711) was a **zero-click** data exfiltration from Microsoft 365 Copilot — the most heavily-resourced AI product on earth. Smart and swift, catastrophically not secure.

**Hire the enterprise to do it right, and you get molasses.** Role-based access control, quarterly access reviews, a standing army of admins provisioning permissions one ticket at a time. Secure and smart — and so slow that no solopreneur, and no intrapreneur worth keeping, will tolerate it. (This is the corner I know personally: I wrote the original DevSecOps manifesto trying to make it less awful. It helped. It did not make it *swift*.)

Secure, Smart, Swift. Pick two. Right?

## "That's not a tradeoff, that's physics"

Here's the objection, as strongly as I can make it:

> Fine-grained security means the AI sees less data. Less data means worse answers. So security *costs* you intelligence. Paint it however you like — you cannot give a model an answer it doesn't have the data to give. The triangle is iron.

It's a good objection. It's also wrong — for a specific, fixable reason.

## It was never physics. It was a broken *model*.

Security has always felt like a tax on quality because our access models couldn't describe reality. Roles, groups, a tidy org chart — clumsy buckets that are either too tight (you can't reach what you're entitled to → dumb answers) or too loose (you can reach what you're not → breaches). And the problem isn't only that they're **coarse**. It's that they're **rigid**: they assume the world is a clean hierarchy, and it never is. Real organizations are not trees.

I've built relationship-based access control three times in my career, and each time it's been one of the biggest keys to the result — because the messy minority is where all the value and all the risk live. At one of them — a Fortune 50 company where I was head of AppSec — I modeled an organization of 10,000 people down to the individual. Most of it *was* a clean tree. But the parts that weren't are exactly where every hard access decision lived: a person shared into one team who still carried real responsibilities in a different business unit under a completely separate reporting line; whole units that moved operationally while keeping their original chain of command; reorgs that never stopped. A tree literally cannot express any of that. A graph with *multiple parents* — a DAG — expresses all of it, without dragging the clean majority of the org into the same complexity.

That's the unlock. Two moves dissolve the triangle.

**One: relationship-based access, computed from a graph.** Instead of dropping you in a bucket, the system derives what you can reach from the actual relationships in your organization and data — a multi-parent DAG of who-relates-to-what. Your *legitimate* reach becomes precise and faithful instead of clumsy: you automatically get everything your relationships genuinely entitle you to, and nothing they don't. The AI almost never lacks data it *should* have had, because the access model finally matches the org it's protecting. Most of the "quality tax" everyone's been paying was never the price of security. It was the price of an access model that couldn't describe reality.

**Two: just-in-time elevation.** A residue remains — sometimes the best answer genuinely needs data you can't currently see. In every other system that's a dead end: the AI silently gives a worse answer, or quietly reaches for data it shouldn't. Here it does neither. It recognizes the gap and routes a one-click request to the person up your org tree who actually has authority to grant that access. The answer improves *and* every grant is deliberate, attributed, and auditable. The boundary stops being a wall and becomes a membrane.

## This isn't a guardrail

People will call this "guardrails." I've spent a long time in security, and I've come to hate that word. A guardrail is the last thing between you and the bottom of a ravine — by the time you're touching it, **you've already left the road.** That's not safety. That's failure with a backstop.

This is something else. Picture an extensive **rail network.** A train can't leave the track — there is no "off the road" to fear — and yet it reaches everywhere you actually need to go, at full speed. When you need somewhere the network doesn't cover yet, you don't jump the rails; new track is laid, deliberately, in front of you. You move fast *and* you cannot derail. The safety isn't a barrier you bounce off. It's the shape of the road itself.

## Choose three

The iron triangle of agentic development was never iron. It was a limitation of access models that couldn't describe the real world, dressed up as a law of nature. Give the system a real, relationship-based access model and a clean way to ask for more, and the trade simply disappears.

**Secure. Smart. Swift. Choose three.**

That's not aspiration. It's the bet we built Nebula on — and the reason "secure by default" ships without the asterisk that says "and therefore worse."

---

### Sources
- Escape Security — *State of vibe-coded app security* (5,600+ apps scanned, 2025): https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/
- CVE-2025-48757 — Lovable missing Supabase RLS, CVSS 9.3: https://nvd.nist.gov/vuln/detail/CVE-2025-48757 — scan of 170 leaking projects: https://mattpalmer.io/posts/cve-2025-48757/
- CVE-2025-32711 ("EchoLeak") — zero-click exfiltration from Microsoft 365 Copilot: https://msrc.microsoft.com/update-guide/vulnerability/CVE-2025-32711
- OWASP Top 10 for LLM Applications — LLM01 Prompt Injection ("no fool-proof prevention"): https://genai.owasp.org/llmrisk/llm01-prompt-injection/
