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

## durable-utils — SQLSchemaMigrations (Vendored & modified)
- **Source**: https://github.com/lambrospetrou/durable-utils (`src/sql-migrations.ts`)
- **License**: MIT (https://github.com/lambrospetrou/durable-utils/blob/main/LICENSE)
- **Used In**: `packages/sql-migrations/src/index.ts` (copied and modified)
- **Purpose**: An id-gated SQL schema-migration runner for SQLite-backed Durable Objects (`@lumenize/sql-migrations`).
- **Date Added**: 2026-06-29
- **Author**: Lambros Petrou
- **Note**: Vendored from durable-utils' `SQLSchemaMigrations` with modifications: (1) storage access ported from the legacy async API (`doStorage.get/put/transaction`) to Cloudflare's synchronous API (`ctx.storage.kv.get/put` + `ctx.storage.transactionSync`), so `runAll()` is synchronous and callable from a DO constructor body; (2) narrowed public surface — dropped the `sqlGen` callback and `hasMigrationsToRun()`; the last-applied marker key defaults to a fixed name but is overridable via `markerKey` (durable-utils' `keyNameTrackingLastMigrationID`, restored + renamed) so one DO that composes multiple independently-migrated components can give each its own marker; (3) added per-migration `params` for bound (`?`) values. The MIT copyright is retained in the file header.

## typia (Copied — partial)
- **Source**: https://github.com/samchon/typia (tag `v12.0.2`)
- **License**: MIT (https://github.com/samchon/typia/blob/master/LICENSE)
- **Used In**: `packages/ts-runtime-parser-validator/forks/typia/{core,transform,interface,utils}/` — source copied in-tree.
- **Purpose**: `@typia/transform` and its three dependency packages (`@typia/core`, `@typia/interface`, `@typia/utils`). Copied rather than npm-installed so we can add visit-tracking to the generated validators.
- **Date Added**: 2026-04-24
- **Author**: Jeongho Nam
- **Note**: Source copied from the `v12.0.2` tag; compiled in-place via esbuild through `packages/ts-runtime-parser-validator/scripts/bundle-dependencies.mjs`. Wired via local npm workspaces — no submodule, no GitHub fork, no publish. Phase 1 is a behavioral no-op. Modifications (Phase 2 onwards: unconditional visit-tracking with `WeakMap`, re-entry as a no-op) will be documented here. See `tasks/typia-visit-tracking.md` for full context.

## Vue (Vendored — runtime served same-origin)
- **Source**: https://github.com/vuejs/core (npm `vue@3.5.34`)
- **License**: MIT (https://github.com/vuejs/core/blob/main/LICENSE)
- **Used In**: `apps/nebula/vendor/platform-assets.generated.mjs` (the `vue.runtime.esm-browser.prod.js` build, vendored verbatim and served same-origin by `apps/nebula/src/platform-assets.ts`).
- **Purpose**: Self-host the Vue 3.5 **runtime-only** browser build so Studio-generated apps load Vue from their own Star (no CDN), which lets `script-src` tighten to `'self'`. Runtime-only (no template compiler) keeps the served app free of `new Function`, so it runs with no `'unsafe-eval'`.
- **Date Added**: 2026-06-17
- **Author**: Evan You & Vue contributors
- **Note**: Regenerated by `apps/nebula/scripts/vendor-assets.mjs` (`npm run vendor:assets`); the output bundle is committed. Not modified — served byte-for-byte.

## DaisyUI (Vendored — precompiled CSS served same-origin)
- **Source**: https://github.com/saadeghi/daisyui (npm `daisyui@5.5.23`)
- **License**: MIT (https://github.com/saadeghi/daisyui/blob/master/LICENSE)
- **Used In**: `apps/nebula/vendor/platform-assets.generated.mjs` (DaisyUI's precompiled `daisyui.css`, served same-origin by `apps/nebula/src/platform-assets.ts`).
- **Purpose**: Self-host the platform styling layer for Studio-generated apps. DaisyUI v5 ships browser-valid plain CSS (only native `@layer`, no Tailwind `@plugin`/`@apply`), so it is vendored verbatim — no Tailwind compile step.
- **Date Added**: 2026-06-17
- **Author**: Pouya Saadeghi
- **Note**: Regenerated by `apps/nebula/scripts/vendor-assets.mjs`; the output bundle is committed. Not modified. Per-app Tailwind JIT is out of scope (precompiled only).

## Lucide (Vendored — per-icon ESM served same-origin)
- **Source**: https://github.com/lucide-icons/lucide (npm `lucide-vue-next@1.0.0`)
- **License**: ISC (https://github.com/lucide-icons/lucide/blob/main/LICENSE) — portions held by Cole Bemis 2013-2026 as part of Feather (MIT).
- **Used In**: `apps/nebula/vendor/platform-assets.generated.mjs` (every Lucide icon esbuild-bundled to a self-contained ESM, `vue` left external and rewritten to the same-origin runtime; served per-icon by `apps/nebula/src/platform-assets.ts`).
- **Purpose**: Self-host the platform icon set for Studio-generated apps. Each icon is its own `vendor/lucide/<name>.js` so the browser fetches only the icons an app imports.
- **Date Added**: 2026-06-17
- **Author**: Lucide Contributors
- **Note**: Regenerated by `apps/nebula/scripts/vendor-assets.mjs`; the output bundle is committed. Each icon's `import … from 'vue'` is rewritten to a relative `../../vue.js`; the icon node data is otherwise unmodified.

## SimpleMimeMessage (Copied)
- **Source**: `lumenize-monolith/test/simple-mime-message.ts` (internal, same repo)
- **License**: MIT (Lumenize)
- **Used In**: `tooling/email-test/src/simple-mime-message.ts`
- **Purpose**: Simple MIME message builder for constructing test emails in Workers runtime. Used to create synthetic inbound emails for testing the EmailTestDO email parsing pipeline.
- **Date Added**: 2026-02-09
- **Author**: Lumenize
- **Note**: Copied with minor adaptation (TypeScript `private` → `#` prefix for private members, per project conventions).
