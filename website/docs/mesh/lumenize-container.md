---
title: LumenizeContainer
description: A Cloudflare Container that is also a first-class mesh node
---

# LumenizeContainer

`LumenizeContainer` is the base class for a mesh node whose **reason for existing is running a container** — it extends [`@cloudflare/containers`](https://github.com/cloudflare/containers)' `Container` and composes the mesh comms + guards core on top, so it can both run a container *and* participate in the mesh as a full peer.

It is **niche** — reach for it only when a node genuinely needs a container (e.g. running a real toolchain in-process). For everything else, use [`LumenizeDO`](./lumenize-do), [`LumenizeWorker`](./lumenize-worker), or [`LumenizeClient`](./lumenize-client).

Exported from a **separate entry point** so the core package stays container-free:

```typescript @skip-check
import { LumenizeContainer } from '@lumenize/mesh/container';
```

## Mesh API

`LumenizeContainer` shares the standard [Mesh API](./mesh-api) with all node types — `this.lmz` for identity and calls, `@mesh()` for entry points, `onBeforeCall()` for access control, and `this.ctn<T>()` for continuations. The core is **composed, not reimplemented** ([ADR-007](https://github.com/lumenize/lumenize/blob/main/docs/adr/007-shared-node-security-core.md)): it uses the same receive path as `LumenizeDO`. Identity persists in the container DO's storage, so register the class with `new_sqlite_classes`.

```typescript @skip-check-approved('conceptual')
class MyContainer extends LumenizeContainer<Env> {
  defaultPort = 5173; // the public preview port (see fetch() below)

  @mesh()
  doWork(input: string): string {
    // a normal mesh method — guarded by onBeforeCall + @mesh
    return `handled: ${input}`;
  }
}
```

## What the `Container` base owns (and the core does *not* touch)

Unlike `LumenizeDO`, a container node does **not** get `alarms` or `onStart` from Lumenize — its `Container` base owns its own `alarm()`/`onStart()` lifecycle (and the `container_schedules` table + alarm slot). Schedule via `Container.schedule()` if you ever need it; never `this.svc.alarms`. The container node also contributes **no constructor body** — identity composes lazily on the first inbound mesh call, after the base lifecycle is up.

## Two surfaces: `fetch()` (public) vs. the mesh (guarded)

`onBeforeCall` guards the **mesh** path only — it does **not** cover the container's HTTP `fetch()`. That is by design:

- **`fetch()`** is the node's **public** surface (e.g. proxying a preview server). `LumenizeContainer` overrides it to pin the public port (`defaultPort`) and strip the inbound `cf-container-target-port` header, so a public request can never be redirected to an internal port. Serve only public content here.
- **Everything sensitive** — data, internal command channels — goes **over the mesh** (`lmz.call`, `onBeforeCall`-gated), never the public `fetch()`.

## Egress is off by default

`Container` defaults `enableInternet` to `true` (open outbound). `LumenizeContainer` pins it to **`false`** — a safe default for a node that may run untrusted or third-party code. Open it deliberately, via an explicit `allowedHosts` allow-list or an outbound choke point.

## API Reference

See [Mesh API](./mesh-api) for the shared `this.lmz` / `@mesh()` / `onBeforeCall()` / `ctn<T>()` surface.
