# Code Attributions

This file acknowledges code that has been copied, adapted, or used as inspiration from other open-source projects.

## @ungap/structured-clone (Inspiration)
- **Source**: https://github.com/ungap/structured-clone
- **License**: ISC (https://github.com/ungap/structured-clone/blob/main/LICENSE)
- **Used In**: `packages/structured-clone/` (inspired approach, not copied code)
- **Purpose**: Provided inspiration for structured clone algorithm approach and cycle/alias detection using WeakMap.
- **Date Added**: 2025-01-30
- **Author**: Andrea Giammarchi (@WebReflection)
- **Note**: We implemented our own algorithm from scratch with a different serialization format (tuple-based with `$lmz` references), but were inspired by @ungap/structured-clone's approach to handling cycles and type detection.

## Cap'n Web (Inspiration)
- **Source**: https://github.com/cloudflare/capnweb
- **License**: Apache-2.0 (https://github.com/cloudflare/capnweb/blob/main/LICENSE)
- **Used In**: `packages/structured-clone/` (inspired tuple format)
- **Purpose**: Inspired our tuple-based serialization format `["type", data]` for human-readable, self-describing JSON serialization.
- **Date Added**: 2025-01-30
- **Author**: Cloudflare
- **Note**: Cap'n Web uses a tuple format without cycles/aliases. We adopted the tuple approach but extended it with `["$lmz", index]` references to support cycles and aliases.

## Cloudflare Actors - Alarms Package
- **Source**: https://github.com/cloudflare/actors/tree/e910e86ac1567fe58e389d1938afbdf1e53750ff/packages/alarms
- **License**: Apache-2.0 (https://github.com/cloudflare/actors/blob/main/LICENSE)
- **Used In**: `packages/alarms/src/alarms.ts` (copied and adapted)
- **Purpose**: Provides alarm scheduling system for Durable Objects with support for one-time, delayed, and cron-based recurring schedules using SQL storage.
- **Date Added**: 2025-11-02
- **Author**: Cloudflare
- **Note**: Source code adapted from cloudflare/actors alarms package with the following modifications: (1) NADIS dependency injection pattern instead of mixin approach, (2) lazy table initialization for compatibility with NADIS auto-injection, (3) removed actor-specific dependencies (setName, actorName), (4) added TypeScript generics for enhanced type safety, (5) made schedule/getSchedule/cancelSchedule methods synchronous, (6) added triggerAlarms() testing helper for reliable alarm testing.

## typia (Copied — partial)
- **Source**: https://github.com/samchon/typia (tag `v12.0.2`)
- **License**: MIT (https://github.com/samchon/typia/blob/master/LICENSE)
- **Used In**: `packages/ts-runtime-parser-validator/forks/typia/{core,transform,interface,utils}/` — source copied in-tree.
- **Purpose**: `@typia/transform` and its three dependency packages (`@typia/core`, `@typia/interface`, `@typia/utils`). Copied rather than npm-installed so we can add visit-tracking to the generated validators.
- **Date Added**: 2026-04-24
- **Author**: Jeongho Nam
- **Note**: Source copied from the `v12.0.2` tag; compiled in-place via esbuild through `packages/ts-runtime-parser-validator/scripts/bundle-dependencies.mjs`. Wired via local npm workspaces — no submodule, no GitHub fork, no publish. Phase 1 is a behavioral no-op. Modifications (Phase 2 onwards: unconditional visit-tracking with `WeakMap`, re-entry as a no-op) will be documented here. See `tasks/typia-visit-tracking.md` for full context.

## SimpleMimeMessage (Copied)
- **Source**: `lumenize-monolith/test/simple-mime-message.ts` (internal, same repo)
- **License**: MIT (Lumenize)
- **Used In**: `tooling/email-test/src/simple-mime-message.ts`
- **Purpose**: Simple MIME message builder for constructing test emails in Workers runtime. Used to create synthetic inbound emails for testing the EmailTestDO email parsing pipeline.
- **Date Added**: 2026-02-09
- **Author**: Lumenize
- **Note**: Copied with minor adaptation (TypeScript `private` → `#` prefix for private members, per project conventions).
