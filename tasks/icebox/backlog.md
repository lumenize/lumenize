# Icebox — Backlog

Small cross-cutting tasks parked indefinitely — colder than `tasks/on-hold/`, no planned return. Blocked on external tooling or speculative. Revisit only if the blocker clears or a concrete need appears.

Moved here 2026-06-15 from `tasks/backlog.md` § "Blocked / Maybe later".

- [ ] Consider always using a transactionSync for every continuation execution. Maybe make it a flag?

- [ ] Do some analysis on this and our current code: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#always-await-rpc-calls

- [ ] Refactor to use `using` keyword for Workers RPC stubs (Explicit Resource Management)
  - Cloudflare added support in Feb 2025: https://developers.cloudflare.com/changelog/2025-02-28-wrangler-v4-rc/#the-using-keyword-from-explicit-resource-management
  - **Why it matters**: Without `using`, stubs held in wall-clock billing mode
  - **Pattern**: `using` is lexically scoped (NOT reference-counted like WeakMap). Disposal happens when the declaring scope exits, regardless of who holds references. Therefore, `using` must be at the **call site**, not inside helper functions that return stubs.
  - **Blocker**: As of Jan 2025, `vitest-pool-workers` (workerd 1.20251011.0) throws "Object not disposable" when using `using` with DO stubs. The runtime doesn't implement `Symbol.dispose` on stubs yet. Wait for vitest-pool-workers/workerd to add support, then:
    1. Search codebase for `getDOStub(` calls and change to `using stub = getDOStub(...)`
    2. Update `getDOStub` JSDoc to recommend callers use `using`
    3. Update unit test mocks to include `[Symbol.dispose]: () => {}`
