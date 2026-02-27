# Mesh Extensibility — Gateway Hooks + `onRequest` Lifecycle

**Status**: Pending
**Package**: `@lumenize/mesh` (MIT)
**Depends on**: None (pure Mesh work)

## Goal

Add extension points to `@lumenize/mesh` so applications built on Mesh can customize Gateway behavior and HTTP handling through subclassing rather than forking. Two deliverables:

1. **LumenizeClientGateway hooks** — three lifecycle hooks (`onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`) plus one overridable property (`gatewayBindingName`).
2. **LumenizeDO `onRequest()` hook** — lifecycle hook for HTTP request handling, following the same pattern as `onBeforeCall` and `onStart`, modeled after Cloudflare's agents SDK.

Human will ship as a single Mesh release. Non-breaking (minor semver) — all hooks have default implementations that preserve current behavior.

## Motivation

Any framework built on Mesh that has its own auth system, instance naming convention, or call validation currently has no way to customize `LumenizeClientGateway` — all relevant methods are `#private`. This forces a full fork (~800 lines) even when only a few behaviors differ. Common customization needs include:

- **Instance name format** — apps may use delimiters other than `.` (e.g., `~`, `/`)
- **JWT claims shape** — different auth systems extract different fields
- **CallContext enrichment** — adding app-specific fields before dispatch
- **Call validation** — restricting which DO→client calls are allowed
- **Gateway binding name** — apps with their own Gateway DO need a different binding name

Adding focused hooks eliminates the fork. The Gateway's `#private` methods stay private — they call the hook at the right point, and the subclass only overrides what it needs.

Similarly, `LumenizeDO.fetch()` currently returns 501 with no way for subclasses to handle HTTP requests. Overriding `fetch()` directly would break the lifecycle pattern and remove the base class's ability to wrap behavior. An `onRequest()` hook follows the established pattern (`onBeforeCall`, `onStart`).

## Part 1: LumenizeClientGateway Hooks

Three lifecycle hooks mapped to three lifecycle moments, plus one overridable property:

| Hook | Lifecycle moment | Direction |
|------|-----------------|-----------|
| `onBeforeAccept` | WebSocket upgrade | — (connection) |
| `onBeforeCallToMesh` | Client-initiated call being routed to a DO | client → DO |
| `onBeforeCallToClient` | DO-initiated call being forwarded to the client | DO → client |

### Hook: `onBeforeAccept(instanceName, sub, jwtPayload)`

Called from `fetch()` during WebSocket upgrade. Merges instance name validation (currently lines 280–301) and claims extraction (currently lines 259–265) into a single connection-time hook. Validates whatever it needs (throw to reject), returns claims for the WebSocket attachment.

```typescript
// Base implementation (current behavior)
onBeforeAccept(
  instanceName: string,
  sub: string,
  jwtPayload: Record<string, unknown>
): Record<string, unknown> | undefined {
  // Validate instance name format: {sub}.{tabId}
  const dotIndex = instanceName.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid instance name format (expected sub.tabId)');
  }
  if (instanceName.substring(0, dotIndex) !== sub) {
    throw new Error('Identity mismatch: sub does not match instance name');
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
): Record<string, unknown> | undefined {
  // Validate instance name format: {sub}~{scopeId}~{tabId}
  const segments = instanceName.split('~');
  if (segments.length !== 3) {
    throw new Error('Invalid instance name format (expected sub~scopeId~tabId)');
  }
  if (segments[0] !== sub) {
    throw new Error('Identity mismatch: sub does not match instance name');
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

### Hook: `onBeforeCallToMesh(baseContext, attachment)`

Called from `#handleClientCall` after building the base CallContext (currently lines 550–555). Subclass enriches the context before the call is dispatched to a DO. Return the (possibly enriched) CallContext.

