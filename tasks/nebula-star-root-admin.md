# Star root-admin bootstrap + last-admin protection

**Status**: spec'd 2026-06-10, not started; Part 1b (tenant-local placement) added 2026-06-12 — depends on [mesh-origin-request.md](mesh-origin-request.md). Surfaced during the 5.3.7 docs deep-review (bootstrap cluster M1/M5/M11) — see [nebula-frontend.md](nebula-frontend.md) § Phase 5.3.7-v3 ("First-run container create").

**Model context (clarified 2026-06-10).** There is no separate "Star admin" scope concept: a Star admin is simply a user holding `admin` on the Star's **root orgTree node** (`ROOT_NODE_ID`). A new tenant self-signs-up via the Galaxy (create account → pick Star name + slug → Galaxy provisions the Star), and the founder must come out of that flow holding `admin` on root. Every other user starts with **zero** grants and acquires access via request-access (climb to the nearest admin ancestor) or an app-developer invite — there is no auto-created per-user "home node". The root admin grant is therefore the single guaranteed starting point that makes the whole permission graph reachable: the request-access climb terminates at root only because the founder's admin grant lives *in the tree* there (a scope-level bypass admin wouldn't be findable by the climb).

This is the prerequisite the docs' founder-demo bootstrap leans on (coding-your-ui § Lists attaches the founder's `todoList` under `ROOT_NODE_ID`, valid precisely because the founder holds `admin` there).

