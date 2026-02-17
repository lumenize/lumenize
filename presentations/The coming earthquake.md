## Part 0

### Title Slide

Title: The Coming Earthquake in Software Development

Subtitle: Identifying the Fault Lines in an AI-Driven Landscape

Presenter: Larry Maccherone

Speaker Notes: Start by acknowledging that the ground is shifting. This isn't just about a new tool; it's a fundamental change in the terrain of software development.

## Part 1: The Personal Timeline (The Shift in Building)

### 2021 – Early Tremors: GitHub Copilot

Title: The Era of Better Autocomplete

Key Point: AI as a tool, but the human is still the sole author.

Speaker Notes: Five years ago, we were impressed by line suggestions. It felt like a better IDE, not a replacement for the keyboard.

### Nov 2024 – The Tipping Point

Title: When AI Started "Getting It" (Claude 3.5)

Key Point: A jump in quality where AI understands context, not just syntax.

Speaker Notes: The length and relevance of suggestions exploded. It was the first sign that the "Software Factory" was about to be dismantled.

### Dec 2024 – The Smart-but-Dumb Pair Partner

Title: The "Hybrid" Phase: High-Trust/High-Verify

Key Point: AI writes, human reviews every type definition and test line.

Speaker Notes: I was still "hands-on." I would review key parts of code and hand-write tests to keep the AI in check.

### Feb 2025 – Crossing the Rubicon

Title: Full-Time Agentic Engineering

Key Point: Moving from using AI to operating an AI process.

Speaker Notes: Leaving my role at Contrast Security allowed me to go all-in. I stopped using AI tools and started evolving an agentic process.

### June 2025 – Building the Connectors

Title: Standardizing AI Communication (MCP)

Key Point: Model Context Protocol (MCP) and WebSocket transport.

Speaker Notes: To move fast, agents need to talk to everything. I became a contributor to MCP to help define how these systems integrate.

### July 2025 – The Platform Arrives

Title: Lumenize: Agentic Engineering at Scale

Key Point: An enterprise-grade, security-by-default platform built with AI.

Speaker Notes: Lumenize is the culmination of this shift—allowing users to interact with app data they have legitimate access to via an AI chat.

### Aug 2025 – Hands-Off the Keyboard

Title: The Pivot: Validating, Not Coding

Key Point: I stopped looking at code altogether and only spot-checked tests.

Speaker Notes: This is a major psychological barrier. The shift moved from "writing" to "governing" the agent's self-validation.

### Jan 2026 – The Modern Factory

Title: 30 Agents, One Goal: Validation

Key Point: 2/3 of all model spend and effort goes to validating the output.

Speaker Notes: Today, I spin up 30 sub-agents based on skills. The "work" is no longer generation; the work is ensuring the generation is correct.

## Part 2: The Security Professional's Misconceptions

### "Larry is just Bleeding Edge"

Title: Fact Check: I’m Actually a Generation Behind

Key Point: Anthropic revealed last week that Claude writes nearly 100% of their own code.

Speaker Notes: If the AI is building the AI, my "spot-checking" is actually conservative. This is the new baseline.

### Aside – The Liability Earthquake is Already Law

Title: Strict Liability for Software is Here

Key Point: The EU Product Liability Directive (2024/2853) and Cyber Resilience Act make software subject to the same strict liability as physical goods. "Reasonable and customary" practices are no longer a shield—if an unpatched vulnerability leads to a breach that causes damage, you're liable. Period.

Speaker Notes: Two EU laws to know. The Product Liability Directive (effective Dec 2026) treats all software—embedded, standalone, even SaaS—as a "product" under strict liability. If an exploited vulnerability causes harm, it doesn't matter if you followed industry best practices. The Cyber Resilience Act (reporting obligations start Sep 2026) requires manufacturers to report actively exploited vulnerabilities. And NIS2 adds personal executive liability—senior management can be fined or barred from leadership roles for compliance failures. This isn't hypothetical; it's already law. The US will follow.

### "Governance Can Slow This Down"

Title: The $1 Trillion Lesson: Speed is Survival

Key Point: The Feb 2026 SaaS market crash. Salesforce vs. The Weekend Builder.

Speaker Notes: The "SaaSpocalypse" proved that if you use governance to slow down, you just go out of business. People are building bespoke solutions in a weekend.

### "Developer Syntax is the Moat"

Title: The Death of the Syntax Expert

Key Point: The new senior skills: Architecting for Evolvability and Process Evolution.

Speaker Notes: Knowing "how to code" is no longer a moat. Knowing "how to manage a swarm of agents" is the new career path.

### The New Roles – Who Thrives After the Quake

Title: Four Roles That Didn't Exist Two Years Ago

Key Point: The Intrapreneur / Solopreneur, the Evolvability Architect, the Flow Engineer, and the Verification Adversary.

- **The Intrapreneur / Solopreneur** – The domain expert who can now build and ship a product without a team of developers. Inside a company, that's the intrapreneur: the product manager or subject-matter expert who spins up a working tool over a weekend. Outside, it's the solopreneur who launches a SaaS competitor from a coffee shop.
- **The Evolvability Architect** – Designs systems not for today's requirements but for next month's pivot. Thinks in boundaries, contracts, and migration paths. Ensures the agents can rip out and replace any component without a rewrite.
- **The Flow Engineer** – Owns the agentic coding process: task decomposition, agent orchestration, prompt design, guidance files, and the retrospective loop. Their goal: maximize the rate of correct output.
- **The Verification Adversary** – Builds the "verify your own work" skills and automation: test scaffolds, coverage gates, doc-example validators, security scans. Their goal: find every flaw before it ships.

