# Lumenize Project Context

Packages for Cloudflare Durable Objects. Users ("vibe coders") are domain experts but not necessarily experienced developers—prioritize clear patterns and guard against footguns. Security is on by default. Test coverage targets: Branch >80%, Statement >90%.

---

## Critical Rules

- **npm only** - never use pnpm or yarn
- **`#` prefix for private members** - never use TypeScript `private` keyword
- **Synchronous storage only** - use `ctx.storage.kv.*` or `ctx.storage.sql.*`, never legacy async API (`ctx.storage.put/get`)
- **Auto-generate Env interface** - run `wrangler types`, never manually define it
- **`compatibility_date: "2025-09-12"`** or later in wrangler.jsonc
- **Secrets in root `.dev.vars`** - gitignored, auto-symlinked via postinstall; never commit secrets or put them in source code
- **Docs in `/website/docs/`** - only `.mdx` files, never create temp docs elsewhere

---

## Claude Code Configuration

- **`.claude/settings.json`** - Pre-approved permissions for common operations (committed to git)
- **`.claude/settings.local.json`** - Personal overrides (gitignored, takes precedence)

---

## Development Workflow

Task files live in `tasks/`. Use `/task-management` to choose docs-first or implementation-first workflow.

### Related Commands
- `/task-management` - Docs-first vs implementation-first workflows
- `/refactor-efficiently` - Incremental API changes with `.only` pattern
- `/release-workflow` - Publish packages to npm

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
- **`npm run types`** - Generates `worker-configuration.d.ts` for all packages with wrangler.jsonc
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

---

## Cloudflare Durable Objects

### Wall-Clock Billing
DO is billed for elapsed time when: `await`ing I/O, using `setTimeout`/`setInterval`, or holding Workers RPC stubs (use `using` keyword). Avoid these to minimize costs.

### Storage
Always use synchronous storage (`ctx.storage.kv.*` or `ctx.storage.sql.*`), never legacy async API.

### Keep Methods Synchronous
Only `fetch()`, `webSocketMessage/Close/Error()`, and `alarm()` should be `async`. Never use `setTimeout`, `setInterval`, `waitUntil`, or `await` in business logic—breaks input/output gates and triggers wall-clock billing.

**Exception**: Methods that call APIs with no synchronous alternative (e.g., `crypto.subtle.*`) may be `async`. These complete in microseconds and don't open input gates long enough to cause practical interleaving, unlike network I/O or timers which can allow other requests to interleave and create race conditions.

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
- `LICENSE` - MIT or BSI-1.1
- `dist/` - Generated during publish only (gitignored)

### Cloudflare Worker Packages
- `tsconfig.json` - Extends root, includes `"types": ["vitest/globals"]`
- `vitest.config.js` - Workers project config
- `wrangler.jsonc` - DO bindings and migrations (compatibility_date: "2025-09-12" or later)
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

For library code that needs to work across packages (where each package has its own `Env`), use `object` as the parameter type and cast internally when accessing dynamic properties.

---

## Testing

### Philosophy
- **Integration testing** is primary for Worker/DO code (dogfood our own testing packages)
- **Unit testing** only for algorithmically tricky code and UI components
- **Coverage target**: Close to 100% branch coverage, minimum 80%

### Test Organization
- `test/for-docs/` - Mini-app integration tests that both find bugs and validate documentation examples
- Pattern A (simple): `wrangler.jsonc` in package root, single vitest project
- Pattern B (multi-environment): `test/{environment}/wrangler.jsonc` for separate Node.js/Workers environments

### Use `vi.waitFor`, Never `setTimeout`
```typescript
// Good: Retries until condition met
await vi.waitFor(async () => {
  const status = await client.taskStatus;
  expect(status).toBe('complete');
});
```

### E2E Tests with External Services
vitest-pool-workers tests can make real external `fetch()` calls and `new WebSocket()` connections to deployed Workers. This enables e2e tests where the code under test runs in-process (no deployment needed) but interacts with real external infrastructure. See `packages/auth/test/e2e-email/` for the canonical example: auth DO runs in vitest, sends real email via Resend, and a deployed `email-test` Worker receives it via Email Routing and pushes back over WebSocket.

---

## Documentation

### Philosophy
Documentation quality is ensured by custom Docusaurus tooling that guarantees all code examples are tested and working. The website at https://lumenize.com is the single source of truth.

### Style
- **Prefer inline links** over "See Also" or "Next Steps" sections at the end of files — sidebar ordering handles navigation and end-of-file link sections get stale without anyone noticing.

### Where Documentation Lives
- **Website docs**: `/website/docs/[package-name]/*.mdx` - All user-facing documentation
- **Package README.md**: Minimal - name, tagline, link to website, key features, installation

### Code Example Validation

In `.mdx` files, use the `@check-example` annotation to link code blocks to tests:

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
1. **Narrative First**: Draft in `.mdx` with `@skip-check`
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
