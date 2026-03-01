# Nebula Mesh Gateway Fix

**Phase**: 1.7
**Status**: Pending
**Packages**: `@lumenize/mesh`, `@lumenize/nebula-auth`
**Depends on**: Phase 1.5 (Mesh Extensibility)
**Master task file**: `tasks/nebula.md`
**Branch**: `feat/nebula-baseline-access-control` (no mesh release until Nebula deploys)

## Goal

Fix `LumenizeClientGateway` to read its binding name from the routing header (like every other DO) instead of a hardcoded property, unify `WebSocketAttachment` into the public `GatewayConnectionInfo` type, and auto-include all JWT claims so subclasses only need to return additional claims. Also change `routeNebulaAuthRequest` to follow the fallthrough pattern (`undefined` for non-matching paths).

## LumenizeClientGateway Fix (in `packages/mesh/src/lumenize-client-gateway.ts`)

**Bug:** `LumenizeClientGateway` hardcodes `protected gatewayBindingName = 'LUMENIZE_CLIENT_GATEWAY'` and uses it for `verifiedOrigin` and `metadata.caller` in envelopes. Every other DO behind `routeDORequest` reads its binding name from the `x-lumenize-do-binding-name` header — the Gateway should too. The hardcoded property means subclasses (like `NebulaClientGateway`) would need to override it, which is unnecessary indirection.

**Hibernation constraint:** DOs can hibernate — instance variables disappear but WebSocket attachments survive. The Gateway already stores `sub`, `instanceName`, `claims`, etc. in the WebSocket attachment via `serializeAttachment`. The binding name must go there too, not in an instance variable.

### Steps

1. **Unify types**: Delete the private `WebSocketAttachment` interface. Add `bindingName`, `tokenExp`, and `connectedAt` to the already-exported `GatewayConnectionInfo` — it becomes both the attachment type and the hook parameter type. Neither `tokenExp` nor `connectedAt` is sensitive (the JWT itself is client-visible), so there's no reason for a separate private type:

```typescript
export interface GatewayConnectionInfo {
  sub: string;
  bindingName?: string;      // NEW — read from x-lumenize-do-binding-name header
  instanceName?: string;
  claims?: Record<string, unknown>;
  tokenExp?: number;         // moved from WebSocketAttachment
  connectedAt: number;       // moved from WebSocketAttachment
}
```

`connectedAt` is required because `GatewayConnectionInfo` is only passed to `onBeforeCallToMesh` and `onBeforeCallToClient` — both run after the connection is established. `onBeforeAccept` receives separate parameters, not this type.

2. **Auto-include all JWT claims**: Change the claims merge in `fetch()` so that **all JWT payload fields are included by default**, and `onBeforeAccept`'s return value (if `Record`) is merged on top. Currently the claims are just the hook's return value — change to `{ ...jwtPayload, ...(hookResult ?? {}) }`. This means subclasses only need to return *additional* claims. The default `onBeforeAccept` simplifies to validation-only (returns `undefined`), and its current cherry-picking of `emailVerified`, `adminApproved`, `isAdmin`, `act` becomes unnecessary.

3. **Capture binding name from header in `fetch()`**: Read `x-lumenize-do-binding-name` alongside the existing `X-Lumenize-DO-Instance-Name-Or-Id` read (currently line 350). Store it in the attachment.

4. **Replace `this.gatewayBindingName`**: At the two usage sites (lines 610 and 651), read `attachment.bindingName` instead.

5. **Delete `protected gatewayBindingName`** property (line 247). No longer needed.

6. **Remove manual `GatewayConnectionInfo` construction**: The attachment IS now a `GatewayConnectionInfo` — pass it directly to hooks instead of building a subset at lines 633-637.

7. **Update tests**: Existing hook tests should continue to pass. Add a test verifying that the binding name from the routing header appears in `callContext.callChain[0].bindingName` and `envelope.metadata.caller.bindingName`.

8. **Update docs**: Note the additive fields on `GatewayConnectionInfo` in gateway.mdx and mesh-api.mdx.

**Non-breaking**: additive fields on an existing exported type, additive claims in the connection info, no breaking changes to hook signatures.

## `routeNebulaAuthRequest` Fix (in `packages/nebula-auth/`)

Change `routeNebulaAuthRequest` to return `Promise<Response | undefined>` — return `undefined` (not 404) when the URL doesn't match the `/auth/` prefix. This follows the established fallthrough pattern used by `routeDORequest`.

## Success Criteria

- [ ] `GatewayConnectionInfo` is the single type for both WebSocket attachment and hook parameters (no private `WebSocketAttachment`)
- [ ] `GatewayConnectionInfo` has `bindingName`, `tokenExp`, and `connectedAt` fields
- [ ] Gateway auto-includes all JWT payload fields in claims; `onBeforeAccept` return value (if Record) is merged on top
- [ ] Gateway reads `x-lumenize-do-binding-name` header in `fetch()` and stores it in the attachment
- [ ] `verifiedOrigin` and `metadata.caller` use `attachment.bindingName` (hardcoded `gatewayBindingName` property removed)
- [ ] Existing Gateway tests pass; new test verifies binding name flows through to callChain and envelope metadata
- [ ] `routeNebulaAuthRequest` returns `Promise<Response | undefined>` — `undefined` for non-matching paths (fallthrough pattern)
- [ ] Minor version bump for `@lumenize/mesh` (no publish until Nebula deploys)

**Gate**: All `@lumenize/mesh` tests pass (`npm run test:code -- --filter mesh`). At least one test added or upgraded to confirm `bindingName`, `tokenExp`, and `connectedAt` are present on `GatewayConnectionInfo` as received by hooks.
