# Nebula Scratchpad

Deferred items, early-stage ideas, and notes captured during planning. Items here aren't committed to any phase yet — they'll be pulled into specific task files when the time comes.

**Referenced from**: `tasks/nebula.md`

---

## Deferred Items

### Auth Related

- **Logging**: Add logging for @lumenize/nebula-auth

- **Surface email-send failures to the client / fail loudly**: `LumenizeAuth#sendEmail` (and the per-call sites — `#handleEmailMagicLink`, the approve flow, the invite flow) wraps the `await sendEmail(...)` call in `try/catch` and only logs via `debug('auth.LumenizeAuth')`. The client gets `{message: "Check your email"}` and `200 OK` whether the email actually went out or not. Discovered 2026-04-28 while building the Nebula browser harness — Cloudflare Email Sending rejected `auth@nebula.lumenize.com` with "destination address is not a verified address" but the response was a clean 200. The user only saw "no email" and had to enable DEBUG to figure out why. Options: (a) don't try/catch the immediate call — let it propagate to a 503 (Cloudflare Email Sending DOES throw synchronously for binding-level failures; later SMTP-stage failures are async and harder to surface but those are rare). (b) Add a status header (`X-Email-Send: ok|failed`) so callers can opt into noticing. (c) Add an audit log endpoint admins can query for recent send failures. (a) is probably right — current swallow exists because an older path may have had transient errors worth retrying, but the swallow has cost more than it's saved. We're using `CloudflareEmailSender` (not Resend) on `feat/nebula-resources` after the merge of main, so the pattern is now consistent. Should also audit the same try/catch in the approve / invite flows.

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

### Mesh Infrastructure

- **Propagate per-call IDs through `callChain`** — see [tasks/mesh-call-tracing-and-ids.md](mesh-call-tracing-and-ids.md). A richer design than just adding a single `callId` to `CallContext`: each `callChain[]` entry gets its own `callId`, so `callChain[0].callId` is the traceId and `callChain.at(-1).callId` is the current hop. Closes the Gateway-timestamp correlation gap discussed during 2026-06-02 logging work — multiple WS frames sharing `Date.now()` due to fuzzy invocation boundaries (`feedback_cf_clock_traps.md`) wouldn't be distinguishable by timestamp alone, but per-hop callIds would. Also paired with standardizing `uniqueId()` (monotonic ULID) and `secureToken()` primitives across mesh + nebula. Five-phase plan, not started.

