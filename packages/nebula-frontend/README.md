# @lumenize/nebula-frontend

Vue 3 reactive factory for `NebulaClient`. `createNebulaClient(config)` wraps a
`NebulaClient` in a path-aware reactive store with optimistic local writes,
debounced transaction submission, conflict resolution, and effect-scope-tied
auto-subscribe — so a Vue app binds to `store.resources.<type>[<id>].value.<field>`
and the framework handles the wire protocol.

> **UNLICENSED** — proprietary; part of the Nebula SaaS platform until external launch.

For complete documentation, see the Nebula docs:

- [Coding your UI](https://lumenize.com/docs/nebula/coding-your-ui)
- [API reference](https://lumenize.com/docs/nebula/api-reference)

## Install

```bash
npm install @lumenize/nebula-frontend vue@^3.5
```

## Status

Phase 5.3.7-v3 (factory port) — see `tasks/nebula-frontend.md`. The package is
scaffolded; the factory, debounce queue, conflict-outcome engine, `textMerge`,
and `NebulaClient` are ported in over the v3 phases.
