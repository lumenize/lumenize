# Cloudflare Durable Objects (DO) Guide

## Overview
Cloudflare Durable Objects are a globally-distributed, strongly-consistent coordination primitive. Understanding how they work is essential to using them correctly.

## Key Concepts

### Instance Model
- **Written as TypeScript classes** but instantiated by Cloudflare's runtime, not your code
- **Each DO ID is globally unique** - even name-derived IDs are unique worldwide
- **One instance per ID** - Cloudflare guarantees only one instance runs at a time globally
- **Geolocation embedded in ID** - Initial location chosen based on jurisdiction hints or proximity to creator

### Terminology
- **"Durable Object" or "DO"** = Durable Object instance (specific instantiation)
- **"DO class"** = The TypeScript class definition
- Be explicit when possible; when in doubt, "DO" means "instance"

### Storage Architecture
Each DO instance has a dedicated SQLite database (up to 10GB) accessible only to that instance.

**Three storage APIs** (use only the synchronous ones):

1. ❌ **Legacy async KV API** - NEVER USE
   - `this.ctx.storage.put()`, `this.ctx.storage.get()`, etc.
   - Deprecated, exists only for migration
   
2. ✅ **Synchronous KV API** - USE THIS
   - `this.ctx.storage.kv.put()`, `this.ctx.storage.kv.get()`, etc.
   - Same methods as legacy API but synchronous
   
3. ✅ **Synchronous SQL API** - USE THIS
   - `this.ctx.storage.sql.exec()`
   - Full SQLite-flavored SQL

### Why Synchronous Storage?
SQLite is embedded in the same process and memory space - no network hop, no context switch. This gives fundamentally different performance characteristics:
- **N+1 queries often just as fast** as joins (sometimes faster)
- **No async overhead** - synchronous code is simpler and safer
- **Automatic transactions** - all operations in a request handler are atomic (unless you `fetch()`, `setTimeout`, or `setInterval`)

## Critical Rules

### ⚠️ CRITICAL: Keep DO Methods Synchronous

**DO methods must be synchronous** (no `async`/`await`) to maintain consistency guarantees.

**Exceptions** (these MUST be async):
- `fetch()` - HTTP request handler
- WebSocket handlers: `webSocketMessage()`, `webSocketClose()`, `webSocketError()`
- `alarm()` - Scheduled handler
- Code wrapped in `ctx.waitUntil()`

**Why**: Using `async` breaks Cloudflare's automatic input/output gate mechanism, leading to:
- Race conditions
- Out-of-order processing
- Data inconsistency

**Also forbidden outside `ctx.waitUntil()`**:
- `setTimeout`
- `setInterval`

These also break input/output gate guarantees.

### Input/Output Gates
When you follow the rules above, DOs have automatic gates that:
- Process requests/messages in order
- Wait for storage operations to persist before processing next request
- Provide transactional semantics within a handler

**Gates work as long as you avoid**:
- `fetch()` (external calls)
- `setTimeout` / `setInterval`
- Unnecessary `async`

## Instance Lifecycle

### Eviction and Reinstantiation
- **DOs can be evicted from memory** at any time (idleness, resource pressure, etc.)
- **Next access reinstantiates** - constructor runs again
- **Storage persists** - SQLite data survives eviction
- **WebSockets can persist** through "hibernation"
- **Storage cache persists** for frequently-accessed data

### Implications for Code

**Instance Variables**:
- ✅ Store constructor parameters: `this.ctx`, `this.env`
- ⚠️ Only cache expensive transformations if absolutely necessary
- ❌ Don't rely on in-memory state persisting

**Request/Message Handlers**:
- ✅ Fetch data from storage at start of handler
- ✅ Persist state changes before returning
- ✅ Treat each handler as potentially the first after reinstantiation

## Programming Model

### Actor Model Similarities
DOs implement a form of the **Actor model** (popularized by Erlang/BEAM):
- Single-threaded execution per instance
- Message-based communication
- State encapsulation

**Key difference**: No supervisory control (unlike Erlang/OTP)

## Best Practices

1. **Always use synchronous storage APIs** (`ctx.storage.kv.*` or `ctx.storage.sql.*`)
2. **Keep business logic synchronous** (no `async` except for specific handlers)
3. **Fetch from storage in handlers**, don't rely on instance variables
4. **Persist before returning** from handlers
5. **Avoid caching** unless transformation is expensive
6. **Embrace N+1 queries** - they're fine with embedded SQLite
7. **Use `ctx.waitUntil()`** for async cleanup/logging that doesn't affect response

