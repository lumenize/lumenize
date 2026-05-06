# `@lumenize/ui` — UI Framework Package

**Status**: Active — critical path for the demo
**License**: MIT (standalone, dual-licensed-friendly)
**Source material**: JurisJS — port the reactive subset, drop framework-integration glue
**Depends on**: Phase 5.3 (single-resource subscriptions), Phase 7 (NebulaClient subscribe wrappers)

## Goal

A UI framework package for Lumenize Mesh applications and (especially) Nebula Studio's generated UIs. The defining feature: **a synced piece of state and a local piece of state look the same** in component code, differing only by config or naming. Subscribe wired straight into the framework so generated apps don't have to think about it.

## Must-keep (decision pinned)

These are the JurisJS primitives we definitely want; everything else is on the table during the inventory.

- **`getState()` / `setState()`** — the imperative state primitives.
- **The "object DOM" / template pattern** where:
  - A function-valued slot is **reactive** — re-evaluated when its dependencies change.
  - A value-valued slot is **evaluated once** at render time.
  - This is the central ergonomic that makes synced and local state interchangeable in component code.

## On the cutting room floor

- **Registration / integration glue for non-JurisJS frameworks** (React, Svelte, Vue, etc.). Nebula doesn't need them and we don't want to maintain them.

## Pre-port inventory (spike — to fill in)

Before the port begins, do a 1-day inventory of JurisJS:

- Surface area pass: catalogue every public API in JurisJS.
- For each, classify as one of:
  - **Definitely keeping** — required by the must-keep primitives or by the subscribe-as-state pattern.
  - **Definitely cutting** — framework integrations, registration glue, anything not used by Nebula or by the must-keep set.
  - **Keep just in case** — small, low-cost-to-carry, plausibly useful in the next year for Nebula Studio's generated UIs.
- For each "definitely keeping" item, note dependencies — what other JurisJS internals come along by transitive necessity?
- For each "keep just in case," estimate weight (lines of code, dependency count) so we can revisit if it grows.

Output: a pinned list (committed back to this file) that becomes the port's scope of work.

## Subscribe wiring (the headline integration)

- A piece of state created via `setState` with a `subscribe` config (or `name`-based convention — TBD) wires up automatically to a NebulaClient subscription on the named resource.
- Reads (`getState`) return the latest known value. Writes (`setState`) optimistically update locally, then push via NebulaClient, then reconcile on the server's eTag-confirmed snapshot.
- BroadcastChannel semantics from Phase 5.3 (own messages not echoed) flow through to the UI naturally.

## Avoiding UI Flicker on Resource Updates

Lumenize Mesh returns a full `Snapshot<T>` (with `value` and `meta`) on every read and subscribe — the framework performs no conditional checking on the read/subscribe path. `meta.eTag` is included so callers can use it for subsequent upserts, but reads always return the full snapshot.

The UI layer is responsible for avoiding unnecessary re-renders when the incoming value hasn't actually changed. Two approaches:

1. **Local eTag comparison** — compare `snapshot.meta.eTag` against the last-seen eTag before updating the DOM. If they match, skip the update.
2. **Deep object change detection** — compare `snapshot.value` against the current value before updating.

Either prevents flicker when a subscribe handler fires but the value is unchanged (e.g., after reconnection replay).

## Out of scope (for v1)

- React/Svelte/Vue interop layers.
- Server-side rendering.
- Anything that requires a build step for the generated UIs (Studio outputs HTML+JS, not TSX).

## Notes

- Standalone `@lumenize/ui` package, MIT-licensed. Lives in the Lumenize monorepo alongside the other MIT packages.
- Auto-refresh-on-version-change is a Studio concern (`tasks/nebula-studio.md`), but `@lumenize/ui` will need a hook for it — defer the surface design until the Studio preview mechanism is sketched.
