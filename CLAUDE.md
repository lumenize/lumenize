# Lumenize Project Context

## Overview

Lumenize is a collection of liberally licensed (MIT) and more restrictively licensed (BSI-1.1) open-source packages targeting Cloudflare's Durable Objects, which are part of Cloudflare's Workers edge computing platform. There are two complementary but distinct goals:
1. Provide a de✨light✨ful suite of packages that any developer can use to build scalable, high-quality, and maintainable products (MIT licensed).
2. Build the ultimate framework for vibe coding enterprise or B2B SaaS software products in a rapid and secure manner. It will be BSI-1.1 licensed, available to enterprises via commercial licenses, and offered as a platform as a service (PaaS) with generous free tier.

## Guiding Principles

- **Quality**:
  - Code quality achieved via high test coverage: Branch >80%, Statement >90%
  - Documentation quality achieved via custom Docusaurus tooling that ensures examples always work (see Documentation section)
- **Opinionated where it matters. Flexible where it counts**: For example, the LumenizeBase class is minimal but opinionated about best practices while also providing a flexible plugin system to extend functionality along with batteries-included plugins for common use cases.
- **No foot-guns**: Vibe coders are experts in their field, but not necessarily coding or operations. Lumenize makes it easy for both the product creator AND the LLM they are using to follow best practices.
- **Security**: Authentication and access control are built-in and on by default. You have to jump through hoops to avoid them.

---

## Critical Rules (Never Do This)

### Always
- Use **npm** only (never pnpm or yarn)
- Use **`#` prefix** for private class members (not TypeScript `private`)
- Use **synchronous storage** (`ctx.storage.kv.*` or `ctx.storage.sql.*`)
- Use **`wrangler types`** to auto-generate `worker-configuration.d.ts`
- Use **`compatibility_date: "2025-09-12"`** or later
- Use **root `.dev.vars`** (gitignored, auto-symlinked via postinstall)
- Put docs in **`/website/docs/`** `.mdx` files only

### Never
- **NEVER use pnpm or yarn** - only npm
- **NEVER use TypeScript `private`** - use `#` prefix instead
- **NEVER use async storage** - only `ctx.storage.kv.*` or `ctx.storage.sql.*` (not `ctx.storage.put/get`)
- **NEVER manually define Env interface** - `wrangler types` auto-generates it
- **NEVER use wrangler compatibility_date before "2025-09-12"**
- **NEVER commit secrets** - use root `.dev.vars` (gitignored)
- **NEVER create temp docs** - only `/website/docs/` `.mdx` files
- **NEVER put secrets, tokens, API keys, or credentials directly in source code files**

---

## Development Workflow

We use task files in the `tasks/` directory to track work:
- **`tasks/backlog.md`** - Small tasks and ideas for casual coding time
- **`tasks/[project-name].md`** - Active multi-phase projects with detailed plans
- **`tasks/decisions/`** - Research findings and technical decisions
- **`tasks/archive/`** - Completed projects for reference

### General Development Rules
- When we change our minds on the plan from learning of earlier steps, propose updates to the task file.
- Provide clear summaries of what was implemented after each step.
- Explain design decisions and trade-offs.
- After each step/phase, ask for code review before proceeding. Ask "Ready to proceed with [next step/phase]?" after completing each step or phase.
- API changes: Mark one test as `.only` to verify the new pattern works, then update remaining tests.

### Workflow Selection

**Ask: "Will this change how a developer uses this package?"**
- If YES → Use **docs-first workflow** (design API in MDX first)
- If NO → Use **implementation-first workflow**

---

## Environment Variables and Secrets

**Centralized `.dev.vars` management**:
- Single root `/lumenize/.dev.vars` file (gitignored) contains all secrets
- Test directories use symlinks to the root `.dev.vars`
- `/lumenize/.dev.vars.example` provides template for contributors
- `scripts/setup-symlinks.sh` automatically creates/verifies symlinks (runs via `postinstall` hook)

---

## Coding Style

### Private Members
```typescript
// Always use JavaScript private fields
class MyClass {
  #privateField = 'secret';
  #privateMethod() { return this.#privateField; }
}
```

### Type System: Rule of Wire Separation
- Use **TypeScript types** for transient in-memory constructs
- Use **TypeBox schemas** for any structure that crosses process, network, or persistence boundaries

### Imports
- If the item is exported from the package's `index.ts`, use `import { something } from '@lumenize/some-package'`
- Only use relative imports (`./some-file.ts`) for items NOT exported from `index.ts` within the same package

### ID Generation
```typescript
// For unique IDs in Workers/DOs
const id = crypto.randomUUID();

// For ordered IDs (sorting by creation time)
import { ulidFactory } from 'ulid-workers';
const ulid = ulidFactory({ monotonic: true });
const id = ulid();
```
**Never use `Date.now()` for IDs** - it doesn't advance during DO execution and causes collisions.

---

## Cloudflare Durable Objects

> **See CLOUDFLARE_DO_GUIDE.md** for detailed explanations.

### Storage APIs
- **ALWAYS use synchronous storage**: `ctx.storage.kv.*` or `ctx.storage.sql.*`
- **NEVER use legacy async API**: `ctx.storage.put()`, `ctx.storage.get()`, etc.

