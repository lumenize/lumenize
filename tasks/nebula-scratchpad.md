# Nebula Scratchpad

Deferred items, early-stage ideas, and notes captured during planning. Items here aren't committed to any phase yet — they'll be pulled into specific task files when the time comes.

**Referenced from**: `tasks/nebula.md`

---

## Deferred Items

### Auth Related

- **Logging**: Add logging for @lumenize/nebula-auth

- **Outbound calls without `originAuth` (alarms, `newChain: true`)**: Any NebulaDO outbound `lmz.call` that doesn't originate from an inbound client call — alarm handlers, `newChain: true` calls that start a fresh chain — won't carry `originAuth.claims.aud` (the `universeGalaxyStarId`). `NebulaDO.onBeforeCall` intentionally rejects these in Phase 2. The DO knows its universeGalaxyStarId (stored on first call by `onBeforeCall` and retrievable with `this.ctx.storage.kv.get<string>('__nebula_universeGalaxyStarId')`), so it could construct a callContext manually. No concrete use case yet — the subscribe/resource update pattern always originates from a client call. Solve when a real use case emerges, likely Phase 5.
- **Email Domain Auto-Approval**: Admin configures email domains auto-approved for their instance. Disallow list prevents common public domains.
- **Email Template Customization**: Per-instance branding (name, logo) in auth emails with cascading overrides (star inherits galaxy inherits universe).
- **Billing Infrastructure**: Usage tracking per `galaxy.star`, monthly reports, Universe-level billing formulas via DWL/webhooks.

**OAuth 2 Social Login** (high priority):
- Google and GitHub OAuth 2 as login alternatives to magic link email
- Fits naturally into the existing login flow — discovery returns scopes, user picks one, then chooses magic link or social login

**Non-Human Subject Delegation**:
- Extend delegation to support agents (not just human-to-human). Currently Nebula Auth supports delegation from one human subject to another. Agents accessing Nebula resources will need their own delegation model.

**Admin Notification Controls**:
- Opt-out flag for admins to suppress self-signup notification emails (assumes a dashboard or other approval mechanism)
- Debounce duplicate notifications — if a user requests N magic links and clicks each, admins currently get N emails with the same approve link. Track "notification sent" flag per subject or deduplicate by approve URL within a time window.

**DPoP (RFC 9449) Sender-Constrained Tokens**:
- Binds tokens to a client-generated key pair so stolen tokens are unusable without the private key. Complements refresh token rotation — rotation detects reuse, DPoP makes exfiltrated tokens inert.
- Browser generates ECDSA P-256 key pair (non-extractable), sends signed DPoP proof JWT with each request. Server stamps key thumbprint into access token `cnf.jkt` claim, validates proof on each request.
- Ecosystem: RFC 9449 finalized, Okta GA, Auth0 Early Access, Keycloak 26.4 GA. `panva/dpop` and `panva/jose` libraries work in both browser and Cloudflare Workers.
- Limitation: Does not protect against full XSS (attacker can use the non-extractable key to sign proofs in-page). True hardware-bound keys await Device Bound Session Credentials (DBSC, W3C proposal).
- ~100 lines client-side (or use `dpop` package), server-side proof validation + jti replay tracking in DO SQL storage.

**Configurable Auth Redirects**:
- Currently `NEBULA_AUTH_REDIRECT` is the only redirect target for both success and error. Consider separate `NEBULA_AUTH_ERROR_REDIRECT` or `NEBULA_AUTH_LOGIN_URL`, with a convention for query params (`?error=<code>&return_to=<url>`). Would let the approve endpoint redirect to login with a return URL, so after re-auth the admin lands back on the approve link.

### Star Subscription Design (Phase 5)

Captured during Phase 3.1 review. The `#onChanged` callback is a placeholder in Phase 3.1. Full subscription fan-out happens in Phase 5.

**Subscription method**: `Star.subscribe()` — called by clients via mesh. Returns an object shaped for extensibility:
```
{ dagTreeState: DagTreeState, /* more properties later */ }
```

**Subscriber tracking**: Star maintains a subscriber list (outside DagTree — subscriptions are to the Star, not just the tree). Each subscriber entry captures:
- `sub` from `callContext.originAuth.sub` — **required**, throw if missing (only user-initiated subscriptions, not mesh-to-mesh)
- `bindingName` and `instanceName` from `callContext.callChain.at(-1)` — the immediate caller (NebulaClientGateway instance) for routing notifications back