Speaker Notes: Notice the first role requires zero traditional coding skill—that's the "domain experts building without technical expertise" shift. The other three are what senior engineers evolve into. Nobody's job title is "React Developer" anymore.

### Where Did Everyone Go?

Title: The Roles That Won't Survive the Quake

Key Point: Any role defined by manual execution of a repeatable process is on a fault line.

- **The Syntax Specialist** – The developer whose value was knowing framework quirks, language idioms, and boilerplate patterns. Agents know all of that now.
- **The Manual QA Gate** – Human reviewers doing line-by-line code review or manual test execution. Replaced by verification agents that run continuously.
- **The Ticket Shuffler** – Project managers whose primary output was moving cards between columns and scheduling standups. Agents don't need standups.
- **The Integration Plumber** – The developer who spent weeks wiring up APIs and data pipelines by hand. MCP and agentic orchestration handle this now.

Speaker Notes: This isn't about people losing jobs—it's about roles transforming. The syntax specialist who also thinks architecturally becomes an Evolvability Architect. The QA lead who understands what to verify becomes a Verification Adversary. The danger is clinging to the old role definition.

## Part 3: The New Process Loop

### From Code to Guidance

Title: Your New Source of Truth: AGENTS.md

Key Point: Defining conventions, architecture, and skills through persistent context.

Speaker Notes: We don't write specs anymore; we write guidance files that agents can interpret and follow.

### The Continuous Retrospective

Title: The 10-Minute Reality Check

Key Point: 4 Questions: What went wrong? What failed? What did we learn? What do we change in the guidance?

Speaker Notes: Every phase ends with an update to the process. If it failed once, it should never fail that way again.

### Radical Evolution

Title: The "First Monday" Rule

Key Point: Daily tweaks, bi-weekly pivots, and monthly radical departures.

Speaker Notes: To avoid a "local optimum," you must be willing to burn your process down once a month and try something completely different.

### The Agentic Team – Same Loop, New Boundaries

Title: A Four-Person Team That Replaces a Department

Key Point: The team structure mirrors the agent architecture: build vs. verify, with healthy tension by design.

The team:
1. **The Intrapreneur / Solopreneur** – Owns the product vision. Defines what to build, validates that the result solves the real problem. Writes guidance, not code.
2. **The Evolvability Architect** – Owns system boundaries, migration paths, and technical decisions. Reviews guidance files and architectural constraints, not pull requests.
3. **The Flow Engineer** – Owns the "build" agents. Optimizes task decomposition, prompt design, orchestration, and the retrospective loop. Their agents get their endorphin rush from producing a functioning product.
4. **The Verification Adversary** – Owns the "verify" agents. Builds test scaffolds, coverage gates, security scans, and doc validators. Their agents get their endorphin rush from finding flaws in what the build agents produced.

Speaker Notes: Notice this maps directly to the roles from "Who Thrives After the Quake." PR reviews, sprint ceremonies, QA handoffs, standup meetings—all gone. The feedback loop is now agent-to-agent, not human-to-human. The humans govern the process; the agents do the work. This team of four replaces what used to require 10-15 people in a traditional agile team.

### The Adversarial Endorphin Rush

Title: Why Your Agents Need to Fight Each Other

Key Point: Agents optimize for the goal you give them—barely within the constraints you set. Use that.

- Build agents want to ship. They'll cut corners, skip edge cases, and declare victory the moment tests pass. That's not a bug—that's their optimization function.
- Verification agents want to find flaws. They'll probe edge cases, question assumptions, and flag anything suspicious. That's *their* optimization function.
- The healthy tension between these two is what produces quality. Neither side alone produces a good outcome. Together, they create a dynamic where the build agents learn to be more careful (because they know the verification agents will catch them) and the verification agents get sharper (because the build agents keep finding new ways to be "technically correct").

Speaker Notes: This is the key insight that makes agentic engineering work at scale. It's not about one perfect agent—it's about adversarial collaboration. The Flow Engineer's job is to make the build agents as productive as possible. The Verification Adversary's job is to make the verification agents as ruthless as possible. 2/3 of my model spend goes to verification—and that's the right ratio. If your verification spend is less than your generation spend, you're shipping bugs.

## Part 4: Earthquake-Proof Security

### The FUD Slide

Title: [Attributed Content from Associate]

Speaker Notes: Use this to bridge from the "How it's built" section to "How we protect it."

### Fighting Fire with Fire

Title: Security at Machine Speed

Key Point: Google’s thousands of agents fixing code; Anthropic finding 500 zero-days.

Speaker Notes: I sat next to a Google engineer who described thousands of agents scouring their repo. You cannot compete with that using human eyes. And remember—these attacks are increasingly targeting the application and API layer specifically. The network perimeter is old news; the new attack surface is your business logic, your API endpoints, your auth flows. That's where the AI red teams are looking, and that's where your AI blue team needs to be.

### Project Shannon

Title: The AI Red Team is Already Here

Key Point: Project Shannon achieved a 96% success rate in autonomous exploitation.

Speaker Notes: It's no longer just scanning; it's active, autonomous pentesting that proves vulnerabilities are exploitable in minutes.

### The Security Meta-Process

Title: Security as an Agentic Workflow

Key Point: Security must maintain its own AGENTS.md and retrospective loop.

Speaker Notes: Security professionals must stop being "reviewers" and start being the "architects of the defense agents."

## Part -1

### Conclusion: Survival of the Adaptable

Title: The Ground Has Already Moved

Key Point: Identify your fault lines before they break.

Speaker Notes: You can't stop the earthquake, but you can build a business and a career that is earthquake-proof.