```typescript
// Base implementation (current behavior — returns unchanged)
onBeforeCallToMesh(
  baseContext: CallContext,
  attachment: WebSocketAttachment
): CallContext {
  return baseContext;
}

// Example subclass — adds scopeId from instance name
onBeforeCallToMesh(
  baseContext: CallContext,
  attachment: WebSocketAttachment
): CallContext & { scopeId: string } {
  const scopeId = attachment.instanceName!.split('~')[1];
  return { ...baseContext, scopeId };
}
```

### Hook: `onBeforeCallToClient(envelope)`

Called from `__executeOperation` before forwarding a DO-initiated call to the client (currently around line 505). Subclass validates the call is allowed. Throw to reject. Base is a no-op.

```typescript
// Base implementation (no-op)
onBeforeCallToClient(envelope: CallEnvelope): void {
  // No validation by default
}

// Example subclass — scope verification for DO→client calls
onBeforeCallToClient(envelope: CallEnvelope): void {
  const incomingScopeId = (envelope.callContext as any).scopeId;
  const myScopeId = this.#getMyScopeId(); // parsed from own instanceName
  if (incomingScopeId !== myScopeId) {
    throw new Error('Scope mismatch on call to client');
  }
}
```

### Property: `gatewayBindingName`

Used in `verifiedOrigin` and `metadata` (currently hardcoded as `'LUMENIZE_CLIENT_GATEWAY'`).

```typescript
// Base class
protected gatewayBindingName = 'LUMENIZE_CLIENT_GATEWAY';

// Example subclass
protected override gatewayBindingName = 'MY_APP_CLIENT_GATEWAY';
```

**Note on `protected`**: The `#private` prefix rule in CLAUDE.md applies to private members that should not be accessible to subclasses. These hooks and properties are deliberately designed as extension points — they exist specifically for subclass override. Using a `protected`-equivalent pattern (no `#` prefix, documented as subclass API) is correct here.

### WebSocketAttachment Type Decision Needed

The `WebSocketAttachment` interface is currently file-private. Hooks like `onBeforeCallToMesh` receive it as a parameter. Options:

1. Export the type as-is (subclasses can read `instanceName`, `sub`, `claims`, etc.)
2. Pass only the fields the hook needs

Prefer option 1 but should revisit and discuss — the type is simple and stable, and subclasses may need different fields. Export it from the package.

## Part 2: LumenizeDO `onRequest()` Hook

```typescript
// In LumenizeDO.fetch()
async fetch(request: Request): Promise<Response> {
  if (typeof this.onRequest === 'function') {
    return this.onRequest(request);
  }
  return new Response('Not Implemented', { status: 501 });
}
```

Subclasses opt in by implementing `onRequest`:

```typescript
class MyDO extends LumenizeDO {
  onRequest(request: Request): Response | Promise<Response> {
    return new Response('OK');
  }
}
```

## Scope

### Gateway hooks
- Add three lifecycle hooks (`onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`) + one property (`gatewayBindingName`) to `LumenizeClientGateway`
- Export `WebSocketAttachment` type
- Default implementations preserve current behavior (non-breaking)
- Tests: base class behavior unchanged; subclass with overrides works correctly
- Mesh docs update (`/website/docs/mesh/gateway.mdx`)

### `onRequest` hook
- Add `onRequest()` hook to `LumenizeDO.fetch()`
- Type declaration for `onRequest` (optional method on `LumenizeDO`)
- Tests: subclass with `onRequest` gets called; subclass without it gets 501
- Mesh docs update (not sure where is best - discuss)

### Release
- Single semver bump (minor — all changes are additive)
- Changelog covers both features

## What This Enables

- **Custom Gateway behavior** — apps with their own auth systems, naming conventions, or call validation extend `LumenizeClientGateway` (~50 lines) instead of forking it (~800 lines)
- **Clean HTTP handling** — DOs handle HTTP requests through a lifecycle hook instead of overriding `fetch()`, preserving the base class's ability to wrap behavior
- **Consistent extension pattern** — `onBeforeAccept`, `onBeforeCallToMesh`, `onBeforeCallToClient`, and `onRequest` all follow the same lifecycle-hook pattern as `onBeforeCall` and `onStart`
