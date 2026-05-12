# Lumenize Project Context

Packages for Cloudflare Durable Objects. Users ("vibe coders") are domain experts but not necessarily experienced developers—prioritize clear patterns and guard against footguns. Security is on by default. Test coverage targets: Branch >80%, Statement >90%.

---

## Critical Rules

- **npm only** - never use pnpm or yarn
- **`#` prefix for private members** - never use TypeScript `private` keyword
- **Synchronous storage only** - use `ctx.storage.kv.*` or `ctx.storage.sql.*`, never legacy async API (`ctx.storage.put/get`)
- **Auto-generate Env interface** - run `wrangler types`, never manually define it
- **`compatibility_date: "2026-03-12"`** or later in wrangler.jsonc
- **Secrets in root `.dev.vars`** - gitignored, auto-symlinked via postinstall; never commit secrets or put them in source code
- **Docs in `/website/docs/`** — always use `.md`; `.mdx` requires explicit human approval and is reserved for pages that truly need JSX components, imports, or expression interpolation. Admonitions (`:::info`) and HTML work in plain `.md`, so most pages don't need `.mdx`. Never create temp docs elsewhere.

---

## Claude Code Configuration

- **`.claude/settings.json`** - Pre-approved permissions for common operations (committed to git)
- **`.claude/settings.local.json`** - Personal overrides (gitignored, takes precedence)

---

## Semantic Code Search

For conceptual searches ("find code that handles rate limiting", "where do we validate JWTs"), use Probe via npx:

    npx -y @probelabs/probe search "<query>" [path]

Probe is AST-aware (ripgrep speed + tree-sitter parsing), runs fully local, no API keys, no hosted service. Returns whole functions/classes rather than text chunks.

`Grep` remains the default for literal strings and symbols — Probe is a step up when you need structural/semantic matching.

---

## Development Workflow

Task files live in `tasks/`. Use `/task-management` to choose docs-first or implementation-first workflow.

### Related Commands
- `/task-management` - Docs-first vs implementation-first workflows
- `/refactor-efficiently` - Incremental API changes with `.only` pattern
- `/release-workflow` - Publish packages to npm

### Experiments

`experiments/*` are point-in-time spikes, not maintained artifacts. Results live in the experiment's `RESULTS.md` / `FINDINGS.md` / blog post, not in keeping the code runnable. An experiment commonly breaks soon after it's run because we modify the source code it depended on — **that's fine**; don't try to fix it.

**Starting a new experiment**: create `experiments/<name>/` with its own `package.json`, `wrangler.jsonc`, etc., then add `"experiments/<name>"` **as an individual entry** (not a glob) to the root `package.json` `workspaces` list, then run `npm install` at the repo root. Individual entries are load-bearing — `experiments/*` would break `npm install` the moment one experiment references a renamed/deleted package.

**When an old experiment breaks**: remove its entry from the root `package.json` `workspaces` list (or delete the dir entirely if the results are already captured elsewhere). Do NOT try to make it run again.

The workspaces list will only contain currently-active experiments. Old ones drop out; that's the intended steady state.

---

## Environment Variables and Secrets

**Centralized `.dev.vars` management**:
- Single root `/lumenize/.dev.vars` file (gitignored) contains all secrets
- Test directories use symlinks to the root `.dev.vars`
- `/lumenize/.dev.vars.example` provides template for contributors
- `scripts/setup-symlinks.sh` automatically creates/verifies symlinks (runs via `postinstall` hook)
- **`.dev.vars` is resolved relative to the `wrangler.jsonc` location**, not the package root. Sub-directory wrangler configs (e.g., `test/e2e-email/wrangler.jsonc`) need their own `.dev.vars` symlink — `setup-symlinks.sh` handles this automatically for any directory containing `wrangler.jsonc`

---

## NPM Scripts

Key scripts available from the monorepo root:

