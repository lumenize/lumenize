# Mesh Extensibility — `onRequest` Lifecycle + Gateway Hooks

**Status**: Complete (Phase 1+2+3)
**Package**: `@lumenize/mesh` (MIT)

## Goal

Add extension points to `@lumenize/mesh` so applications built on Mesh can customize HTTP handling and Gateway behavior through subclassing rather than forking. Three implementation phases:

1. **Phase 1: LumenizeDO `onRequest()` hook** — synchronous lifecycle hook for HTTP request handling, following the same pattern as `onBeforeCall` and `onStart`.
2. **Phase 2: LumenizeClientGateway hooks** — three lifecycle hooks (`onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`) plus one overridable property (`gatewayBindingName`).
3. **Phase 3: Documentation** — docs for both features across gateway.mdx, lumenize-do.mdx, mesh-api.mdx, and security.mdx.

Ship as a single Mesh release. Non-breaking (minor semver) — all hooks have default implementations that preserve current behavior.

## Motivation

Any framework built on Mesh that has its own auth system, instance naming convention, or call validation currently has no way to customize `LumenizeClientGateway` — all relevant methods are `#private`. This forces a full fork (~800 lines) even when only a few behaviors differ. Common customization needs include:

- **Instance name format** — apps may use delimiters other than `.` (e.g., `~`, `/`)
- **JWT claims shape** — different auth systems extract different fields
- **CallContext enrichment** — adding app-specific fields before dispatch
- **Call validation** — restricting which DO→client calls are allowed
- **Gateway binding name** — apps with their own Gateway DO need a different binding name

Adding focused hooks eliminates the fork. The Gateway's `#private` methods stay private — they call the hook at the right point, and the subclass only overrides what it needs.

Similarly, `LumenizeDO.fetch()` currently returns 501 with no way for subclasses to handle HTTP requests. Overriding `fetch()` directly would break the lifecycle pattern and remove the base class's ability to wrap behavior. An `onRequest()` hook follows the established pattern (`onBeforeCall`, `onStart`).

---

## Phase 1: LumenizeDO `onRequest()` Hook

### Design

The current `LumenizeDO.fetch()` calls `__initFromHeaders()` (identity initialization from routing headers) then returns 501. The `onRequest` hook slots in between init and the 501 fallback:

```typescript
// In LumenizeDO.fetch()
async fetch(request: Request): Promise<Response> {
  // Identity initialization (existing behavior — preserved)
  const initError = this.__initFromHeaders(request.headers);
  if (initError) return initError;

  // New: delegate to onRequest if subclass implements it
  if (this.onRequest) {
    return this.onRequest(request);
  }
  return new Response('Not Implemented', { status: 501 });
}
```

Declare as an optional **synchronous** method on `LumenizeDO`:

```typescript
// Type declaration (on LumenizeDO class)
onRequest?(request: Request): Response;
```

**Why synchronous**: All LumenizeDO user extension points are synchronous by default — only `onStart` is async (intentionally, wrapped in `blockConcurrencyWhile`). Keeping `onRequest` sync means the base class controls concurrency; subclasses that need async work use continuations to dispatch it to another place or time. This prevents developer-users from accidentally opening input gates with `await` in their HTTP handlers.

Subclasses opt in by implementing `onRequest`:

```typescript
class MyDO extends LumenizeDO {
  onRequest(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return Response.json({ instanceName: this.lmz.instanceName });
    }
    return new Response('Not Found', { status: 404 });
  }
}
```

### Scope

- Add optional `onRequest?` method declaration on `LumenizeDO`
- Modify `LumenizeDO.fetch()` to call `onRequest` after `__initFromHeaders` and before the 501 fallback
- Trim existing JSDoc on `LumenizeDO.fetch()` — brief description + `@see` link to docs

### Validation (test-first loop)

1. **Green baseline** — Run full mesh test suite, confirm all pass
2. **Add edge-case tests first** — Before changing any code:
   - LumenizeDO: `fetch()` returns 501 when no `onRequest` defined
   - LumenizeDO: `fetch()` calls `__initFromHeaders` before anything else (identity available)