**Notification delivery**: On tree mutation, Star iterates subscribers and calls each client's gateway via `this.lmz.call('NEBULA_CLIENT_GATEWAY', gwInstanceName, ...)`. Every online user is a subscriber (at minimum every 15 minutes due to access token TTL refresh).

**Client-side `dag-ops` functions**: The client imports pure functions from `@lumenize/nebula` (`resolvePermission`, `getEffectivePermission`, `getNodeAncestors`, `getNodeDescendants`, `validateSlug`, `checkSlugUniqueness`, `detectCycle`) that operate on its local `DagTreeState` copy. These enable pre-validation before mesh calls, permission-aware UI (enable/disable buttons, grey out inaccessible nodes), and local traversal — all with zero round trips. When the subscription pushes an updated `DagTreeState`, the client replaces its local copy and re-runs any needed computations. See `dag-ops.ts` in Phase 3.1 of `tasks/nebula-dag-tree.md`.

**Open questions for Phase 5**:
- Subscriber cleanup on disconnect (gateway notifies Star when client disconnects?)
- Does `getEffectivePermission` get called per-subscriber on notification, or is tree structure enough?
- Subscription to specific subtrees vs. full tree
- See scratchpad "Fanout Broadcast Tiering" for high subscriber counts

### DAG Tree Enhancements (from Phase 3.x)

- **`getSubtreePermissions(nodeId, sub)`**: Summary of what a subject can access in a subtree. Convenience method — no phase depends on it.
- **Bulk operations for tree setup (import/export)**: Needed for Phase 9 (Vibe Coding IDE) to load ontology definitions. Not needed before then.
- **Materialized closure table**: Alternative to in-memory ancestor walks if cache proves insufficient at scale. Phase 3.0 experiment showed in-memory is fast (p95 < 0.2ms for 500 nodes), so this is unlikely to be needed.
- **Performance regression tests**: Very deep trees (depth 10), wide trees (100+ children), dense DAGs (many diamonds). Pull in if performance becomes a concern.

### Client-Side DAG Display Patterns (from Phase 3.x — for Phase 8)

See blueprint UI reference in `tasks/reference/blueprint/ui/` for prior art. Server-side work is done (`DagTreeState` wire format + `dag-ops.ts` pure functions exported from `@lumenize/nebula`). These are Phase 8 (Nebula UI) implementation concerns:

