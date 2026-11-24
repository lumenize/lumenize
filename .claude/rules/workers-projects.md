---
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

# Which Rules Apply — Worker/DO Layer Map

The monorepo has distinct layers of Worker/DO code, and **which conventions apply depends on your layer**. Layer can't be read off a path or a single grep — `packages/mesh` holds both the Mesh surface and raw internals, `fetch` is Mesh-layer yet defines no DO, `testing` drives DOs it doesn't define. So you MUST **derive it from the file in front of you** using the rule below; the snapshot afterward is only a convenience.

## Derive your layer (per file — this is the authority)
Look at the file you're editing:

1. **Defines a DO?** `class X extends ScopedMeshDO` or `UnscopedMeshDO` → **Mesh layer**; `class X extends DurableObject` → **raw-DO layer**. (Holds for test-fixture DOs too — a DO in `test/**` follows the same rules as one in `src/`.) You MUST apply [durable-objects.md](durable-objects.md) **plus** the matching comm file ([mesh.md](mesh.md) or [raw-comm.md](raw-comm.md)). **A DO that drives an attached Container** MUST do so via **raw `ctx.container`** and MUST NOT `extends Container` (that base is optional and being retired; a plain `ScopedMeshDO` + raw `ctx.container` is the path, and it restores vitest-plugin testability). It stays **Mesh layer**, and you MUST *additionally* apply [containers.md](containers.md) for the container lifecycle/state-machine concerns the plain-DO rules don't cover.
2. **Uses `this.lmz` / `this.svc` but defines no DO?** (a Mesh service/library, e.g. `fetch`) → **Mesh layer**: [mesh.md](mesh.md).
3. **Drives DOs without defining one?** (a harness that wraps user DOs, e.g. `@lumenize/testing`) → follow the comm file for *how* it talks; raw DO RPC → [raw-comm.md](raw-comm.md).
4. **None of the above?** → utility / Worker code; none of the three DO files apply.

**Sub-layer** (only needed to pick framework vs library vs platform) is by location: `packages/mesh` = **framework** (defines the Mesh surface *and* raw internals like `ClientGateway`); `apps/nebula` = **platform** (never raw); any other Mesh-layer package = **library**; any other raw-DO package = **infrastructure**.

⚠️ **Base class / usage beats location.** Mesh's auth layer, `packages/mesh/src/auth`, holds raw-DO infrastructure inside the Mesh package: its Registry `extends DurableObject`. The never-raw rule is about the platform's business logic (Galaxy, Star, Universe, Resources), not everything under a Mesh path.

## Which rule files apply, by layer

| Layer | [durable-objects.md](durable-objects.md) *write a DO* | [mesh.md](mesh.md) *talk on Mesh* | [raw-comm.md](raw-comm.md) *talk without Mesh* |
|---|:--:|:--:|:--:|
| Utility / Worker | only for any DO it contains | — | only if it does raw DO RPC |
| Raw-DO infrastructure | ✅ | — | ✅ |
| DO-driving tooling | ✅ (its DO fixtures) | — | ✅ |
| Mesh framework (`mesh`) | ✅ | ✅ | ✅ (raw internals) |
| Mesh library (`fetch`, `resources`) | ✅ | ✅ | — |
| **Nebula platform** | ✅ | ✅ | **❌ never** for its nodes; its Worker's forwards follow § *What reaches a Durable Object's `fetch`* |

## Snapshot — derive from the rule above if unlisted
Convenience only, not authoritative, and may lag the code:

| Package | Layer |
|---|---|
| `apps/nebula` | Mesh platform (Galaxy, Star, Universe, Resources), whose nodes extend `ScopedMeshDO`, which composes `ClientGateway` so every scope's node hosts the Clients on its pages — its business logic reaches a node only over the mesh or through a `@rawRpc()`-decorated method, and its Worker reaches a Durable Object's `fetch` only through the forwards `npm run audit:do-http` lists ([raw-comm.md](raw-comm.md)). Galaxy is a plain `ScopedMeshDO` that drives a container via raw `ctx.container` → also [containers.md](containers.md) |
| `mesh` | Mesh framework — defines the Mesh surface (`ScopedMeshDO`, `UnscopedMeshDO`, `MeshWorker`, `MeshClient`) *and* raw internals: `ClientGateway`, a Client's server-side half, which a scoped node composes. Driving a container is raw `ctx.container` on any DO — no base class → [containers.md](containers.md). Its `src/auth/` layer is dual-layer, derived per file: the Registry and its router are raw-DO infrastructure, while `/auth/profile` (`Profile`, an `UnscopedMeshDO`) and `/auth/facade` (`AuthFacade`, a `MeshWorker`) are Mesh layer, and `worker-token.ts` reaches the `Profile` through `rawRpcStub` → those files also follow [mesh.md](mesh.md) |
| `resources` | Mesh library — the Resources plane a host node composes, and `ClientResources`, the half a `NebulaClient` composes; defines no DO in `src` |
| `fetch` | Mesh library — uses `this.lmz`, defines no DO |
| `auth`, `ts-runtime-parser-validator` | raw-DO infrastructure — `extends DurableObject` |
| `testing` | DO-driving tooling — wraps user DOs, defines none in `src` (`raw-comm.md` applies) |
| `rpc`, `routing` | utility / Worker — DO-adjacent (call DO stubs but define no DO) |
| `debug`, `structured-clone` | utility — no DO involvement |

(`coding-style.md`, `testing.md`, `packaging.md`, `security.md`, `documentation.md` apply by their own paths, independent of this map.)