3. **Confirm all tests pass** — Full suite including the new edge-case tests
4. **Implement changes** — Add `onRequest` hook + trim JSDoc
5. **Add new-behavior tests**:
   - Subclass with `onRequest` → gets called, returns its response
   - `this.lmz.instanceName` is available inside `onRequest` (proves `__initFromHeaders` ran first)
6. **Confirm all tests pass** — Full suite; all tests validate the new behavior

---

## Phase 2: LumenizeClientGateway Hooks

### Design

Three lifecycle hooks mapped to three lifecycle moments, plus one overridable property:

| Hook | Lifecycle moment | Direction |
|------|-----------------|-----------|
| `onBeforeAccept` | WebSocket upgrade | — (connection) |
| `onBeforeCallToMesh` | Client-initiated call being routed to a DO | client → DO |
| `onBeforeCallToClient` | DO-initiated call being forwarded to the client | DO → client |

#### Hook: `onBeforeAccept(instanceName, sub, jwtPayload)`

Called from `fetch()` during WebSocket upgrade. Merges instance name validation (currently lines 280–301) and claims extraction (currently lines 259–265) into a single connection-time hook.

**Return convention** (matches `routeDORequest` hooks pattern):
- `Response` → reject the WebSocket upgrade (the Response is sent as the HTTP response)
- `Record<string, unknown>` → proceed with these claims stored in the WebSocket attachment
- `void` / `undefined` → proceed with no claims

```typescript
// Base implementation (current behavior)
onBeforeAccept(
  instanceName: string,
  sub: string,
  jwtPayload: Record<string, unknown>
): Response | Record<string, unknown> | undefined {
  // Validate instance name format: {sub}.{tabId}
  const dotIndex = instanceName.indexOf('.');
  if (dotIndex === -1) {
    return new Response('Forbidden: invalid instance name format (expected sub.tabId)', { status: 403 });
  }
  if (instanceName.substring(0, dotIndex) !== sub) {
    return new Response('Forbidden: identity mismatch', { status: 403 });
  }

  // Extract claims
  return {
    emailVerified: jwtPayload.emailVerified,
    adminApproved: jwtPayload.adminApproved,
    ...(jwtPayload.isAdmin ? { isAdmin: jwtPayload.isAdmin } : {}),
    ...(jwtPayload.act ? { act: jwtPayload.act } : {}),
  };
}

// Example subclass (changed behavior — ~-delimited format + custom claims)
onBeforeAccept(
  instanceName: string,
  sub: string,
  jwtPayload: Record<string, unknown>
): Response | Record<string, unknown> | undefined {
  // Validate instance name format: {sub}~{scopeId}~{tabId}
  const segments = instanceName.split('~');
  if (segments.length !== 3) {
    return new Response('Forbidden: invalid instance name format (expected sub~scopeId~tabId)', { status: 403 });
  }
  if (segments[0] !== sub) {
    return new Response('Forbidden: identity mismatch', { status: 403 });
  }

  // Extract app-specific claims
  const access = jwtPayload.access as { id: string; admin?: boolean } | undefined;
  return {
    access,
    ...(access?.admin ? { isAdmin: true } : {}),
    ...(jwtPayload.act ? { act: jwtPayload.act } : {}),
  };
}
```

**Calling code in `fetch()`**: If the result is a `Response`, return it immediately. If it's a `Record`, store it as `claims` in the WebSocket attachment. If `undefined`/`void`, proceed with no claims. Base class still extracts `sub` and `tokenExp` from the JWT before calling the hook — those are protocol-level concerns, not app-level.

#### Hook: `onBeforeCallToMesh(baseContext, connectionInfo)`

Called from `#handleClientCall` after building the base CallContext (currently lines 550–555). Subclass enriches the context before the call is dispatched to a DO. Return the (possibly enriched) CallContext.

