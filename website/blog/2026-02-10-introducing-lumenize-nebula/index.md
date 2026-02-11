---
title: "Introducing Lumenize Nebula"
slug: introducing-lumenize-nebula
authors: [larry]
tags: [nebula, announcement]
description: "Lumenize Nebula: an agentic platform for building enterprise applications from declarative business ontologies — no backend code required."
---

Lumenize Nebula is an agentic software engineering platform built on [Lumenize Mesh](/blog/announcing-lumenize-mesh). Define your business ontology declaratively. Nebula handles the rest.

<!-- truncate -->

## What I've been building

For the past year, I've been heads-down building infrastructure. [Lumenize Mesh](/blog/announcing-lumenize-mesh) — which we're also announcing today — is the networking and security foundation. But Mesh was never the end goal. It was always in service of something bigger.

**Lumenize Nebula** is that something bigger.

## The vision

Enterprise software is still built the hard way. Even with modern frameworks, you're writing backend code, defining API routes, managing database schemas, wiring up access control, and then doing it all again when the business model evolves.

Nebula inverts this. You define a **business ontology** — the entities, relationships, and rules that describe your domain — and Nebula generates the entire backend. No API routes to write. No database migrations to manage. No backend code at all, unless you want it.

Think of it as an uber-ORM that takes the best ideas from Palantir's Ontology SDK and Microsoft's Common Data Model, distilled for the rest of us — the solopreneur or intrapreneur with a small team who just needs a tool that works the way *they* think and [evolves with them](https://medium.com/the-maverick-mapmaker/why-viability-overrides-agility-cc955f40b616). Not an expensive enterprise purchase — and the months-long procurement process to get there — where 90% of the features clutter your path to the 10% you actually want. Just a few hours of agentic coding to get exactly what you need — you bring the domain knowledge, Nebula provides the engineering.

## Asking ontologies, not querying tables

When Cloudflare [announced Durable Objects in 2020](https://blog.cloudflare.com/introducing-workers-durable-objects/), they noted that anyone could "potentially build [databases] on top of Durable Objects." D1 was that database — a traditional SQL database grafted onto infrastructure that is, ironically, both more modern (JavaScript, edge computing, global distribution) and rooted in something even older than SQL itself (the actor model, 1973 — one year before SQL).

Nebula breaks that constraint. Instead of building another database and querying tables, Nebula lets you define a **business ontology** and ask questions of it. The ontology *is* the interface — entities, relationships, access rules, and all. Durable Objects aren't just storage; they're the computational fabric that makes each entity a live, addressable, secure actor — one that holds context, enforces rules, and is ready for both human and AI interaction without a single query to remember who it is.

## How it works

**Declarative ontologies.** You define your business domain — entities, relationships, constraints, access rules — in a structured format. Upload it, and Nebula creates everything your front end needs.

**Document-db-style storage on Durable Objects.** Each entity lives in a Durable Object backed by SQLite JSONB. This gives you the flexibility of a document database with the transactional guarantees and locality of Durable Objects. No external database to provision. No connection pooling to manage.

**Zero backend code required.** Your front end talks directly to the ontology through a framework we provide. CRUD operations, relationships, access control — all derived from the ontology definition.

**Optional extensibility.** When you do need custom backend logic — complex validations, integrations, workflows — you write it as extensions that Nebula loads dynamically via Cloudflare's Dynamic Worker Loader. Your custom code plugs into the ontology without replacing it.

**Built on Lumenize Mesh.** Nebula inherits everything from Mesh: the peer-to-peer networking model, security-by-default auth (built on `@lumenize/auth`), rich type support all the way to the browser, and the continuation-based programming model. Your front-end clients are full mesh peers, same as the backend.

## Who this is for

Nebula is designed for teams building **internal enterprise tools** and **B2B SaaS applications** — the kind of software where the business domain is complex but the UI patterns are well-understood. If you're spending more time on plumbing than on the problem domain, Nebula is for you.

It's also designed for the agentic future. When your business logic lives in a declarative ontology rather than scattered across code files, AI agents can reason about it, extend it, and build on it. The ontology becomes the shared language between humans and agents.

## Agentic software engineering, not vibe coding

Today's vibe coding platforms optimize for speed to demo. They'll happily generate code and deploy it to AWS, Azure, Cloudflare Workers, or wherever you like — riddled with security vulnerabilities that you're expected to find and fix yourself. Those platforms give you enough rope to hang yourself; the vibe coding tools just make the rope longer.

Nebula is different. There is no "deploy anywhere" option. Nebula applications deploy to Nebula, built on Lumenize Mesh — where auth and access control are enforced at every layer by the infrastructure itself. You'd have to work harder to make something insecure than to make something that's secure by default. Compliance isn't a checklist you bolt on after the vibe coding is done. It's a structural property of the platform.

## Current status

Nebula is in active development. The foundation — Lumenize Mesh and Auth — ships today. Nebula builds on top of it.

We're looking for:

- **Design partners** who want to shape the ontology format and developer experience
- **Pilot customers** with complex business domains who want to build their next application on Nebula
- **Contributors** interested in pushing the boundaries of what's possible on Cloudflare's platform

If any of that sounds like you, **reach out** — [LinkedIn](https://www.linkedin.com/in/larrymaccherone/) or [Discord](https://discord.gg/tkug8FGfKR).

## What's next

We'll be sharing more about Nebula's ontology format, the front-end framework, and the dynamic extensibility model in the coming weeks. Follow the [blog](/blog) or join our [Discord](https://discord.gg/tkug8FGfKR) to stay in the loop.

In the meantime, check out [Lumenize Mesh](/blog/announcing-lumenize-mesh) — the foundation that makes all of this possible.
