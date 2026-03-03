# Nebula Resource Capability Tickets

**Phase**: 5.5
**Status**: Pending
**App**: `apps/nebula/`
**Depends on**: Phase 5 (Resources — Basic Functionality), Phase 3 (DAG Tree Access Control)

**Master task file**: `tasks/nebula.md`

## Goal

Add per-resource, per-user capability tickets so clients can talk directly to ResourceHistory DOs without routing every access through the Star singleton. Eliminates the Star as a bottleneck for resource reads/writes while providing real authorization (not security-through-obscurity via unguessable UUIDs).

---

## Problem

After Phase 5, the Star singleton is the access control gateway for all resources. The flow is:

1. Client asks Star for access to a resource
2. Star checks the DAG (Phase 3) to determine permissions
3. Star returns the resource UUID to the client
4. Client talks directly to ResourceHistory by UUID

Step 4 relies on security-through-obscurity — if a user without permission learns a resource's UUID, they can access it. The `onBeforeCall` universeGalaxyStarId binding only validates Star-level scope, not per-resource authorization.

## Solution: HMAC Capability Tickets (Approach A)

Stateless, short-lived, per-resource-per-user tickets signed with the existing JWT private key (BLUE/GREEN rotation). No new secrets needed.

### Flow

1. Client asks Star for access to resource `R`
2. Star checks DAG → user has `read` (or `write`, `admin`) permission
3. Star mints an HMAC ticket: `HMAC(JWT_PRIVATE_KEY, {sub, res, cap, aud, exp})`
4. Client receives `{uuid, ticket}` — holds ticket in memory
5. Client presents ticket on each call to ResourceHistory `R`
6. ResourceHistory recomputes HMAC using the same private key from `env` — verifies independently, no round-trip to Star
7. When ticket expires (short TTL), client goes back to Star for a fresh one — Star re-checks DAG

### Security Properties

- **No new secrets**: Reuses existing `JWT_PRIVATE_KEY_BLUE` / `JWT_PRIVATE_KEY_GREEN` as HMAC keys
- **BLUE/GREEN rotation**: ResourceHistory tries both keys during overlap window (same pattern as nebula-auth JWT verification)
- **Per-user**: Different `sub` → different HMAC output. Users can't share tickets
- **Per-resource**: Different `res` → different HMAC output. Tickets can't be reused across resources
- **Stateless on Star**: Star mints and forgets. No storage cost. DAG is the source of truth
- **Stateless on ResourceHistory**: No ACL storage. Just recomputes HMAC to verify
- **Short TTL**: Revocation takes effect naturally when ticket expires and Star refuses to re-mint
- **Unforgeable by clients**: `JWT_PRIVATE_KEY` is server-side only, never exposed to clients

### Ticket Format

Compact, not a full JWT — just enough for HMAC verification:

```
base64url({sub, res, cap, aud, exp}) + "." + base64url(HMAC-SHA256(privateKey, payload))
```

Fields:
- `sub` — user subject (from JWT)
- `res` — resource UUID
- `cap` — capabilities array (e.g., `["read"]`, `["read", "write"]`)
- `aud` — active scope (e.g., `"acme.app.tenant-a"`) — must match ResourceHistory's stored universeGalaxyStarId
- `exp` — expiry timestamp (e.g., 5 minutes from now)

### Where Verification Lives

ResourceHistory's `onBeforeCall` override (or a guard) verifies the ticket on every mesh call. This layers on top of NebulaDO's existing `onBeforeCall` (universeGalaxyStarId binding):

1. `NebulaDO.onBeforeCall()` — validates active scope (Star-level, inherited)
2. ResourceHistory ticket verification — validates per-resource-per-user authorization

### async Exception

`crypto.subtle.sign` / `crypto.subtle.verify` are async (Web Crypto API has no synchronous alternative). Per CLAUDE.md, this is an acceptable exception — completes in microseconds, doesn't open input gates long enough to cause practical interleaving.

---

## Deployment Consideration: Same vs Separate Workers Projects

Phase 5.5 assumes nebula-auth and nebula are in the **same Workers project** (same `env`). In this setup, all DOs have access to the private keys — the trust boundary is code convention, not runtime isolation.

If nebula-auth is later split into a **separate Workers project** (cross-project service bindings), the architecture strengthens: nebula project would only have public keys and could not mint tickets. Star would call nebula-auth via RPC to mint tickets (one-time cost per TTL, not per access). ResourceHistory would verify with the public key instead of HMAC. This is a clean migration path but not required for Phase 5.5.

---

## What This Phase Adds

- **Ticket minting** on Star (after DAG permission check)
- **Ticket verification** on ResourceHistory (HMAC recomputation)
- **Client-side ticket caching** on NebulaClient (in-memory, per-resource, auto-refresh on expiry)
- **BLUE/GREEN key overlap** handling in verification
- **Abuse case tests**: forged ticket, expired ticket, wrong-sub ticket, wrong-resource ticket, ticket from different active scope, ticket minted with rotated-out key

## What This Phase Does NOT Change

- Star singleton still owns the DAG and permission model (Phase 3)
- `onBeforeCall` universeGalaxyStarId binding unchanged (Phase 2)
- Temporal storage model unchanged (Phase 5)
- No new secrets or key infrastructure

---

## Success Criteria

- [ ] Star mints HMAC capability tickets using existing JWT private key (BLUE/GREEN)
- [ ] ResourceHistory independently verifies tickets — no round-trip to Star
- [ ] Tickets are per-user, per-resource (different sub or res → different HMAC)
- [ ] Short TTL (configurable, default ~5 minutes)
- [ ] Client caches tickets in memory, auto-refreshes on expiry
- [ ] BLUE/GREEN key rotation works (verify with both keys during overlap)
- [ ] Abuse cases: forged, expired, wrong-sub, wrong-resource, wrong-scope tickets all rejected
- [ ] Zero additional storage on Star (stateless minting)
- [ ] Zero additional storage on ResourceHistory (stateless verification)