The second parameter is `GatewayConnectionInfo` (identity/auth fields only) — not the full internal `WebSocketAttachment`. See [Design Decision](#websocketattachment-narrow-public-type-gatewayconnectioninfo) for rationale.

```typescript
// Base implementation (current behavior — returns unchanged)
onBeforeCallToMesh(
  baseContext: CallContext,
  connectionInfo: GatewayConnectionInfo
): CallContext {
  return baseContext;
}

// Example subclass — adds scopeId from instance name
// Note: scopeId is a top-level field (not in `state`) because CallContext.state
// is mutable — intermediate nodes could strip it. Top-level fields on CallContext
// are immutable by convention, which is correct for zero-trust security data.
onBeforeCallToMesh(
  baseContext: CallContext,
  connectionInfo: GatewayConnectionInfo
): CallContext & { scopeId: string } {
  const scopeId = connectionInfo.instanceName!.split('~')[1];
  return { ...baseContext, scopeId };
}
```

#### Hook: `onBeforeCallToClient(envelope, connectionInfo)`

Called from `__executeOperation` before forwarding a DO-initiated call to the client (currently around line 505). `connectionInfo` carries the connected client's verified identity and claims — use it to compare against the envelope's `callContext`. Subclass validates the call is allowed. Throw to reject. Base is a no-op.

**Error wrapping**: When this hook throws, the calling code in `__executeOperation` must catch the error and return it as `{ $error: preprocess(error) }` for Workers RPC compatibility. This matches the existing error-wrapping pattern already used in `__executeOperation` (see lines 462–463, 480–481, 487–488 in current source).

```typescript
// Base implementation (no-op)
onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  // No validation by default
}

// Example subclass — scope verification for DO→client calls
onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  if (envelope.callContext?.state?.scopeId !== connectionInfo.claims?.scopeId) {
    throw new Error('Scope mismatch on call to client');
  }
}
```

#### Property: `gatewayBindingName`

Used in `verifiedOrigin` and `metadata` (currently hardcoded as `'LUMENIZE_CLIENT_GATEWAY'`).

```typescript
// Base class
protected gatewayBindingName = 'LUMENIZE_CLIENT_GATEWAY';

// Example subclass
protected override gatewayBindingName = 'MY_APP_CLIENT_GATEWAY';
```

**Note on `protected`**: The `#private` prefix rule in CLAUDE.md applies to private members that should not be accessible to subclasses. These hooks and properties are deliberately designed as extension points — they exist specifically for subclass override. Using a `protected`-equivalent pattern (no `#` prefix, documented as subclass API) is correct here.

### Scope

- Add three lifecycle hooks (`onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`) + one property (`gatewayBindingName`) to `LumenizeClientGateway`
- Define and export `GatewayConnectionInfo` type (Option 2 — narrow public type)
- Refactor `#handleClientCall` to use `this.gatewayBindingName` in `verifiedOrigin` (line 535) and `metadata.caller` (line 568)
- Default implementations preserve current behavior (non-breaking)

### Exports and types

- Define and export `GatewayConnectionInfo` from `packages/mesh/src/index.ts` (Option 2 — narrow public type)
- `CallEnvelope` and `CallContext` already exported — no change needed

### Validation (test-first loop)

1. **Green baseline** — Run full mesh test suite (including Phase 1 changes), confirm all pass
2. **Add edge-case tests first** — Before changing any code:
   - Gateway: base class `fetch()` still returns 101 with correct claims in attachment
   - Gateway: base class `#handleClientCall` still builds correct CallContext
   - Gateway: `__executeOperation` still forwards calls and wraps errors
3. **Confirm all tests pass** — Full suite including the new edge-case tests
4. **Implement changes** — Add hooks, property, `GatewayConnectionInfo` type, refactor hardcoded binding name
5. **Add new-behavior tests**:
   - `onBeforeAccept` returns claims → stored in WebSocket attachment
   - `onBeforeAccept` returns `Response` → upgrade rejected with that response
   - `onBeforeAccept` returns `undefined` → proceeds with no claims
   - `onBeforeCallToMesh` enriches context → target DO receives enriched context
   - `onBeforeCallToClient` throws → error returned as `{ $error }` to calling DO
   - `onBeforeCallToClient` no-op (base) → call forwarded normally
   - `gatewayBindingName` override → appears in `verifiedOrigin` and `metadata.caller`
6. **End-to-end composition test** — Subclass overrides all three hooks + binding name, connects a client, sends a call to a DO, receives a DO→client call. Exercises the full lifecycle.
7. **Confirm all tests pass** — Full suite

### Test structure

~~Gateway hook tests need their own vitest project with a `test/wrangler.jsonc` that binds both the base Gateway and a subclass Gateway.~~

**Actual (simpler):** Added `CustomGateway` subclass directly in `test/test-worker-and-dos.ts` and `CUSTOM_GATEWAY` binding in the root `wrangler.jsonc`. No separate vitest project needed — the subclass tests live in `test/lumenize-client-gateway.test.ts` alongside the base class tests. `CustomGateway` doesn't need a SQLite migration entry because `LumenizeClientGateway` extends `DurableObject` directly (zero-storage design).

---

## Phase 3: Documentation

### Primary: `/website/docs/mesh/gateway.mdx` — Gateway extensibility

Currently documents Gateway internals (zero-storage design, connection states, Trust DMZ). Add a new **"Extensibility"** section covering:
- The three hooks and their lifecycle moments (table)
- `gatewayBindingName` property
- `GatewayConnectionInfo` type (the public face of the attachment)
- Example: custom Gateway subclass with all hooks
- How this relates to the Trust DMZ section (hooks customize what the DMZ extracts/validates, but the DMZ itself — verified sources only — is an invariant)

This is the deep doc for all Gateway hooks.

### Primary: `/website/docs/mesh/lumenize-do.mdx` — `onRequest` hook + `onStart` bulk-up

Currently has `onStart` at lines 130-132 (2 sentences, no signature, no example — too thin). Add an **"HTTP Request Handling"** section for `onRequest` with:
- Signature with parameter and return type
- One-paragraph explanation: called after identity initialization, before 501 fallback
- Note on synchronous design: use continuations for async work
- Short example (simple HTTP handler showing `this.lmz.instanceName` is available)
- Note: this is the recommended way to handle HTTP requests (not overriding `fetch()`)

Also bulk up the `onStart` section to match — signature, brief example, what the base class guarantees (`blockConcurrencyWhile`). Both are "LumenizeDO lifecycle hooks" and should have consistent documentation depth. Doing this now to reduce future release churn.

### Secondary: `/website/docs/mesh/mesh-api.mdx` — API reference entries

Add `onRequest` and `onStart` to the API reference list alongside `onBeforeCall`. Just signature + one-liner + link to `lumenize-do.mdx`. These are LumenizeDO-specific (not shared across node types) so a brief reference entry is appropriate.

### Secondary: `/website/docs/mesh/security.mdx` — Brief note on Gateway hooks

The "Integrating Alternative Auth" section (lines 182-205) currently describes the default claims extraction and instance name format. Add a brief note that `onBeforeAccept` allows customizing both — link to `gateway.mdx` extensibility section for details. Also mention how `onBeforeCallToMesh` can enrich context with security-critical immutable fields (top-level, not in `state`).

### JSDoc trimming

- `LumenizeDO.fetch()` — Replace verbose 20-line JSDoc with brief description + `@see` link
- `LumenizeDO.onStart()` — Already thin, no change needed

---

## Architectural Principle: Invariants + Extension Points

Base class methods have a two-layer design:

1. **Invariants** (base class owns, always run): `__initFromHeaders`, call context setup, alarm dispatch, JWT decoding, token expiration checks. These are non-negotiable — they run before and/or after the extension point.
2. **Extension points** (subclass customizes): `onRequest`, `onBeforeCall`, `onBeforeAccept`, etc. These add or replace behavior *at the hook level* but never skip invariants.

The lifecycle hooks exist so that subclasses don't need to override native Cloudflare lifecycle methods (`fetch`, `alarm`, etc.) — which would risk skipping invariants. This is exactly the bug we caught in the original `onRequest` proposal: overriding `fetch()` would skip `__initFromHeaders`.

**Synchronous by default**: LumenizeDO user extension points (`onRequest`, `onBeforeCall`) are synchronous. This lets the base class manage DO concurrency — subclasses can't accidentally open input gates with `await`. The one exception is `onStart`, which is intentionally async but wrapped in `blockConcurrencyWhile`. Subclasses that need async work from a sync hook use continuations.

| Base method (owns invariants) | Extension point (subclass customizes) | Sync/Async |
|------|------|------|
| `LumenizeDO.fetch()` | `onRequest()` | sync |
| `LumenizeDO.alarm()` | `this.svc.alarms.schedule()` | — |
| `LumenizeDO` constructor | `onStart()` | async (in `blockConcurrencyWhile`) |
| `LumenizeDO.__executeOperation` | `onBeforeCall()` | sync |
| `LumenizeClientGateway.fetch()` | `onBeforeAccept()` | sync |
| `LumenizeClientGateway.__executeOperation` | `onBeforeCallToClient()` | sync |
| `LumenizeClientGateway.#handleClientCall` | `onBeforeCallToMesh()` | sync |

Overriding native hooks directly is "at your own risk" — documentation and examples should steer subclasses toward the extension points. There is no way to enforce this at the language level.

**JSDoc implication**: Trim the existing verbose JSDoc on `LumenizeDO.fetch()` (currently 20+ lines describing the `super.fetch()` pattern). Replace with a brief description and `@see` link to the docs. The `super.fetch()` override pattern should not be documented as a recommended approach.

---

## Design Decision (Resolved)

### WebSocketAttachment: narrow public type (`GatewayConnectionInfo`)

**Decision: Option 2** — Define a narrow public type. The internal `WebSocketAttachment` stays private.

```typescript
// Public — exported, used by hooks
export interface GatewayConnectionInfo {
  sub: string;
  instanceName?: string;
  claims?: Record<string, unknown>;
}
```

**Rationale**: `onBeforeCallToMesh` needs the *identity part* of the connection (`sub`, `instanceName`, `claims`), not the *protocol part* (`tokenExp`, `connectedAt`). Keeping protocol fields private means the base class retains freedom to restructure the internal attachment without breaking subclasses. If a subclass genuinely needs `tokenExp`, they can pass it through `claims` in `onBeforeAccept`.

---

## Release

- Single semver bump (minor — all changes are additive)
- Changelog covers both features
- Check off backlog item: `Add onRequest lifecycle hook to Lumenize Mesh`

## What This Enables

- **Custom Gateway behavior** — apps with their own auth systems, naming conventions, or call validation extend `LumenizeClientGateway` (~50 lines) instead of forking it (~800 lines)
- **Clean HTTP handling** — DOs handle HTTP requests through a synchronous lifecycle hook instead of overriding `fetch()`, preserving the base class's ability to wrap behavior and manage concurrency
- **Consistent extension pattern** — `onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`, and `onRequest` all follow the same lifecycle-hook pattern as `onBeforeCall` and `onStart`

---

## Retro (Phase 1+2)

### What went right
- Zero test failures across both phases. Default hook implementations preserved existing behavior exactly, so all 350 baseline tests stayed green.
- Phase 1 (onRequest) landed in one pass: 5 new tests, 350→355 total.
- Phase 2 (Gateway hooks) landed in one pass: 8 new tests, 350→358 total.

### What could improve
- **Context exhaustion mid-implementation.** Phase 2 started in one session, ran out of context after refactoring `fetch()` but before `#handleClientCall` and `__executeOperation`. The continuation session had to re-read all files. Lesson: when refactoring multiple methods in one file, complete and test one method at a time rather than doing partial changes across all methods.
- **Task file overestimated test complexity.** The task file specified a separate vitest project for gateway hook tests, modeled after `test/for-docs/security/`. In practice, adding the `CustomGateway` subclass to the existing `test-worker-and-dos.ts` and tests to the existing `lumenize-client-gateway.test.ts` was simpler and sufficient.
- **Edge-case tests were already covered.** The task file called for adding edge-case tests before implementation. For both phases, the existing test suite already covered these baselines (fetch returns 501, initFromHeaders works, gateway accepts/rejects connections, etc.). Recognizing this early saved time.

### Patterns to reuse
- **Hook default = existing behavior.** When adding lifecycle hooks to an existing class, the default implementation should reproduce the current inline code exactly. This makes the refactoring behavior-preserving, so the entire existing test suite serves as your regression suite with zero changes.
- **Subclass-in-test-worker pattern.** For testing hook overrides, add the subclass to `test-worker-and-dos.ts` + binding in `wrangler.jsonc`. No separate vitest project needed.
- **LumenizeClientGateway subclasses don't need SQLite migrations** — LCG extends `DurableObject` directly with zero storage.
