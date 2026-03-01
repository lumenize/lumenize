# Nebula Mesh Gateway Fix

**Phase**: 1.7
**Status**: Complete
**Packages**: `@lumenize/mesh`, `@lumenize/nebula-auth`
**Depends on**: Phase 1.5 (Mesh Extensibility)
**Master task file**: `tasks/nebula.md`
**Branch**: `feat/nebula-baseline-access-control` (no mesh release until Nebula deploys)

## Goal

Fix `LumenizeClientGateway` to read its binding name from the routing header (like every other DO) instead of a hardcoded property, unify `WebSocketAttachment` into the public `GatewayConnectionInfo` type, and auto-include all JWT claims so subclasses only need to return additional claims. Also change `routeNebulaAuthRequest` to follow the fallthrough pattern (`undefined` for non-matching paths). No version bump — all packages publish together when Nebula is complete.

## LumenizeClientGateway Fix (in `packages/mesh/src/lumenize-client-gateway.ts`)

**Bug:** `LumenizeClientGateway` hardcodes `protected gatewayBindingName = 'LUMENIZE_CLIENT_GATEWAY'` and uses it for `verifiedOrigin` and `metadata.caller` in envelopes. Every other DO behind `routeDORequest` reads its binding name from the `X-Lumenize-DO-Binding-Name` header — the Gateway should too. The hardcoded property means subclasses (like `NebulaClientGateway`) would need to override it, which is unnecessary indirection.

**Hibernation constraint:** DOs can hibernate — instance variables disappear but WebSocket attachments survive. The Gateway already stores `sub`, `instanceName`, `claims`, etc. in the WebSocket attachment via `serializeAttachment`. The binding name must go there too, not in an instance variable.

### Steps

1. **Unify types**: Delete the private `WebSocketAttachment` interface. Add `bindingName` to the already-exported `GatewayConnectionInfo` — it becomes both the attachment type and the hook parameter type. Drop `connectedAt` (stored but never read — confirmed dead code) and the top-level `tokenExp` (use `claims.exp` instead — one source of truth). Make `claims` required since auto-including all JWT fields means it's always populated for authenticated connections:

```typescript
export interface GatewayConnectionInfo {
  /** Subject ID from verified JWT. Also present as claims.sub (convenience field). */
  sub: string;
  /** DO binding name from X-Lumenize-DO-Binding-Name routing header. */
  bindingName: string;
  /** DO instance name from X-Lumenize-DO-Instance-Name-Or-Id routing header. */
  instanceName: string;
  /** All JWT payload fields, plus any additional claims from onBeforeAccept. */
  claims: Record<string, unknown>;
}
```

Both `bindingName` and `instanceName` come from routing headers set by `routeDORequest` and are validated with 403 guards in `fetch()` — they are always present together. Making both required reflects this. `claims` is required because the gateway auto-includes all JWT payload fields (step 2). The two internal token-expiration checks (in `webSocketMessage` and `__executeOperation`) read `claims.exp` instead of a redundant top-level field.

2. **Auto-include all JWT claims**: Change the claims merge in `fetch()` so that **all JWT payload fields are included by default**, and `onBeforeAccept`'s return value (if `Record`) is merged on top: `{ ...jwtPayload, ...(hookResult ?? {}) }`. A full JWT is ~400 bytes; with the other attachment fields, total is ~500 bytes — well under the **2,048-byte** WebSocket attachment limit (~25% of budget). Being selective adds complexity and risks needing changes when hooks need a field that was excluded. The default `onBeforeAccept` simplifies to validation-only (returns `undefined`), and its current cherry-picking of `emailVerified`, `adminApproved`, `isAdmin`, `act` becomes unnecessary. Subclasses can still override to add/remove claims.

3. **Capture binding name from header in `fetch()`**: Read `X-Lumenize-DO-Binding-Name` alongside the existing `X-Lumenize-DO-Instance-Name-Or-Id` read (currently line 350). Return 403 if missing (like the existing instanceName guard). Store it in the attachment.

4. **Replace `this.gatewayBindingName`**: At the two usage sites (lines 610 and 651), read `attachment.bindingName` instead.

5. **Delete `protected gatewayBindingName`** property (line 247). No longer needed.

6. **Remove manual `GatewayConnectionInfo` construction**: The attachment IS now a `GatewayConnectionInfo` — pass it directly to hooks instead of building a subset at lines 633-637. Add an early guard for null attachment in `onBeforeCallToMesh`/`onBeforeCallToClient` call sites (`__executeOperation` and `#handleClientCall`): if `deserializeAttachment()` returns null, close the WebSocket — this means the connection wasn't set up properly and continuing would produce incorrect callChain/metadata.

7. **Update tests**: All 5 existing claims assertions use `toMatchObject`, so they pass as-is when claims expand to the full JWT — no blast radius. The existing test at line 1345 (`callChain[0].bindingName === 'CUSTOM_GATEWAY'`) already validates the binding name flow; after this fix it will derive from the routing header instead of the hardcoded property, which is a good regression check. Add a test verifying the binding name also appears in `envelope.metadata.caller.bindingName`.

8. **Update docs**: Note the additive fields on `GatewayConnectionInfo` in gateway.mdx and mesh-api.mdx.

**Non-breaking**: additive fields on an existing exported type, expanded default claims in the connection info, no breaking changes to hook signatures.

## `routeNebulaAuthRequest` Fix (in `packages/nebula-auth/`)

Change `routeNebulaAuthRequest` to return `Promise<Response | undefined>` — return `undefined` (not 404) when the URL doesn't match the `/auth/` prefix. This follows the established fallthrough pattern used by `routeDORequest`.

Update all callers to handle `undefined`. The test worker in `packages/nebula-auth/test/test-worker-and-dos.ts` currently does `return routeNebulaAuthRequest(request, env)` — this needs a fallback like `?? new Response('Not Found', { status: 404 })`.

## Success Criteria

- [ ] `GatewayConnectionInfo` is the single type for both WebSocket attachment and hook parameters (no private `WebSocketAttachment`)
- [ ] `GatewayConnectionInfo` has `bindingName` (required), `instanceName` (required), `claims` (required); `connectedAt` and top-level `tokenExp` removed (use `claims.exp`)
- [ ] Gateway auto-includes all JWT payload fields in claims; `onBeforeAccept` return value (if Record) is merged on top; default `onBeforeAccept` simplified to validation-only
- [ ] Gateway reads `X-Lumenize-DO-Binding-Name` header in `fetch()`, returns 403 if missing, stores it in the attachment
- [ ] `verifiedOrigin` and `metadata.caller` use `attachment.bindingName` (hardcoded `gatewayBindingName` property removed)
- [ ] Existing Gateway tests pass; new test verifies binding name flows through to callChain and envelope metadata
- [ ] `routeNebulaAuthRequest` returns `Promise<Response | undefined>` — `undefined` for non-matching paths (fallthrough pattern); all callers updated
- [ ] Null attachment deserialization handled with early guard (close WebSocket with 1011) in hook call sites
- [ ] `sub` documented as convenience field that duplicates `claims.sub`; internal expiration checks use `claims.exp`

**Gate**: All `@lumenize/mesh` tests pass (`npm run test:code -- --filter mesh`). All `@lumenize/nebula-auth` tests pass (`npm run test:code -- --filter nebula-auth`). At least one test confirms `bindingName` (required), `instanceName` (required), and `claims` (required) are present on `GatewayConnectionInfo` as received by hooks.
