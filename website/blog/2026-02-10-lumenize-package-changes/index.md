---
title: "Lumenize Package Changes"
slug: lumenize-package-changes
authors: [larry]
tags: [announcement]
description: "Package renames, deprecations, and new standalone packages in the Lumenize ecosystem."
---

Alongside the [Lumenize Mesh beta announcement](/blog/announcing-lumenize-mesh), we're making several package changes. Here's what moved, what's new, and what to update.

<!-- truncate -->

## Summary

| Package | Change |
|---------|--------|
| `@lumenize/mesh` | **New** (beta) |
| `@lumenize/auth` | **New** (beta) |
| `@lumenize/debug` | **New** as a standalone package (GA) |
| `@lumenize/fetch` | **New** (beta) — mesh plugin for Worker-to-DO communication |
| `@lumenize/utils` | **Renamed** to `@lumenize/routing` — update imports |
| `@lumenize/proxy-fetch` | **Deprecated** — use `@lumenize/mesh` + `@lumenize/fetch` |
| `@lumenize/rpc` | **Deprecated** — use `@lumenize/mesh` for production |

## @lumenize/utils renamed to @lumenize/routing

Over time, everything in `@lumenize/utils` that wasn't routing-related moved to other packages (`@lumenize/testing` got the `Browser` class and WebSocket shim; other utilities found homes elsewhere). What remained was `routeDORequest` and CORS support — purely routing functionality.

The package name now matches its contents.

**To migrate:**
```bash
npm uninstall @lumenize/utils
npm install @lumenize/routing
```

Then update your imports:
```typescript
// Before
import { routeDORequest } from '@lumenize/utils';

// After
import { routeDORequest } from '@lumenize/routing';
```

## @lumenize/rpc deprecated

`@lumenize/rpc` was designed for browser-to-DO RPC over WebSockets, but it had no built-in authentication or access control — fine for testing, risky for production. [Lumenize Mesh](/docs/mesh) takes the good parts of RPC (structured clone serialization, operation chaining) and adds required auth, fine-grained access control, identity propagation, and browser clients as full mesh peers.

**If you use `@lumenize/rpc` for testing:** No change needed. `@lumenize/testing` depends on `@lumenize/rpc` internally and will continue to work.

**If you use `@lumenize/rpc` in production:** Migrate to `@lumenize/mesh`. The [Getting Started Guide](/docs/mesh/getting-started) covers the setup.

## @lumenize/debug — new as a standalone package

`@lumenize/debug` is structured debug logging designed to feed Cloudflare's observability dashboard in a format that lets you query for exactly the log entries you need. It also auto-detects Cloudflare Workers, Node.js, and browser environments — use `debug('namespace')` and it works everywhere. See the [docs](/docs/debug) for details.

## @lumenize/fetch — new

`@lumenize/fetch` is a mesh plugin that offloads external API calls from your DO to a Worker entrypoint — so the fetch runs on CPU billing, not DO wall-clock billing. Fire-and-forget from the DO's perspective: the result arrives via continuation, with an alarm-based guarantee that your handler always sees a response or failure. Only worth the added complexity when your average fetch takes longer than 5 seconds. See the [docs](/docs/fetch) for architecture and failure mode details.

## Questions?

Join us on [Discord](https://discord.gg/tkug8FGfKR) or open an issue on [GitHub](https://github.com/lumenize/lumenize).
