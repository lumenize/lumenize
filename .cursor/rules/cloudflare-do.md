# Cloudflare Durable Objects Rules

Critical patterns for working with Cloudflare's Durable Objects to avoid race conditions and data corruption.

## When

When implementing or modifying any Durable Object class or method.

## Then

Follow these synchronous-first patterns to maintain Cloudflare's consistency guarantees.

## Keep DO Methods Synchronous

**Always synchronous** (no `async`/`await`):
- ✅ Regular methods and handlers
- ✅ `onStart()` lifecycle hook (if used)
- ✅ All business logic

**Must be async** (required exceptions):
- ✅ `fetch()` - HTTP request handler
- ✅ `alarm()` - Scheduled task handler
- ✅ `webSocketMessage()`, `webSocketClose()`, `webSocketError()` - WebSocket handlers
- ✅ Code wrapped in `ctx.waitUntil()` - Background work

## Never Use These (Outside `ctx.waitUntil()`)

- ❌ `setTimeout`
- ❌ `setInterval`

## Why

`async` breaks Cloudflare's input/output gate mechanism, which leads to:
- Race conditions between concurrent requests
- Data corruption from overlapping writes
- Inconsistent state across method calls

## Instance Lifecycle

Durable Objects can be evicted from memory at any time. Design accordingly:

**Always:**
- ✅ Fetch from storage at the start of each request/message handler
- ✅ Persist changes to storage before returning from handler
- ✅ Minimize instance variables - only store `this.ctx`, `this.env`, or expensive transformations

**Never:**
- ❌ Don't rely on in-memory state persisting between requests

## Storage APIs

**Always use synchronous storage:**
- ✅ `ctx.storage.kv.*` - Key-value operations
- ✅ `ctx.storage.sql.*` - SQL operations

**Never use legacy async API:**
- ❌ `ctx.storage.put()`
- ❌ `ctx.storage.get()`
- ❌ `ctx.storage.delete()`

Storage operations are synchronous because SQLite is embedded - no async needed, no performance penalty.

## Reference

For comprehensive Durable Objects concepts and patterns, see `CLOUDFLARE_DO_GUIDE.md` at repo root.