- **`npm install`** - Installs dependencies and runs `postinstall` which symlinks `.dev.vars` and `cloudflare-test-env.d.ts` to all packages
- **`npm run types`** - Generates `worker-configuration.d.ts` for all packages with wrangler.jsonc. **Run this before writing code that uses `Env`** to ensure the type reflects current bindings.
- **`npm run type-check`** - Runs TypeScript checking on all packages (respects each package's tsconfig)
- **`npm test`** - Runs both code tests and doc example validation
- **`npm run test:code`** - Runs vitest on all packages
- **`npm run test:doc`** - Validates documentation code examples

---

## Cross-Platform Cloudflare Detection

When library code needs to access Cloudflare-specific APIs (like `env` from `cloudflare:workers`) but must also work in Node.js, Bun, and browsers, use top-level `await import()` in a try/catch:

```typescript
let cfEnv: { MY_VAR?: string } | null = null;
try {
  const mod = await import('cloudflare:workers');
  cfEnv = (mod as { env?: { MY_VAR?: string } }).env ?? null;
} catch {
  // Not in Cloudflare Workers runtime — expected in Node.js, Bun, browser
}
```

This resolves in Workers and silently fails elsewhere. No build-time flags or dynamic import hacks needed. See `@lumenize/debug` for the canonical example — it auto-detects `env.DEBUG` this way, so callers just use `debug('namespace')` in all environments.

---

## Coding Style

- **Type system**: TypeScript types for in-memory; TypeBox schemas for wire/persistence boundaries
- **Imports**: Use `'@lumenize/some-package'` for exported items; relative imports only for non-exported items within same package
- **IDs**: Use `crypto.randomUUID()` for unique IDs, `ulid-workers` for ordered IDs. Never use `Date.now()` in Cloudflare (clock doesn't advance during execution)
- **JSDoc examples**: 1-2 lines max; for longer examples, link to `/website/docs/...`
- **SQL naming**: PascalCase table names (`Subjects`, `RefreshTokens`), camelCase column names (`emailVerified`, `tokenHash`), index names as `idx_TableName_columnName`
- **SQL write costs**: Writes are 1,000x more expensive than reads — always use `WITHOUT ROWID` for TEXT/compound PKs, prefer compound indexes, keep hot-update columns out of indexes (see do-conventions skill section 16)

---

## Cloudflare Durable Objects

### Workers RPC Gotchas
- Synchronous DO methods become async over RPC — use `await expect(...).rejects.toThrow()` not `expect(() => ...).toThrow()`
- Private (`#`) methods silently return `undefined` over RPC stubs — always use public methods or HTTP endpoints for cross-DO communication
- `wrangler.jsonc` migrations only matter when deployed to Cloudflare's cloud; during local testing every run is a fresh deploy — no migration entries needed

### Wall-Clock Billing
DO is billed for elapsed time when: `await`ing I/O, using `setTimeout`/`setInterval`, or holding Workers RPC stubs (use `using` keyword). Avoid these to minimize costs.

### Storage
Always use synchronous storage (`ctx.storage.kv.*` or `ctx.storage.sql.*`), never legacy async API.

### Keep Methods Synchronous
Only `fetch()`, `webSocketMessage/Close/Error()`, and `alarm()` should be `async`. Never use `setTimeout`, `setInterval`, `waitUntil`, or `await` in business logic—breaks input/output gates and triggers wall-clock billing.

**Exception**: Methods that call APIs with no synchronous alternative (e.g., `crypto.subtle.*`) may be `async`. These complete in microseconds and don't open input gates long enough to cause practical interleaving, unlike network I/O or timers which can allow other requests to interleave and create race conditions.

### Cross-Boundary Typed Errors

Errors crossing DO ↔ Client (or DO ↔ DO via mesh) get preprocessed/postprocessed by `@lumenize/structured-clone`. The pipeline preserves `name`, `message`, `stack`, `cause`, and all custom own properties — but **`instanceof` doesn't survive cross-boundary**, because postprocess reconstructs via `(globalThis as any)[name] || Error` and non-built-in subclasses aren't on `globalThis`.

For structured signals across mesh boundaries: detect via `err.name === 'MyTypedError'` + property-presence check, not `err instanceof MyTypedError`. Canonical example: `apps/nebula/src/errors.ts` (`OntologyStaleError` + `isOntologyStaleError`). Full mechanics + registration-for-`instanceof` workaround in [website/docs/structured-clone/index.mdx](website/docs/structured-clone/index.mdx) § "Custom Error Classes".

**Refactoring throws → typed errors**: when consolidating a throw-based error path, enumerate *every* case the inner code can throw, not just the one you're typing. A catch that's too broad silently swallows unrelated failure modes — caught here during 5.3.3b when a Resources.transaction permission refactor accidentally swallowed `"Node X not found"` (a malformed-request error) as a permission failure. Either define one typed Error per case, or string-match the message and mark the site with a TODO.

### Fire-and-Forget Error Delivery
When a mesh handler delivers results via explicit callback (e.g., `lmz.call('GATEWAY', clientId, ctn().handleResult(result))`), wrap the entire handler body in try/catch. Uncaught exceptions are silently lost — the client never receives a response and `callCompleted` never becomes true.

### Worker Loader Cache
`env.LOADER.get(bundleId, ...)` caches by `bundleId` **per-Worker-project**, not per-DO. Multiple DO instances in the same Worker project share the loader cache, so identical `bundleId` values silently collide on the first cached entry. Scope `bundleId` by something globally unique (include tenant identifier or equivalent). The DO's cross-tenant guards don't intervene — the loader binding is shared infrastructure.

### Instance Variables
**Never use instance variables for mutable state**—DOs can be evicted anytime. Always use `ctx.storage.kv` or `ctx.storage.sql`.

Safe uses: statically initialized utilities, ephemeral caches (storage is source of truth), config set once in constructor.

```typescript
// Wrong: state won't survive eviction
#subscribers = new Set<string>();
subscribe(id: string) { this.#subscribers.add(id); }

// Right: state in storage
subscribe(id: string) {
  const subs = this.ctx.storage.kv.get('subscribers') ?? new Set();
  subs.add(id);
  this.ctx.storage.kv.put('subscribers', subs);
}
```

### LumenizeClient subclasses: callbacks fire during super()

`LumenizeClient`'s constructor calls `this.connect()` synchronously, which fires `onConnectionStateChange('connecting')` **before** the subclass's class-field declarations have run. A subclass tracking state across that callback can't use a `#` instance field — writing to one before its initializer runs throws "Cannot write to private field that has not been initialized." Use a **closure variable in the constructor** instead:

```typescript
constructor(config: NebulaClientConfig) {
  const { onConnectionStateChange: userCallback, ...baseConfig } = config;
  // Closure variable — captures cleanly across the synchronous super() callback.
  let prevConnectionState: ConnectionState | null = null;

  super({
    ...baseConfig,
    onConnectionStateChange: (state) => {
      if (prevConnectionState === 'reconnecting' && state === 'connected') {
        this.#onReconnect();  // method access via prototype — safe even during super()
      }
      prevConnectionState = state;
      userCallback?.(state);  // chain to any user-supplied callback
    },
  });
}
```

Methods on the prototype (including `#`-prefixed ones) ARE accessible during super() — but they must not touch class fields, which init later. Canonical example: `apps/nebula/src/nebula-client.ts` constructor.

---

## Package Structure

### Development Mode
```json
{
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "files": ["src/**/*"]
}
```

### Standard Package Files
- `package.json` - No build scripts, points to `src/`
- `src/index.ts` - Single export file that re-exports all public API
- `README.md` - Brief description with link to docs
- `LICENSE` - `MIT` for open-source packages, `BUSL-1.1` for Business Source License packages, or `UNLICENSED` for Nebula-related code (`packages/nebula-auth`, `apps/nebula`) — per legal guidance, these stay `UNLICENSED` until the Nebula platform ships externally. Use the exact SPDX identifier in `package.json`'s `license` field (e.g., `BUSL-1.1`, not `BSL-1.1` or `BSI-1.1`).
- `dist/` - Generated during publish only (gitignored)

### Cloudflare Worker Packages
- `tsconfig.json` - Extends root, includes `"types": ["vitest/globals"]`
- `vitest.config.js` - Workers project config
- `wrangler.jsonc` - DO bindings and migrations (compatibility_date: "2026-03-12" or later)
- `worker-configuration.d.ts` - Auto-generated via `npm run types`

### Using the Global `Env` Type
The `wrangler types` command generates a global `Env` interface in `worker-configuration.d.ts`. Always use this global `Env` type—never manually define `interface Env` or create custom env types like `MyEnv` or `AuthEnv`.

```typescript
// Good: use the global Env directly
export default {
  async fetch(request: Request, env: Env) { ... }
}

// Good: library functions accept Env
export function createRoutes(env: Env, options: Config) { ... }

// Bad: manual Env definition (will get out of sync)
interface Env { MY_DO: DurableObjectNamespace; }

// Bad: custom env type (unnecessary indirection)
type MyEnv = { MY_DO: DurableObjectNamespace; };
```

**When to use `object` instead of `Env`:** Only for code in shared packages (like `@lumenize/rpc` or `@lumenize/testing`) whose functions are called by *multiple* packages, each with a different generated `Env`. If the function lives in the same package as the `wrangler.jsonc` that defines the bindings it accesses, use `Env` — that's what `wrangler types` generated it for.

---

## Testing

### Philosophy
- **Integration testing** is primary for Worker/DO code (dogfood our own testing packages)
- **Unit testing** only for algorithmically tricky code and UI components
- **Coverage target**: Close to 100% branch coverage, minimum 80%

### Tests must be capable of failing

A test that passes regardless of the implementation's correctness is worse than no test — it gives false confidence. Before considering a test done, ask: **"If I gutted the code I'm testing, would this assertion fail?"** If the answer is no, the test is checking the wrong thing. Common ways tests pass for the wrong reason:

- **Harness fidelity loss**: a test path that JSON-stringifies (or otherwise serializes) values silently degrades rich types — `Date` becomes `string`, `Map`/`Set` become `{}` or `[]`, `BigInt` throws or vanishes, cyclic refs flatten. The validator may then accept the degraded value, and the test passes — but you've validated the round-trip degradation, not the code under test.
- **Mocks returning expected values**: a stub that always returns what the test expects passes regardless of real behavior.
- **Placeholder assertions**: `expect(true).toBe(true)`, `expect(arr.length).toBeGreaterThan(-1)`, anything the universe satisfies.
- **Snapshot tests generated from broken output**: the snapshot encodes the bug; the test confirms the bug.
- **Happy-path-only coverage**: failure modes are invisible because no test exercises them.
- **Cross-test cache pollution**: shared infrastructure caches (Worker Loader, module loader, prompt cache, etc.) survive across `it` blocks within a vitest file. A test that passes when run alone but fails in the full file may be relying on (or being saved by) cache state from another test. Conversely, a test passing when run *with the file* but failing alone hints the same way. The "isolation flips the result" signature is the diagnostic — when you see it, suspect shared cache state before debugging deeper.

When introducing a new test pattern (harness, fixture, mock layer), write a probe that *should fail* — feed in a value the path can't preserve, or a behavior the mock can't simulate — and verify it does fail. Then make it pass by fixing the path. If you can't write a failing probe, the test layer isn't testing anything.

### Test Organization
- `test/for-docs/` - Mini-app integration tests that both find bugs and validate documentation examples
- Pattern A (simple): `wrangler.jsonc` in package root, single vitest project
- Pattern B (multi-environment): `test/{environment}/wrangler.jsonc` for separate Node.js/Workers environments

### For-docs narrative tests: one big `it`

For-docs tests for narrative docs (Getting Started, walkthroughs — anything where Step 2 depends on Step 1) should be a single `it` block, not split per step. The doc itself is sequential — a user reading it runs Step 1, then Step 2 with the state Step 1 created. The test should mirror that.

```typescript
// Good: one it, sequential awaits, mirrors doc flow
it('Getting Started walkthrough', async () => {
  // Step 1: setup
  await supervisor.registerModuleSource(bundleId, moduleSource);
  // Step 2: use it
  const ok = await supervisor.parse(bundleId, ...);
  expect(ok.valid).toBe(true);
  // Step 3: error case (still on the same DO state)
  const bad = await supervisor.parse(bundleId, ...);
  expect(bad.valid).toBe(false);
});

// Bad: split per step — relies on shared DO state across `it` boundaries,
// which is a flakiness vector (cross-`it` ordering, missing awaits, etc.)
it('Step 1', async () => { ... });
it('Step 2', async () => { ... });
```

Canonical example: [packages/mesh/test/for-docs/getting-started/index.test.ts](packages/mesh/test/for-docs/getting-started/index.test.ts) — one `it`, full walkthrough.

Exceptions: API-reference-style for-docs tests (where each `it` covers an independent code block — `parse(unknownType)`, `parse(typeMismatch)`, etc.) stay split. The split-vs-single rule is "follow the doc's structure" — narrative docs → one `it`; reference docs → one per example.

### Use `vi.waitFor`, Never `setTimeout`
```typescript
// Good: Retries until condition met
await vi.waitFor(async () => {
  const status = await client.taskStatus;
  expect(status).toBe('complete');
});
```

### `vi.waitFor` timeout defaults

`vi.waitFor`'s default timeout is 1000 ms. Under parallel-test contention this is fragile — tests that pass in isolation flake when run alongside heavier files (the "isolation flips the result" signature). For test-app suites with auth/WebSocket setup, install a project-wide default via `setupFiles`:

```typescript
// test/setup.ts
import { vi } from 'vitest';
const orig = vi.waitFor;
vi.waitFor = ((fn, opts) =>
  orig(fn, { timeout: 5000, interval: 50, ...(opts ?? {}) })
) as typeof vi.waitFor;
```

```javascript
// vitest.config.js (within the project)
test: { setupFiles: ['./test/setup.ts'] }
```

Per-test `{ timeout }` overrides take precedence as expected. Canonical example: [apps/nebula/test/test-apps/baseline/test/setup.ts](apps/nebula/test/test-apps/baseline/test/setup.ts).

### Test initiators vs the public API

Test subclasses (e.g., `NebulaClientTest`) add `callXxx(...)` initiator methods that issue direct `this.lmz.call(...)`s from the client to a DO. These initiators **bypass the public API** — they don't populate client-side state like `#subscriptionRegistry`, `#pendingSubscribes`, or `#perTypeResolvers`. They're for testing the **server-side** path (Star, Galaxy, etc.) where the client is just a call source.

When the unit under test is **client-side state** (auto-resubscribe registry walks, pending-Promise correlation, resolver precedence, optimistic-state rollback, etc.), use the public API (`client.resources.subscribe(...)`, `client.resources.transaction(...)`, etc.) so client-side state is actually populated. Mixing the two in a single test produces "the subscribe ran on Star but the client doesn't know about it" failures that look like production bugs but are test-code bugs.

Also note: test-initiator methods on `NebulaClientTest` call `resetResults()` which **zeroes** capture fields including `resourceUpdateCount`, `lastResourceUpdate`, `lastResult`, etc. When asserting "did the count go up?", capture the baseline immediately before the action under test — not before the setup helpers that call test initiators run.

### App Test Pattern
For apps in `apps/`, use `test/test-apps/{name}/` with `instrumentDOProject`. See `apps/nebula/test/test-apps/README.md` for the checklist.

### E2E Tests with External Services
vitest-pool-workers tests can make real external `fetch()` calls and `new WebSocket()` connections to deployed Workers. This enables e2e tests where the code under test runs in-process (no deployment needed) but interacts with real external infrastructure. See `packages/auth/test/e2e-email/` for the canonical example: auth DO runs in vitest, sends real email via Resend, and a deployed `email-test` Worker receives it via Email Routing and pushes back over WebSocket.

---

## Documentation

### Philosophy
Documentation quality is ensured by custom Docusaurus tooling that guarantees all code examples are tested and working. The website at https://lumenize.com is the single source of truth.

### Style
- **Prefer inline links** over "See Also" or "Next Steps" sections at the end of files — sidebar ordering handles navigation and end-of-file link sections get stale without anyone noticing.

### Where Documentation Lives
- **Website docs**: `/website/docs/[package-name]/*.md` - All user-facing documentation. `.mdx` only with human approval (see Critical Rules).
- **Package README.md**: Minimal - name, tagline, link to website, key features, installation

### Code Example Validation

In `.md` / `.mdx` files, use the `@check-example` annotation to link code blocks to tests:

````markdown
```typescript @check-example('packages/rpc/test/for-docs/basic-usage.test.ts')
const result = await client.echo('Hello');
expect(result).toBe('DO echoed: Hello');
```
````

- Use `// ...` or `/* ... */` to skip boilerplate
- `@skip-check` is work-in-progress only (Phase 1 drafting) — convert to `@check-example` before publishing
- **Never use `@skip-check-approved`** — this annotation indicates human review and approval; only humans may add it

### Documentation Workflow
1. **Narrative First**: Draft in `.md` with `@skip-check`
2. **Make Examples Real**: Create `test/for-docs/` tests
3. **Validate**: Run `npm run check-examples`
4. **Build**: Run `npm run build` from `/website`

---

## MCP Servers

The project uses MCP (Model Context Protocol) servers to extend Claude's capabilities:
- **Cloudflare MCP** - Direct access to Cloudflare APIs for D1, KV, R2, Workers, and documentation search

---

## NPM Package Management

### Minimize External Dependencies
- Favor copy-paste with attribution over adding a dependency for <1000 SLOC.

### Before Installing
- Ask permission before installing any npm packages
- Verify permissive licenses (MIT, Apache-2.0, BSD-3-Clause, ISC)

### Package Selection
- Prefer smallest once-built footprint over fastest
- Prefer strongest Cloudflare Workers compatibility
- Never install npm packages globally

### Attribution
When copying liberally-licensed code (<1000 SLOC):
1. Add entry to `ATTRIBUTIONS.md` at repository root
2. Add comment above copied code in source file

---

## Publishing and Releases

All packages publish together with synchronized versions. Use `/release-workflow` for the process.

- **Development**: No build step. .ts source runs directly
- **Publish**: Scripts modify `package.json` to point to `dist/`, then revert
- **Breaking changes**: Favor over technical debt; increment major semver

---

## Reference Files

- `.claude/settings.json` - Claude Code permissions configuration
- `.dev.vars.example` - Template for environment variables
- `tasks/README.md` - Task management templates
