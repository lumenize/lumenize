---
title: "Introduction"
description: "Overview of Lumenize — building blocks, Mesh framework, and Nebula agentic coding platform for Cloudflare Workers and Durable Objects"
---

# Introduction

## What is Lumenize?

Lumenize is a suite of packages for building applications on Cloudflare Workers and Durable Objects. It has three layers:

**Building blocks** — several packages that stand on their own: auth, testing, routing, structured clone, debug, and more. Each solves one problem well.

**[Lumenize Mesh](/docs/mesh)** — a framework built on those building blocks where **DOs, Workers, and browser clients are all equal peers**. Secure by default. Rich types everywhere. The foundation for any application or platform on Cloudflare. See the [Mesh Announcement](/blog/announcing-lumenize-mesh) for the full story.

**[Lumenize Nebula](/blog/introducing-lumenize-nebula)** — an agentic coding platform built on top of Mesh. Where Mesh gives you the foundation, Nebula gives you the application: enterprise-grade apps generated from declarative business ontologies, designed so AI-assisted coding produces secure software by default.

## Guiding Principles

### De✨light✨ful Developer Experience

Cloudflare's `Agent` SDK has patterns worth falling in love with — `routeAgentRequest` is elegant, and the sql and alarms code from `@cloudflare/actors` has genuinely nice DX. We borrowed liberally: our [`routeDORequest`](/docs/routing/route-do-request) is almost exactly `routeAgentRequest`, and we started with Actors' sql and alarms APIs. Then we evolved them. Actors' alarms use string method names to dispatch when an alarm fires; ours use [continuations](/docs/mesh/continuations) with full type safety, [among other upgrades](/docs/mesh/alarms#acknowledgment-to-actors-alarms). That's the pattern throughout Lumenize: find something good, understand *why* it's good, then push it further — drawing on `PartyKit` and `durable-utils` along the way.

### Opinionated Yet Flexible

Lumenize is opinionated where it counts — secure defaults, consistent patterns, clear guidance, and [integration testing](/docs/testing/usage) for your code on day one. But every extension point has a clean contract: swap in [your own email provider](/docs/auth/getting-started#email-provider), extend the base classes with your domain logic, or use the standalone packages on their own.

### Rich Types Everywhere

Pass `Date`, `Map`, `Set`, `Error` with cause chains, objects with cycles, `ArrayBuffer`, and more through calls and into storage. No `toJSON()`. No `fromJSON()`. [It just works](/docs/structured-clone).

### Secure by Default

Required [auth](/docs/auth) and fine-grained access control at every layer. Class-wide hooks, method-level `@mesh()` guards, and zero-trust security out of the box — powered by `@lumenize/auth` with passwordless magic-link login and JWT tokens.

### Engineering Excellence

The right way is the easy way — and we show you how to test it.

- In-process WebSocket integration [testing](/docs/testing/usage) that goes far beyond `cloudflare:test`
- Documentation validated against real tests via [check-examples](/docs/mesh/testing)
- 90%+ test coverage across the framework with meaningful assertions beyond happy-path scenarios
- Toggle [logging](/docs/debug) by namespace, Durable Object instance, or other context
- Committed to rapid bug fixes

## Packages

| Package | Description | Standalone | Status | License |
| --- | --- | :---: | :---: | :---: |
| [@lumenize/mesh](/docs/mesh) | Mesh networking for DOs, Workers, and browser clients | — | 🟠 Beta | MIT |
| [@lumenize/auth](/docs/auth) | Passwordless authentication with magic links and JWTs | ✓ | 🟠 Beta | MIT |
| [@lumenize/testing](/docs/testing/usage) | In-process integration testing for Durable Objects | ✓ | 🟢 GA | MIT |
| [@lumenize/debug](/docs/debug) | Structured debug logging for Cloudflare observability | ✓ | 🟢 GA | MIT |
| [@lumenize/structured-clone](/docs/structured-clone) | Rich type serialization (cycles, Date, Map, Set, etc.) | ✓ | 🟢 GA | MIT |
| [@lumenize/fetch](/docs/fetch) | Fetch wrapper for Worker-to-DO communication | — | 🔴 Experimental | MIT |
| [@lumenize/routing](/docs/routing/route-do-request) | Request routing for Durable Objects (was @lumenize/utils) | ✓ | 🟢 GA | MIT |
| [@lumenize/ts-runtime-parser-validator](/docs/ts-runtime-parser-validator) | Parse-don't-validate TypeScript runtime checks (typia) packaged for DO facets | ✓ | 🔴 Experimental | MIT |
| @lumenize/ts-runtime-validator | Deprecated — use [@lumenize/ts-runtime-parser-validator](/docs/ts-runtime-parser-validator) | ✓ | ⚫ Deprecated | MIT |
| @lumenize/rpc | Deprecated — use @lumenize/mesh (remains as foundation for @lumenize/testing) | — | ⚫ Deprecated | MIT |
| [Lumenize Nebula](/blog/introducing-lumenize-nebula) | Agentic platform for enterprise apps from declarative business ontologies | — | 🔵 Coming Soon | Unlicensed |
| [@lumenize/nebula-auth](/blog/introducing-lumenize-nebula) | Auth integration for Nebula applications | — | 🔴 Experimental | Unlicensed |
