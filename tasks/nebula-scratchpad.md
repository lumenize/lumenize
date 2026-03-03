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

### Nebula Resources Enhancements (from backlog)

**Fanout Broadcast Tiering**:
- For large subscriber counts, tier the fanout through armies of stand-alone LumenizeWorkers. First tier instantiates in the originator, subsequent tiers fan out to Workers.
- Algorithm sketch: <64 recipients = single shot. 64–4,096 = two tiers (√n fanout each). 4,096–262,144 = three tiers (∛n fanout each). Optimal fanout per tier needs experimentation as Cloudflare evolves.

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