> Resolved (deep-review flag #5, 2026-06-10/11): the `claims.access.admin` bypass at [dag-tree.ts:158](../apps/nebula/src/dag-tree.ts:158) is **kept** — it IS the Galaxy/Universe scope-admin tier, parallel to DAG grants and deliberately absent from the permissions map. The code comment is already relabeled ("Galaxy/Universe-scope admin bypass (NOT a Star admin — that's a DAG `admin` grant on root)"), and the two-source admin model is pinned in nebula-frontend.md § Decisions pinned, resources.md § Access control, and coding-your-ui § Gating admin-only UI. Residual: relabel any surviving "Star admin" vocabulary (e.g. old test names).

## Part 1 — Seed the founder as root admin at Star provisioning

When the Galaxy provisions a Star for a new tenant, the founder's `sub` gets `admin` on `ROOT_NODE_ID` of that Star's orgTree: `dagTree.setPermission(ROOT_NODE_ID, founderSub, 'admin')`, run as part of the provisioning path (Stars are currently lazy DO instances — the seed happens on the first-provision flow, wherever the self-signup lands it; **no explicit `createStar` mesh method exists yet** — `apps/nebula/src/galaxy.ts` has config/ontology methods only).

- [ ] Identify/establish the Star-provisioning entry point (self-signup → Galaxy → Star). Seed `setPermission(ROOT_NODE_ID, founderSub, 'admin')` there, exactly once, at first provision.
- [ ] **Test (the concrete ask):** provision a Star with a known `founderSub` → assert that user holds `admin` on `ROOT_NODE_ID` (e.g. `checkPermission(ROOT_NODE_ID, 'admin')` true for the founder, and `getState().permissions` carries the grant). This is the minimal proof that "create a Star with a known user as the root admin" works.

## Part 1b — Place the Star near the tenant (locationHint)

A DO's location is decided by its **first touch** and is permanent (Cloudflare does not relocate DOs). Left alone, Galaxy-provisions-Star places every Star near the Galaxy. Fix: derive a `locationHint` from the founder's signup locale and make the provisioning call — Part 1's first touch of the Star — carry it. The hint **overrides caller proximity**, so the Galaxy still does the creating; hints are best-effort (nearest DO-capable datacenter to the hinted region), which is fine — founder-locale is itself a heuristic for where the tenant's users are.

**Prerequisite**: [mesh-origin-request.md](mesh-origin-request.md) — `callContext.originRequest` (origin geo arrives with every client call), `CallOptions.locationHint`, and `cfToLocationHint`.

The hint's **source** depends on where Part 1 lands the provisioning entry point (first checkbox above):
- **Provisioning rides an authenticated mesh flow** (e.g., the founder's first connect / first authenticated call after the magic link): derive in place — `cfToLocationHint(callContext.originRequest?.cf)` — no persistence needed. Preferred if Part 1 allows it: zero schema changes.
- **Provisioning stays at the pre-auth claim step** (today's `claimStar`/`claimUniverse` are raw HTTP in nebula-auth's router — no Gateway, no callContext): capture `request.cf` in the router claim handlers ([router.ts:187-227](../packages/nebula-auth/src/router.ts)), pass to the Registry methods as a new param, persist a nullable `locationHint` column on the Registry `Instances` table (REGISTRY_SCHEMAS + the three INSERT sites), read it at provision time.

- [ ] Decide which case applies (falls out of Part 1's entry-point decision); implement only that capture path.
- [ ] The provisioning call passes `{ locationHint }` (mesh `CallOptions`) on the first Star touch. Document the ordering invariant at the call site: the hinted provision completes before the Star is reachable any other way (Gateway resolution, magic-link landing) — any earlier touch pins placement silently and permanently.
- [ ] **Test (plumbing, capable-of-failing):** provision with a known cf fixture → assert the Star namespace `getByName` receives the expected `locationHint` (spy/wrap). Actual placement is NOT observable locally — miniflare fakes `request.cf` and ignores hints (same caveat class as jurisdiction, [tasks/archive/playwright-test-template.md](archive/playwright-test-template.md)). Optional deployed smoke test later.
- [ ] Optional, cheap: pass the derived/stored hint on the NebulaAuth-DO first touch too ([router.ts:258/266](../packages/nebula-auth/src/router.ts)). Today that DO lands eyeball-local naturally (the router Worker runs in the founder's colo), so this is harmless reinforcement — skip if it adds noise.

## Part 2 — Last-admin protection (enforce in Star / dag-tree)

**Invariant: `ROOT_NODE_ID` must always retain at least one `admin` grant.** Enforce in dag-tree (it lives on the Star) so it holds regardless of caller — add-before-remove: to hand off, grant the new admin *first*, then revoke the old.

Guard the two mutation points ([dag-tree.ts](../apps/nebula/src/dag-tree.ts)):

- [ ] **`revokePermission(ROOT_NODE_ID, sub)`** — reject if `sub` is the **last** `admin` grant on root (count of root grants with tier `admin` would drop to 0). Throw a typed error (e.g. `LastRootAdminError`) so the client surfaces "add another admin first," not a generic failure. Idempotent no-op (sub has no grant) stays a no-op.
- [ ] **`setPermission(ROOT_NODE_ID, sub, level)`** — reject a **demotion** of the last admin: if `sub` currently holds `admin` on root, `level !== 'admin'`, and `sub` is the only root admin → reject (same typed error). Promoting/adding others is always fine.
- [ ] `deleteNode(ROOT_NODE_ID)` is already forbidden (root cannot be deleted/undeleted/renamed — [api-reference.md § client.orgTree](../website/docs/nebula/api-reference.md#clientorgtree)); no change, just confirm the new guard doesn't need to cover a delete path.
- [ ] Compute "is this the last root admin" from the cached permissions view (`#cached.permissions.get(ROOT_NODE_ID)`), counting entries with tier `admin` — all in-memory, no extra reads.

**Tests:**
- [ ] Single root admin → `revokePermission(ROOT, founderSub)` rejects with `LastRootAdminError`; the grant survives.
- [ ] Single root admin → `setPermission(ROOT, founderSub, 'write')` (self-demote) rejects; grant stays `admin`.
- [ ] Add-before-remove succeeds: `setPermission(ROOT, second, 'admin')` then `revokePermission(ROOT, founder)` → both succeed, `second` remains admin.
- [ ] Non-root nodes are unaffected — revoking/demoting the last admin on a non-root node is allowed (those can legitimately go adminless; access flows from ancestors).

## Out of scope
- The self-signup **UI** (Larry: "we have all of that but the UI now"). Includes any explicit "where are most of your users?" region picker — auto-detect from signup locale is Part 1b's v1; a picker would ride the signup UI later.
- **Jurisdiction** (EU data residency) — deliberately NOT a `locationHint` sibling: it changes DO IDs and therefore addressing at every resolution site. Backlogged with the design constraints: [tasks/backlog.md](backlog.md) § Other Nebula backlog ("EU data residency for Stars").
- Galaxy/Registry placement (shared infra, not per-tenant).
- The `claims.access.admin` question is resolved (kept as the scope-admin tier — see the model-context note above); only the "Star admin" vocabulary relabel residual remains, and it's not this task's.