- **Watch for browser ALS polyfills and swap one in when ready**: Today, `packages/mesh/src/lmz-api-context.browser.ts` is a module-scoped-variable shim that preserves context synchronously but not across `await` boundaries — `LumenizeClient` framework code works around this by threading `CallContext` explicitly through closures (refactored 2026-06-03; see `tasks/archive/playwright-test-template.md` § Known blockers #2 for the journey). User code reading `this.lmz.callContext` AFTER an `await` inside a browser-side `@mesh()` handler hits a silent cliff — corrupted with whatever context the most recent concurrent handler set. No current handler does this, so it doesn't bite. **The clean fix is a real ALS polyfill**, but as of 2026-06-03 the available options are weak: `@b9g/async-context` uses `node:async_hooks` internally (defeats our purpose), `@webfill/async-context` is 3+ years stale, `simple-async-context` is unvetted, and `unctx` has a different API model. Userland Promise-then patching can't intercept V8's `await` fast-path; the working alternative requires zone.js-style global Promise replacement, too heavy for a library. The TC39 [AsyncContext proposal](https://github.com/tc39/proposal-async-context) is at Stage 2 — when it advances to Stage 3+ and ships natively in a browser engine, OR when a battle-tested polyfill (TC39-shaped, light-weight, not Node-ALS-internal) appears in the npm ecosystem, swap it in. The mesh-side change at that point is small: rewrite `lmz-api-context.browser.ts` to wrap the polyfill, keep the same `runWithCallContext`/`getCurrentCallContext` exports. The framework-internal explicit threading we added stays as a defense-in-depth — works correctly regardless of whether the polyfill is present. Re-evaluate every ~6 months or when someone needs cross-await callContext reads in a browser handler.

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

### Rollback failure-outcome sibling tests (deferred)

Spawned from [archive/validation-failed-rollback.md](archive/validation-failed-rollback.md) § "Scope decision (2026-06-04)". That task shipped 2026-06-04 — three of the five terminal-non-committed `TransactionResolution` outcomes now have bindToState rollback test coverage: `validation-failed`, `permission-denied`, `ontology-stale`. The remaining two are deferred and want their own sibling tests once their blockers clear:

- **`timeout`** — needs WS-disconnect tooling (also deferred in [nebula-frontend.md](nebula-frontend.md) § Phase 5.3.6). Test shape: subscribe → optimistic write → drop the WS or stall the server-side handler past the 5–10 s queue timeout → assert state reverts to pre-write snapshot via `source: 'rollback'`.
- **`retries-exhausted`** — belongs with the broader conflict-resolver-loop redesign in Phase 5.3.7 (`TransactionOutcome` / `TransactionResourceResolution`). Test shape: register an `onETagConflict` resolver that always returns `'use-this'`, optimistic write at a stale eTag → after `maxRetries` attempts hits cap → assert state reverts.

Both should reuse the same shape as the `validation-failed`/`permission-denied`/`ontology-stale` siblings — only the trigger differs. The middleware dispatcher (`#processMiddlewareOutcome`) already handles both branches; the gap is purely test coverage.

### Nebula Resources Enhancements (from backlog)

**Fanout Broadcast Tiering**:
- For large subscriber counts, tier the fanout through armies of stand-alone LumenizeWorkers. First tier instantiates in the originator, subsequent tiers fan out to Workers.
- Algorithm sketch: <64 recipients = single shot. 64–4,096 = two tiers (√n fanout each). 4,096–262,144 = three tiers (∛n fanout each). Optimal fanout per tier needs experimentation as Cloudflare evolves.

### NebulaWorker for Dynamic Workers

The initial DW validator wrapper (task 5.2.3.7) uses raw Workers RPC — the `ValidatorWorker` extends `WorkerEntrypoint` and the caller uses `using worker = loader.load(...)` directly. This is fine for riding the coattails of Cloudflare's DW announcement, but for Nebula's own use we want DW communication to go through `this.lmz.call()` like everything else in the mesh.

**Plan**: Create a `NebulaWorker` base class (analogous to `LumenizeWorker` for regular Workers) that:
- Wraps DW loading/disposal behind the mesh abstraction
- Supports `this.lmz.call('VALIDATOR', instanceName, ctn().validate(...))` syntax
- Handles stub lifecycle (`using`) automatically to avoid wall-clock billing

**Blocked on**: Discord memory-sharing answer. If DWs get their own memory budget, this becomes the recommended default for Nebula's tsc validation (memory tradeoff row in docs disappears). If shared budget, it's still useful for code organization but doesn't solve the memory constraint. Either way, the NebulaWorker wrapper is worth building — the question is how prominently to recommend it.

### ~~Heterogeneous Map Validation~~ (DONE — Phase 5.2.3.6)

Fixed. `validate()` now extracts Map/Set generic type parameters from the type definitions AST and passes them to `toTypeScript()`, which emits explicit type params (e.g., `new Map<string, string | number>([...])`). See `tasks/nebula-5.2.3.6-map-set-generics-support.md`.

### Value Constraints via JSDoc Annotations

Moved to `tasks/on-hold/nebula-orm-and-queries.md` (post-demo). Includes JSDoc constraints (`@min`, `@max`, `@format`) as Part A, M:N relationship design with join tables as Part B, and query-time filtering / bounded hydration in the multi-resource `query()` work as Part C. (`@default` is now handled by the parse-validate package, not this work.)

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
- Version control for vibe-coded applications (diff, rollback, branching) — **concrete approach worth exploring: wasm-git running inside a DO/Worker.** Cloudflare maintains a working demo at https://github.com/cloudflare/cloudflare-workers-wasm-demo (git in Zig compiled to WASM, ~5MB blob, pluggable storage backend so we can put the object store in Galaxy SQLite, R2, or a dedicated DO).

  **Three timelines exist in the platform; git would address the missing one.**
  - **Source authoring** (every AI iteration of ontology + UI code) — *not currently addressed; this is what git would cover*.
  - **Schema deployment** (every promoted ontology version) — already addressed by immutable append-only `OntologyVersionRow`.
  - **Data history** (every resource write) — already addressed by Snodgrass temporal storage.

  **The seam**: git lives entirely on the dev side. Every `deploy_to_dev` is a commit on the `.dev` branch's iteration history. `deploy_to_main` squashes + creates a new immutable `OntologyVersionRow`, leaving git behind. Production evolution stays simple and append-only — git complements rather than replaces.

  **Why it's compelling**: the AI is exceptionally good at reasoning about git directly. "Show me what changed since the last working version" is a `git diff` the AI can issue itself, not a custom API we have to design. Diff/blame/log/revert/cherry-pick all come for free once the WASM is loaded.

  **Caveats to design through when this unfreezes**:
  - **Branch-name collision** with the URL-level branches we just made first-class (`.main` / `.dev`). Different concepts (URL branches are runtime routing; git branches are authoring-time exploration), but the term overlap will confuse readers. Probably present them in the Studio UI as "iterations" or "checkpoints" to avoid saying "branch" twice.
  - **Where the git store lives.** wasm-git's storage layer is pluggable; the choice is ours (Galaxy SQLite, dedicated DO, R2-backed).
  - **Storage growth.** Each iteration is a commit; popular projects could accumulate gigabytes. Need a squash-after-N or GC-old story.
  - **AI-as-git-client surface.** Letting the AI issue git commands against its iteration history is powerful but a real surface to design — what subset is exposed, how it composes with `deploy_to_dev`, etc.

  **Why we're not doing this for the demo**: "the AI's working memory IS the history" works fine for a 5-minute demo. Git becomes valuable when iteration spans days/weeks across sessions. Captured here so the idea isn't lost.
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
