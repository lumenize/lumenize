# Lumenize Nebula

**License**: BSL 1.1
**Package**: `@lumenize/nebula` in the Lumenize monorepo
**Built on**: `@lumenize/mesh` (MIT) — extends its classes, doesn't fork them

## What Nebula Is

Lumenize Nebula is a SaaS vibe coding deployment platform. No server-side coding. Users interact through APIs and a tightly-coupled UI framework where local state management looks exactly the same as remote state management with just slightly different config. All user-provided server-side logic (guards, migrations, validation) runs in sandboxed Cloudflare Dynamic Worker Loader (DWL) isolates.

## Package Architecture

```
@lumenize/mesh (MIT)              @lumenize/nebula (BSL 1.1)
┌─────────────────────┐           ┌─────────────────────────┐
│ LumenizeDO          │──────────▶│ NebulaDO                │
│ LumenizeWorker      │──────────▶│ NebulaWorker            │
│ LumenizeClient      │──────────▶│ NebulaClient            │
│ LumenizeClientGateway│─ as-is ─▶│ (used directly)         │
└─────────────────────┘           │ ResourcesWorker (DWL)   │
                                  │ + Resources engine       │
@lumenize/auth (MIT)              │ + Schema evolution       │
┌─────────────────────┐           │ + DWL stub management    │
│ Auth utilities       │──fork?──▶│ + universe.galaxy.star   │
└─────────────────────┘           └─────────────────────────┘
                                        or
                                  @lumenize/nebula-auth (BSL 1.1)
```

**Extends, not forks**: Nebula classes extend Lumenize Mesh classes (`NebulaDO extends LumenizeDO`). This is the same pattern any Mesh user would follow to build their product. Nebula is just a product built on Mesh.

**Auth**: Either fork `@lumenize/auth` into `@lumenize/nebula` or keep it separate as `@lumenize/nebula-auth`. Decision depends on how much divergence the `universe.galaxy.star` model and multi-email support require. See `tasks/nebula-auth.md`.

## Core Capabilities

### 1. Resources (DWL Architecture)
**Task file**: `tasks/nebula-resources.md`

Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, validation, schema evolution, and migrations. User-provided code runs in DWL isolates. The DO calls OUT to DWL for guards/config/validation (inverted architecture). All DWL spikes complete and validated.

### 2. Auth (`universe.galaxy.star`)
**Task file**: `tasks/nebula-auth.md`
**Status**: Building first — impacts access control for resources

Multi-tenant auth with `universe.galaxy.star` (starId) hierarchy. Person → EmailAddress → Organization mapping. JWT claims carry starId list. `onBeforeConnect`/`onBeforeRequest` validate starId against JWT and URL. NebulaDO/NebulaWorker/NebulaClient override `callContext` and `call()` to enforce starId boundaries.

### 3. Schema Evolution
Built into the resources system. User-provided migration functions in DWL. TypeScript types are the schema — no DSL. Versioned alongside resource config. Lazy read-time migration with write-back.

### 4. Runtime Type Validation (Experiment)
Run `tsgo` (or Rust-based TS compiler) in a Cloudflare Container. `@lumenize/structured-clone` gains `toLiteralString()` mode. TypeScript itself validates values against type definitions — no schema DSL duplication.

### 5. UI Framework (Future)
Tightly coupled to the resources implementation. Local state management mirrors remote state management with minimal config difference. Client-side LLM-generated code only.

## Build Order

1. **`nebula-auth`** — auth and access control foundation (starId, multi-email, role hierarchy)
2. **`nebula-resources`** — temporal storage, guards, subscriptions, DWL integration, schema evolution
3. **UI framework** — client-side state management mirroring resources API

## Key Technical Decisions (from nebula-resources.md)

- **Inverted DWL architecture**: DO calls OUT to DWL, not reverse. DWL is callback provider.
- **`ResourcesWorker`**: DWL base class extending `LumenizeWorker`. Vibe coders extend this.
- **`lmz.call(stub, continuation)`**: New overload for DWL addressing. Mesh callContext propagates.
- **`transaction()` API**: Mixed upserts/deletes in single atomic batch. Double eTag check protocol.
- **TypeScript types as schema**: No Zod, TypeBox, or JSON Schema. `.d.ts` is the source of truth.

## Scratchpad

- universe.galaxy.star auth and access control model
- The OrgTree DAG is the heart of each star. Everything hangs off of it.
- Richard Snodgrass style temporal data model with permanent history (like the original npm `lumenize` package assumed and the Rally Lookback API implemented)
  - The star DO will keep the most recent copy of every entity and a small cache of history "snapshots". Snapshots other than the latest are lazily copied to a DO just for that entity which can grow indefinitely
  - Old school npm package `lumenize` aggregations
    - There might be a huge
