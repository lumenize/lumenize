---
paths:
  - "packages/**/*.ts"
  - "apps/**/*.ts"
---

# Which Rules Apply — Worker/DO Layer Map

The monorepo has distinct layers of Worker/DO code, and **which conventions apply depends on your layer**. Layer can't be read off a path or a single grep — `packages/mesh` holds both the Mesh surface and raw internals, `fetch` is Mesh-layer yet defines no DO, `testing` drives DOs it doesn't define. So **derive it from the file in front of you** using the rule below; the snapshot afterward is only a convenience.

## Derive your layer (per file — this is the authority)
Look at the file you're editing:

1. **Defines a DO?** `class X extends LumenizeDO` → **Mesh layer**; `class X extends DurableObject` → **raw-DO layer**. (Holds for test-fixture DOs too — a DO in `test/**` follows the same rules as one in `src/`.) Apply [durable-objects.md](durable-objects.md) **plus** the matching comm file ([mesh.md](mesh.md) or [raw-comm.md](raw-comm.md)).
2. **Uses `this.lmz` / `this.svc` but defines no DO?** (a Mesh service/library, e.g. `fetch`) → **Mesh layer**: [mesh.md](mesh.md).
3. **Drives DOs without defining one?** (a harness that wraps user DOs, e.g. `@lumenize/testing`) → follow the comm file for *how* it talks; raw DO RPC → [raw-comm.md](raw-comm.md).
4. **None of the above?** → utility / Worker code; none of the three DO files apply.

**Sub-layer** (only needed to pick framework vs library vs platform) is by location: `packages/mesh` = **framework** (defines the Mesh surface *and* raw internals like the Gateway); `apps/nebula` = **platform** (never raw); any other Mesh-layer package = **library**; any other raw-DO package = **infrastructure**.

⚠️ **Base class / usage beats name.** `nebula-auth` `extends DurableObject` → raw-DO infra despite "nebula." The never-raw rule is about the platform business logic (Galaxy/Star/Universe/Resources), not everything with "nebula" in the path.

## Which rule files apply, by layer

| Layer | [durable-objects.md](durable-objects.md) *write a DO* | [mesh.md](mesh.md) *talk on Mesh* | [raw-comm.md](raw-comm.md) *talk without Mesh* |
|---|:--:|:--:|:--:|
| Utility / Worker | only for any DO it contains | — | only if it does raw DO RPC |
| Raw-DO infrastructure | ✅ | — | ✅ |
| DO-driving tooling | ✅ (its DO fixtures) | — | ✅ |
| Mesh framework (`mesh`) | ✅ | ✅ | ✅ (raw internals) |
| Mesh library (`fetch`) | ✅ | ✅ | — |
| **Nebula platform** | ✅ | ✅ | **❌ never** |

## Snapshot — derive from the rule above if unlisted
Convenience only, not authoritative, and may lag the code:

| Package | Layer |
|---|---|
| `apps/nebula` | Mesh platform (Galaxy, Star, Universe, Resources) |
| `mesh` | Mesh framework — defines the Mesh surface (`LumenizeDO`) *and* raw internals (the Gateway) |
| `fetch` | Mesh library — uses `this.lmz`, defines no DO |
| `auth`, `nebula-auth`, `ts-runtime-parser-validator` | raw-DO infrastructure — `extends DurableObject` |
| `testing` | DO-driving tooling — wraps user DOs, defines none in `src` (`raw-comm.md` applies) |
| `rpc`, `routing` | utility / Worker — DO-adjacent (call DO stubs but define no DO) |
| `debug`, `structured-clone` | utility — no DO involvement |

(`coding-style.md`, `testing.md`, `packaging.md`, `security.md`, `documentation.md` apply by their own paths, independent of this map.)