### Keep DO Methods Synchronous

Only these lifecycle entrypoint methods should be `async`:
- `fetch()` - HTTP request handler
- `webSocketMessage()`, `webSocketClose()`, `webSocketError()` - WebSocket handlers
- `alarm()` - Scheduled tasks

**Never use in DO business logic handlers**:
- `setTimeout()` / `setInterval()`
- `this.ctx.waitUntil()`
- Any `await` statements

**Why**: `async` breaks Cloudflare's input/output gate mechanism → race conditions and data corruption

### Instance Lifecycle

DOs can be evicted from memory at any time:
- **Fetch from storage** at start of each request/message handler
- **Persist changes** before returning from handler
- **Don't rely on in-memory state** persisting between requests

### Instance Variable Rule (CRITICAL)

**Never use instance variables for mutable application state** — always store that in `ctx.storage`.

Instance variables are only safe for:
- **Statically initialized utilities**: `#log = debug(this)('MyDO')` ✅
- **Ephemeral caches** where storage is the source of truth ✅
- **Configuration set once** in constructor/onStart ✅

**Wrong** (state won't survive eviction):
```typescript
#subscribers = new Set<string>();  // ❌ Mutable state as instance variable
```

**Right** (state in storage):
```typescript
#getSubscribers() { return this.ctx.storage.kv.get('subscribers') ?? new Set(); }
#saveSubscribers(s: Set<string>) { this.ctx.storage.kv.put('subscribers', s); }
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

---

## Testing

### Philosophy
- **Integration testing** is primary for Worker/DO code (dogfood our own testing packages)
- **Unit testing** only for algorithmically tricky code and UI components
- **Coverage target**: Close to 100% branch coverage, minimum 80%

### Test Organization
- `test/for-docs/` - Pedagogical tests for documentation validation
- Pattern A (simple): `wrangler.jsonc` in package root, single vitest project
- Pattern B (multi-environment): `test/{environment}/wrangler.jsonc` for separate Node.js/Workers environments

### API Refactoring Pattern
1. Mark **one test** as `.only` to verify the new pattern
2. Once working, update remaining tests
3. Remove `.only` before committing

### Prefer `vi.waitFor` Over `setTimeout`
```typescript
// Good: Retries until condition met
await vi.waitFor(async () => {
  const status = await client.taskStatus;
  expect(status).toBe('complete');
}, { timeout: 1000 });
```

---

## Documentation

### Philosophy
Documentation quality is ensured by custom Docusaurus tooling that guarantees all code examples are tested and working. The website at https://lumenize.com is the single source of truth.

### Style
- **Prefer inline links** over "See Also" or "Next Steps" sections at the end of files — sidebar ordering handles navigation and end-of-file link sections get stale without anyone noticing.

### Where Documentation Lives
- **Website docs**: `/website/docs/[package-name]/*.mdx` - All user-facing documentation
- **Package README.md**: Minimal - name, tagline, link to website, key features, installation

### Documentation Tooling
1. **`doc-testing`** - Literate programming plugin (code with markdown comments)
2. **`check-examples`** - Validates code blocks against passing tests

### Code Example Validation
```typescript
// In .mdx file:
```typescript @check-example('packages/rpc/test/for-docs/basic-usage.test.ts')
const result = await client.echo('Hello');
expect(result).toBe('DO echoed: Hello');
```

- Use `// ...` or `/* ... */` to skip boilerplate
- **Never use `@skip-check`** for executable code examples (only for bash commands, etc.)

### 5-Phase Documentation Workflow
1. **Phase 1**: Narrative & Pedagogy First (draft with `@skip-check`)
2. **Phase 2**: Make Examples Real (create `test/for-docs/` tests)
3. **Phase 3**: Fast Validation Loop (`npm run check-examples`)
4. **Phase 4**: API Documentation (TypeDoc)
5. **Phase 5**: Full Build & Polish (`npm run build`)

See `/documentation-workflow` command for details.

---

## NPM Package Management

### Before Installing
- Ask permission before installing any npm packages
- Check if functionality can be implemented in <100 SLOC
- Use only well-known, well-maintained packages
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

### Development vs. Production Builds
- **Development**: No build step - source runs directly via vitest's transpilation
- **Publish**: Scripts modify `package.json` to point to `dist/`, then revert after publish

### Release Process
All scripts are in `/scripts/`:
- `release-dry-run.sh` - Always run first
- `release.sh` - Actual publish
- `build-packages.sh` - TypeScript compilation
- `prepare-for-publish.sh` - Modify package.json for publish
- `restore-dev-mode.sh` - Revert to dev mode

### Synchronized Versioning
- All packages published together with the same version number
- Prevents version drift and dependency mismatches
- Favor breaking changes over technical debt (increment major semver)

---

## Reference Files

- `CLOUDFLARE_DO_GUIDE.md` - Detailed Durable Objects concepts
- `DOCUMENTATION-WORKFLOW.md` - Full documentation process
- `tasks/README.md` - Task management template and usage
- `.dev.vars.example` - Template for environment variables
