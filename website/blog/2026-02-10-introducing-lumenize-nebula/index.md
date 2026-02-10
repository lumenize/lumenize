---
title: "Introducing Lumenize Nebula"
slug: introducing-lumenize-nebula
authors: [larry]
tags: [nebula, announcement]
draft: true
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

Think of it as an uber-ORM that takes the best ideas from Palantir's Ontology SDK and Microsoft's Common Data Model, distilled into something a small team can actually use.

## How it works

**Declarative ontologies.** You define your business domain — entities, relationships, constraints, access rules — in a structured format. Upload it, and Nebula creates everything your front end needs.

**Document-db-style storage on Durable Objects.** Each entity lives in a Durable Object backed by SQLite JSONB. This gives you the flexibility of a document database with the transactional guarantees and locality of Durable Objects. No external database to provision. No connection pooling to manage.

**Zero backend code required.** Your front end talks directly to the ontology through a framework we provide. CRUD operations, relationships, access control — all derived from the ontology definition.

**Optional extensibility.** When you do need custom backend logic — complex validations, integrations, workflows — you write it as extensions that Nebula loads dynamically via Cloudflare's Dynamic Worker Loader. Your custom code plugs into the ontology without replacing it.

**Built on Lumenize Mesh.** Nebula inherits everything from Mesh: the peer-to-peer networking model, the security-by-default posture with `@lumenize/auth`, rich type support all the way to the browser, and the continuation-based programming model. Your front-end clients are full mesh peers, same as the backend.

## Who this is for

Nebula is designed for teams building **internal enterprise tools** and **B2B SaaS applications** — the kind of software where the business domain is complex but the UI patterns are well-understood. If you're spending more time on plumbing than on the problem domain, Nebula is for you.

It's also designed for the agentic future. When your business logic lives in a declarative ontology rather than scattered across code files, AI agents can reason about it, extend it, and build on it. The ontology becomes the shared language between humans and agents.

## Current status

Nebula is in active development. The foundation — Lumenize Mesh and Auth — ships today. Nebula builds on top of it.

We're looking for:

- **Design partners** who want to shape the ontology format and developer experience
- **Pilot customers** with complex business domains who want to build their next application on Nebula
- **Contributors** interested in pushing the boundaries of what's possible on Cloudflare's platform

If any of that sounds like you, **reach out** — [LinkedIn](https://www.linkedin.com/in/larrymaccherone/) or [Discord](https://discordapp.com/invite/lumenize).

## What's next

We'll be sharing more about Nebula's ontology format, the front-end framework, and the dynamic extensibility model in the coming weeks. Follow the [blog](/blog) or join our [Discord](https://discordapp.com/invite/lumenize) to stay in the loop.

In the meantime, check out [Lumenize Mesh](/blog/announcing-lumenize-mesh) — the foundation that makes all of this possible.
