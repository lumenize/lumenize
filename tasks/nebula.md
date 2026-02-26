# Lumenize Nebula

**License**: BSL 1.1
**Package**: `@lumenize/nebula` in the Lumenize monorepo
**Built on**: `@lumenize/mesh` (MIT) — extends its classes, doesn't fork them

## What Nebula Is — Walled Garden, Not a Toolkit

Lumenize Nebula is a SaaS vibe coding deployment product built on Lumenize Mesh.

Lumenize Mesh is a flexible open-source toolkit: developers extend LumenizeDO, wire up their own routing, swap in their own auth, choose their own UI framework. Nebula is the opposite — it's a **product, not a toolkit**. The vibe coder never touches the back end. They provide an ontology (data model) and Nebula does everything else: auth, routing, storage, real-time sync, access control. On the client side, they use NebulaClient and NebulaUI (derived from JurisJS) — no React, no Svelte, no choice. User-provided server-side logic (guards, migrations, validation) runs in sandboxed Cloudflare Dynamic Worker Loader (DWL) isolates. Data extraction integrations get clear REST endpoints but nothing more.

**This matters for design decisions.** When writing Nebula task files, don't offer escape hatches, configuration alternatives, or "the developer can do X instead." If there's one right way, that's the only way. Guard against footguns by removing the footgun, not by documenting it.

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

**Auth**: Either fork `@lumenize/auth` into `@lumenize/nebula` or keep it separate as `@lumenize/nebula-auth`. Decision depends on how much divergence the `universe.galaxy.star` model and multi-email support require. See `tasks/archive/nebula-auth.md`.

## Core Capabilities

### 1. Resources (DWL Architecture)
**Task file**: `tasks/nebula-resources.md`

Temporal storage (Snodgrass-style) with subscriptions, fanout, guards, validation, schema evolution, and migrations. User-provided code runs in DWL isolates. The DO calls OUT to DWL for guards/config/validation (inverted architecture). All DWL spikes complete and validated.

### 2. Auth (`universe.galaxy.star`)
**Task file**: `tasks/archive/nebula-auth.md` | **Client login flow**: `tasks/nebula-client.md`
**Status**: Building first — impacts access control for resources

Multi-tenant auth with `universe.galaxy.star` (starId) hierarchy. Person → EmailAddress → Organization mapping. JWT claims carry starId list. `onBeforeConnect`/`onBeforeRequest` validate starId against JWT and URL. NebulaDO/NebulaWorker/NebulaClient override `callContext` and `call()` to enforce starId boundaries.

### 3. Schema Evolution
Built into the resources system. User-provided migration functions in DWL. TypeScript types are the schema — no DSL. Versioned alongside resource config. Lazy read-time migration with write-back.

### 4. Runtime Type Validation (Experiment)
Run `tsgo` (or Rust-based TS compiler) in a Cloudflare Container. `@lumenize/structured-clone` gains `toLiteralString()` mode. TypeScript itself validates values against type definitions — no schema DSL duplication.

### 5. UI Framework (Future)
Tightly coupled to the resources implementation. Local state management mirrors remote state management with minimal config difference. Client-side LLM-generated code only.

### Cloudflare Sandbox SDK (To Be Evaluated)

Cloudflare announced a [Sandbox SDK](https://developers.cloudflare.com/sandbox/) for running untrusted code in isolated environments. This may be relevant as an alternative or complement to DWL for executing user-provided guards, migrations, and validation logic. Needs research to understand how it compares to DWL isolates (which we've already spiked) and Containers (used for the tsgo experiment). Key questions: Does it offer better isolation guarantees? Is it simpler to manage than DWL stubs? Does it support the inverted architecture (DO calls out to sandbox)? What are the latency and billing characteristics?

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

## Follow-On from nebula-auth

Items deferred from `tasks/archive/nebula-auth.md` — to be addressed when building Nebula proper.

### `callContext` Upgrade

The `starId` will be in the `instanceName` property of `callContext.callChain[0]` if the call originated from a Client. However, you can create a new callChain with `{ newCallChain: true }` and calls might originate from a non-Client, like in an alarm handler, so we need another immutable property in callContext for `starId` that is available in all three node mesh types. A particular mesh DO will keep it in storage and will only ever be part of one `starId`. Same thing for Client/Gateway but it's kept in the WebSocket attachment instead of DO storage. For Workers, the `starId` will come from the caller, and outgoing calls will have to propagate that.

My first thought on how to accomplish this is with NebulaDO, NebulaWorker, NebulaClient, and NebulaClientGateway classes that extend the Lumenize* equivalents and override the default onBeforeCall, callContext, and maybe even call itself so only calls within the same `starId` will be allowed. Remember, users won't be extending these and deploying them.

### Email Domain Auto-Approval

An admin can configure email domains (e.g., `acme-corp.com`) that are automatically approved — any user who logs in with a matching email gets `adminApproved: true` without manual admin action. This removes the approval step for organizations where email ownership is sufficient proof of membership.

**Design notes:**
- A disallow list prevents adding common public email domains (gmail.com, yahoo.com, outlook.com, etc.)
- No burdensome domain verification (DNS TXT record, etc.) is required. The admin is opening access to their own instance — they are only potentially hurting themselves, so we can trust them until there's a problem.
- Stored in the DO instance's SQLite: an `AutoApprovedDomains` table with `domain TEXT PK` and `createdAt INTEGER`
- The magic link login flow checks auto-approved domains after verifying the email, before the admin approval gate
- Multiple instances can independently list the same domain — each DO is self-contained, so `acme.crm.tenant-a` and `bigco.hr.tenant-b` can both auto-approve `example.com` without conflict

### Email Template Customization

Universe, galaxy, and star admins will need to customize the name and logo shown in auth emails (magic link, invite). Initial implementation ships with Nebula default branding. Customization requires storing per-instance branding config (name, logo URL) in the `NebulaAuth` DO's SQLite and injecting it into email templates at render time. The branding config could cascade: star inherits from galaxy, galaxy from universe, with overrides at each level.

### Billing Infrastructure

Usage tracking per `galaxy.star`, monthly report generation, Universe-level billing formulas via DWL/webhooks.

---

## Scratchpad

- universe.galaxy.star auth and access control model
- The OrgTree DAG is the heart of each star. Everything hangs off of it.
- Richard Snodgrass style temporal data model with permanent history (like the original npm `lumenize` package assumed and the Rally Lookback API implemented)
  - The star DO will keep the most recent copy of every entity and a small cache of history "snapshots". Snapshots other than the latest are lazily copied to a DO just for that entity which can grow indefinitely
  - Old school npm package `lumenize` aggregations
    - There might be a huge