- **Tree nesting**: Build nested `{ nodeId, slug, children[] }` from `DagTreeState.nodes` (using each node's `childIds`). In a DAG, a node with multiple parents appears in multiple positions.
- **Phantom branches**: Separate deleted and orphaned nodes into virtual "Deleted"/"Orphaned" branches (blueprint's `separateTreeAndDeleted` pattern).
- **`stitchParents`**: Add `node.parents` arrays (plural, DAG-aware) for upward traversal during search highlighting.
- **Normalized paths**: The client determines the normalized path based on which visual position the user clicked in the tree (the breadcrumbs array). A DAG node appears in multiple positions; each click yields a different path. The server doesn't need to choose a canonical path.
- **Peer comparisons**: Given a breadcrumbs path, the client goes up one level (`path.slice(0, -1)`) and uses `parent.children` to find siblings. This is the comparison set for analysis/aggregations.

### Resources Storage Enhancements (from Phase 5.1)

- **Progressive snapshot compression** — age-based granularity reduction (e.g., annual after 18 months, quarterly after 12 months, monthly after 1 month). Bounds storage growth while preserving reporting fidelity at each time horizon. Similar to what Blueprint implemented in `tasks/reference/blueprint/temporal-entity.js`.

- **Bulk demo data load** — LLM/agent generates full resource timelines (create → updates → moves → deletes) with pre-computed `validFrom` chains, bulk-inserted into Star. Bypasses eTag checking (loading history, not competing with live writers), but still validates timeline consistency (monotonic `validFrom`, continuous `validTo` chains) and permission checks on target nodes. This likely supersedes Blueprint's caller-provided `validFrom` — that was also used for cross-DO synchronized updates, but Blueprint used `validFrom` as its eTag and had finer-grained multi-DO transactions. With our separate eTag + single-DO transaction model, caller-provided `validFrom` may never be needed outside of bulk load.

### Nebula Resources Enhancements (from backlog)

**Fanout Broadcast Tiering**:
- For large subscriber counts, tier the fanout through armies of stand-alone LumenizeWorkers. First tier instantiates in the originator, subsequent tiers fan out to Workers.
- Algorithm sketch: <64 recipients = single shot. 64–4,096 = two tiers (√n fanout each). 4,096–262,144 = three tiers (∛n fanout each). Optimal fanout per tier needs experimentation as Cloudflare evolves.

### `@lumenize/ts-runtime-validate` Package Extraction

The pure `validate()` function in `apps/nebula/src/validate.ts` (Phase 5.2.2) is deliberately self-contained — no Nebula imports, no class, no state. This makes future extraction into a standalone MIT-licensed npm package trivial: copy `validate.ts`, `engine.ts`, and the minimal `lib.d.ts`, add a `package.json`, publish. The community pitch: "validate any JS value against any TypeScript type at runtime — no Zod, no JSON Schema." The tsc engine (3.4 MB bundled) is the only meaningful dependency. Nebula's Ontology class, versioning, defaults, relationships, and migrations stay BSL-1.1 in `apps/nebula/`. Teases the capability while keeping the secret sauce proprietary.

### Nebula Licensing (from backlog)

**BSL AI Training Restriction Clause**:
- Consider adding to BSL 1.1 license: "The Software, or any part of it, including its source code, may not be used to create, train, or improve any artificial intelligence or machine learning models or systems, or to generate any datasets, without the express written permission of the copyright holder(s)."

### Aggregations

Old-school npm `lumenize` aggregations over temporal data. The star DO will keep the most recent copy of every entity and a small cache of history snapshots. Snapshots other than the latest are lazily copied to a DO for that entity which can grow indefinitely.

### Vibe Coding IDE Follow-On

- Training pipeline for Nebula-specialized small language model
- Prompt engineering library (system prompts, few-shot examples, output validation)
- Code validation pipeline (generated code → `tsc` check → DWL deploy → integration test)
- Version control for vibe-coded applications (diff, rollback, branching)
- Collaboration features (multiple vibe coders on the same application)
- Marketplace / templates (pre-built application patterns)

---

## Vibe Coder Testing & Migration Workflow

Vibe coders need a way to test their work and migrate their applications over time. Two key challenges: (1) validating that changes work before going live, and (2) evolving the data model without breaking existing data.

### Wizard-Style Authoring Flow

The IDE should guide vibe coders through a structured flow, not dump them into a blank canvas:

1. **Ontology first** — Define the data model (resource types, fields, relationships, DAG tree structure) before touching UI. The wizard validates the ontology is coherent before proceeding.
2. **Migration validation gate** — When evolving the ontology, the vibe coder must write (or have the LLM generate) migration code and validate it passes before moving on to UI changes. No skipping ahead with a broken data model.
3. **UI second** — Build the end-user UI against the validated ontology.

However, this isn't strictly linear in practice — nobody gets the data model perfect on the first try. The vibe coder will revisit their ontology as they evolve their UI. The wizard should support this back-and-forth while still enforcing the validation gate: ontology change → migration validated → UI can use the new fields.

### Database Branching for Test Isolation

Key idea: leverage lazy migrations to create isolated test branches of the Resources database.

**How it works**: When working in a "branch" (for testing only — branches never merge back into production instances), entity reads trigger lazy migration as usual, but the migrated copy gets tagged as belonging to that branch. The original unmigrated entity remains untouched for the production path.

- **Leaf-node resources**: This works cleanly. Read a resource in the test branch → lazy migration produces a branched copy → test against it → discard the branch when done.
- **DAG tree**: Trickier, but may "just work" if we store the DAG tree structure in one or two resource entries (rather than as separate SQL tables). Then the DAG tree itself can be branched the same way as any other resource. This is worth exploring.

**Use cases**:
- Vibe coder changes their ontology → creates a test branch → validates migrations run correctly against real-ish data → promotes the changes (deploys new DWL code) → production instances lazy-migrate on next read
- Automated test runs in CI-like flows get their own ephemeral branches
- Demo/staging environments that don't pollute production data

**Open questions**:
- How does branching interact with subscriptions? (Probably: branched data doesn't trigger production subscriptions)
- Branch cleanup — automatic expiry or explicit delete?
- Can we branch a subset of the tree (e.g., just one star's data) or is it all-or-nothing per DO?
- Performance: does tagging add meaningful overhead to reads?
