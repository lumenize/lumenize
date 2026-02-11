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
- **No foot-guns**: Vibe coders are experts in their field, but not necessarily coding or operations. Lumenize makes it easy for both the product creator AND the LLM they are using to follow best practices. For example, Durable Objects were designed to make parallel programming safer if you follow certain patterns, but will happily allow you to violate those patterns without warning. Even when Lumenize allows you to break the rules, you are loudly warned of the risks.
- **Security**: Authentication and access control are built-in and on by default. You have to jump through hoops to avoid them. At the same time, they are flexible and can be adapted to any context.

## Development Workflow Instructions

We use task files in the `tasks/` directory to track work:
- **`tasks/backlog.md`** - Small tasks and ideas for casual coding time
- **`tasks/[project-name].md`** - Active multi-phase projects with detailed plans
- **`tasks/decisions/`** - Research findings and technical decisions
- **`tasks/archive/`** - Completed projects for reference

When starting a new project, create a task file with phases and steps. See `tasks/README.md` for template and usage.

### General Development Rules
- When we change our minds on the plan from learning of earlier steps, propose updates to the task file.
- Provide clear summaries of what was implemented after each step.
- Explain design decisions and trade-offs.
- After each step/phase, ask for code review before proceeding. Ask "Ready to proceed with [next step/phase]?" after completing each step or phase.
- API changes: Mark one test as `.only` to verify the new pattern works, then update remaining tests.
- **CRITICAL SECURITY: NEVER put secrets, tokens, API keys, or credentials directly in source code files (including wrangler.jsonc, tsconfig.json, etc.). Always use `.dev.vars` files (which are gitignored) or environment variables. Tokens in wrangler.jsonc `vars` section will be committed to git.**

## How we do things around here

### Environment Variables and Secrets
**Centralized `.dev.vars` management**:
- Single root `/lumenize/.dev.vars` file (gitignored) contains all secrets
- Test directories use symlinks to the root `.dev.vars`
- `/lumenize/.dev.vars.example` provides template for contributors
- `scripts/setup-symlinks.sh` automatically creates/verifies symlinks (runs via `postinstall` hook)
- Run manually anytime: `./scripts/setup-symlinks.sh`

**When adding new test environments**:
1. Add symlink to `scripts/setup-symlinks.sh` SYMLINKS array
2. Add any new variables to root `.dev.vars` and `.dev.vars.example`
3. Run `./scripts/setup-symlinks.sh` to verify setup

### Tools
- Use `npm`. Never `pnpm` or `yarn`.
- If the library is installed never use `npx` because it requires me to approve it.

### Coding style
- Never use Typescript keyword `private`. Rather use JavaScript equivalent of starting the identifier with "#".
- **Always use synchronous storage operations** (`ctx.storage.kv.*` and `ctx.storage.sql.*`) instead of the legacy async API (`ctx.storage.get/put/delete`). This is Cloudflare's recommended pattern going forward and requires `compatibility_date: "2025-09-12"` or later.
- Storage operations are synchronous because SQLite is embedded - no async needed, no performance penalty.

### Rule of Wire Separation for Types:
- Use TypeScript types for transient in-memory constructs.
- Use TypeBox schemas for any structure that can cross a process, network, or persistence boundary.

### No build during development
**Principle**: Source code runs directly without a build step during development. This eliminates build cache issues, simplifies debugging, and provides immediate feedback. Build happens only during publish (see Publishing and Releases section).

**Implementation varies by runtime**:
- **Cloudflare Workers/DOs**: TypeScript runs directly via vitest's built-in transpilation
- **Node.js tooling**: JavaScript with JSDoc for type hints (no TypeScript compilation needed)

**Why this matters**: Build steps create recurring "doom loops" where changes don't appear to work, leading to investigations of build caches, symlinks, dist/ vs src/ confusion, and wasted time. JavaScript with JSDoc for tooling eliminates this entirely while preserving IDE type hints. TypeScript for Cloudflare code works because vitest-pool-workers automatically compiles (using WebPack under the covers).

### Imports
- If the item you are importing is exported from the source package's index.ts, use `import { something } from '@lumenize/some-other-package'`
- Only when importing an item that's from the same npm package.json workspace, and it is not an export from the package's index.ts file, should we use `import { something } from './some-other-file.ts'`

### Package Structure Standards

#### Package.json patterns
**Core principles**:
- `"type": "module"` - Always use ES modules
- Point to source files: `"main": "src/index.ts"`, `"types": "src/index.ts"` (modified during publish - see Publishing and Releases)
- No build scripts in package.json (builds happen via centralized scripts)
- Intra-monorepo dependencies use `"*"` as version
- `"license": "MIT"` or `"license": "BSI-1.1"` for packages. When in doubt ask.
- `files` array: `["src/**/*"]` (modified during publish - see Publishing and Releases)

**For Cloudflare Worker packages**:
- `"main": "src/index.ts"` and `"types": "src/index.ts"` (development mode)
- `"exports"` field should also point to src during development
- Include `"types": "wrangler types"` script for generating worker-configuration.d.ts
- peerDependencies: `@cloudflare/vitest-pool-workers` and `vitest`
- **Always use `"wrangler": "^4.38.0"` or later** - Required for synchronous storage API support (compatibility_date: "2025-09-12")

**For Node.js tooling packages**:
- `"main": "src/index.js"` (JavaScript with JSDoc)
- No TypeScript types or build scripts

#### Standard package files
**All packages**:
- `package.json` - No build scripts, points to `src/` (see Publishing and Releases for publish-time modifications)
- `src/index.{ts,js}` - Single export file that re-exports all public API
- `README.md` - Brief package description with link to docs (see Documentation section)
- `LICENSE` - MIT license file (copy from another package)
- `dist/` - Generated during publish, gitignored (see Publishing and Releases)

**Cloudflare Worker packages**:
- `tsconfig.json` - Extends root (`../../tsconfig.json`), includes `"types": ["vitest/globals"]`
- `tsconfig.build.json` - Build-time config (used during publish)
- `vitest.config.js` - Workers project config (see Testing section below for patterns)
- `wrangler.jsonc` - DO bindings and migrations (location varies by pattern - see Testing section)
- `worker-configuration.d.ts` - **Auto-generated only**. Run `npm run types` (calls `wrangler types`) whenever wrangler.jsonc changes
- `test/` - Test files (organization varies by pattern - see Testing section)

**Node.js tooling packages**:
- JavaScript source files with JSDoc type annotations
- No tsconfig.json or build configuration

### Testing

#### Philosophy and Approach
- **Unit testing** is only for algorithmically tricky code and UI components that can be unit tested without extensive mocking
- **Integration testing** is primary for Worker/DO code (dogfood our own testing packages)
- **Coverage target**: close to 100% branch coverage, minimum 80%
- Only exception conditions can be left uncovered

#### Testing Principles
- **Tests enable refactoring, not prevent it**: Remove functionality rather than maintain tests for deprecated code
- **No test ossification**: Don't make tests pass at all costs after a refactor if the behavior should be deprecated
- **No technical debt to avoid test updates**: Never create aliases just to avoid modifying tests - fix them properly
- **Single test iteration during API changes**: When refactoring a package API, mark one test as `.only` to get the new pattern working, then update others
- **Leave working tests alone**: When documentation examples need validation, create separate minimal test projects (e.g., `test/for-docs/`) rather than modifying existing integration tests. Existing tests serve their purpose - new minimal tests serve documentation validation.

#### Test Organization Patterns

Two patterns are in use for organizing test files in Cloudflare Worker packages:

**Pattern A - Simple single-environment packages** (e.g., `rpc`, `testing`):
- `wrangler.jsonc` - In package root
- `test/test-worker-and-dos.ts` - Test worker and test DOs in root test/ directory
- `vitest.config.js` - Single project configuration using `defineWorkersProject()`

**Pattern B - Multi-environment packages** (e.g., `utils`, `proxy-fetch`):
- `test/{environment}/wrangler.jsonc` - Wrangler configs in test subdirectories (e.g., `test/integration/`, `test/do/`, `test/queue/`)
- `test/{environment}/test-worker-and-dos.ts` - Test workers in subdirectories
- `vitest.config.js` - Multi-project configuration with separate Node.js and Workers environments
- Example environments: `unit` (Node.js), `integration` (Workers), `do` (DO variant), `queue` (Queue variant)

**Use Pattern A for new packages** unless you need to separate unit tests (Node.js environment) from integration tests (Workers environment), or test multiple deployment variants.

#### Vitest Configuration

**Pattern A - Single project configuration**:
```javascript
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    testTimeout: 2000, // 2 second global timeout
    globals: true,
    poolOptions: {
      workers: {
        isolatedStorage: false,  // Must be false for WebSocket support
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ['text', 'json', 'html'],
      skipFull: false,
      all: false,
    },
  },
});
```

**Pattern B - Multi-project configuration**:
```javascript
import { defineConfig } from 'vitest/config';
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    projects: [
      // Unit tests - Node environment
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      // Integration tests - Workers environment
      defineWorkersProject({
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 2000,
          globals: true,
          poolOptions: {
            workers: {
              isolatedStorage: false,  // Must be false for WebSocket support
              wrangler: { configPath: './test/integration/wrangler.jsonc' },
            },
          },
        },
      }),
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      skipFull: false,
      all: false,
    },
  },
});
```

#### Wrangler Configuration for Tests

**Location**: 
- Pattern A: `wrangler.jsonc` in package root
- Pattern B: `test/{environment}/wrangler.jsonc` in test subdirectories

**Required fields**:
- `name` - Descriptive name matching the package/test purpose
- `main` - Path to test worker (e.g., `"test/test-worker-and-dos.ts"`)
- **`"compatibility_date": "2025-09-12"` or later** - Required for synchronous storage (`ctx.storage.sql.*` and `ctx.storage.kv.*`)
- `durable_objects.bindings` - Array with UPPERCASE binding names
- `migrations` - Array with `new_sqlite_classes` for all test DOs (incremental tags: `"v1"`, `"v2"`, etc.)

**Example**:
```jsonc
{
  "name": "lumenize-rpc",
  "main": "test/test-worker-and-dos.ts",
  "compatibility_date": "2025-09-12",
  "durable_objects": {
    "bindings": [
      { "name": "EXAMPLE_DO", "class_name": "ExampleDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ExampleDO"] }
  ]
}
```

### Documentation

#### Philosophy
Documentation quality is ensured by custom Docusaurus tooling that guarantees all code examples are tested and working. The website at https://lumenize.com is the single source of truth for user-facing documentation.

#### Documentation Tooling

**`check-examples` - Code Example Validation Plugin** (`tooling/check-examples`)
- Scans hand-written `.mdx` files for code blocks with `@check-example` annotations
- Each annotation includes a path to a passing test file
- Fails the build if documentation code doesn't match the test code
- Supports `// ...` wildcards in code blocks to skip boilerplate (advances to next matching line)
- `@skip-check` annotation available but **only use for non-executable examples** (like install commands)
- **Never use `@skip-check` for pedagogical examples** - creates risk of docs/code divergence
- Instead, create carefully-crafted tests in `test/for-docs/` that demonstrate concepts with minimum noise and maximum teaching value

**Deprecated tooling** (still in use by some older packages, do not use for new work):
- `doc-testing` — Generated `.mdx` from test files with embedded markdown in block comments. Replaced by hand-written `.mdx` with `check-examples` validation. Some older packages (rpc, testing, mesh/services) still have generated files marked with `generated_by: doc-testing` frontmatter.
- TypeDoc — Auto-generated API reference from JSDoc. Replaced by hand-written API reference pages (see `website/docs/auth/api-reference.mdx` for the pattern). Still configured for older packages (rpc, utils, testing, fetch, structured-clone) in `docusaurus.config.ts`.

#### Where Documentation Lives

**Website Documentation (`/website/docs/`)**:
- **All user-facing documentation goes here** - Our Docusaurus site at https://lumenize.com
- Create/update `.mdx` files in `/website/docs/[package-name]/`
- Add new files to `/website/sidebars.ts` for navigation
- Use proper frontmatter with `title` and `description`
- Link between pages with relative links (e.g., `[CORS Support](/docs/routing/cors-support)`)
- Large features should be separate files linked from main docs

**Package README.md Files**:
- Keep minimal - just name, tagline, link to website, key features, and installation
- Use the de✨light✨ful branding in the description
- Standard structure:
```markdown
# @lumenize/package-name

A de✨light✨ful [one-line description].

For complete documentation, visit **[https://lumenize.com/docs/package-name](https://lumenize.com/docs/package-name)**

## Features

- **Feature 1**: Brief description
- **Feature 2**: Brief description
- **Feature 3**: Brief description

## Installation

\`\`\`bash
npm install @lumenize/package-name
# or for dev dependencies:
npm install --save-dev @lumenize/package-name
\`\`\`
```

#### What NOT to Include in Documentation

- **Never create temporary docs** in package directories (`IMPLEMENTATION.md`, `FEATURE_GUIDE.md`, etc.)
- **No "See Also" or "Next Steps" sections** at the end of files — use inline links instead. The sidebar ordering handles navigation and end-of-file link sections get stale without anyone noticing.
- **Exclude internal communication content**:
  - Testing details (unless user-facing testing utilities)
  - Compatibility matrices
  - Future enhancements
  - Success reports or progress updates
  - Anything that sounds like reporting to maintainers
- Focus on user-facing content: Overview, Basic Usage, API examples, Advanced Use Cases, Migration Guides, Type Definitions, Security Considerations

#### Documentation Validation Tests

When writing documentation that needs code validation:
1. Create minimal test projects in `test/for-docs/` directory
2. Don't modify existing integration tests - they serve a different purpose
3. Make these tests pedagogical - clear, minimal, teaching-focused
4. Reference these tests in `.mdx` files using `@check-example` annotations
5. The `check-examples` plugin will verify documentation matches working tests

### Publishing and Releases

#### Development vs. Production Builds
**During development**:
- No build step required - source code runs directly via vitest's transpilation
- `package.json` points to source: `"main": "src/index.ts"`
- `files` array includes source: `["src/**/*"]`
- Intra-package dependencies use `"*"` version (npm workspaces)
- Fast iteration, no build cache issues

**During publish** (automated by scripts):
1. `build-packages.sh` - Compiles TypeScript to `dist/` using `tsconfig.build.json`
2. `prepare-for-publish.sh` - Temporarily modifies package.json files:
   - Changes `"main": "src/index.ts"` → `"main": "dist/index.js"`
   - Changes `"types": "src/index.ts"` → `"types": "dist/index.d.ts"`
   - Changes `"files": ["src/**/*"]` → `"files": ["dist/**/*"]`
   - Updates `exports` field to point to dist/
3. Lerna publishes all packages
4. `restore-dev-mode.sh` - Reverts package.json files back to src/ (preserving version bumps)

**Files generated during publish**:
- `dist/` - Compiled JavaScript and TypeScript declarations (gitignored but present after builds)

#### Synchronized Versioning
- **All packages published together** in a single batch
- All packages share the same version number
- Prevents version drift and dependency mismatches
- Enables breaking changes across multiple packages in single commit

#### Versioning and Breaking Changes
- **Pre-publication packages**: Don't worry about backward compatibility when refactoring unpublished APIs
- **Published packages**: Favor backward breaking changes over living with bad design decisions
  - For **internal dependencies** (not exported from index.ts): Never create aliases or backward-compatible signatures just to avoid breaking changes
  - For **exported APIs**: Still favor breaking changes over technical debt - everything is versioned
- Breaking changes increment major semver
- **Important**: When making breaking changes, warn the maintainer to flag the next release for major version increment

### NPM packages
- **Ask permission before installing** any npm packages
- Avoid npm package dependencies if possible. If a package is under 100 SLOC (source lines of code), I'm more inclined to copy the code with proper attribution than to install the package. If a package is under 1000 SLOC but I only need a subset of its functionality, I'm more inclined to copy the relevant code and modify it with proper attribution than to install the package. See Attributions section below on how to attribute such code.
- Use only well-known, well-maintained packages with permissive licenses (MIT, Apache-2.0, BSD-3-Clause, ISC).
- Favor packages with the smallest once-built footprint over the fastest.
- Favor packages with the strongest compatibility with Cloudflare Workers.
- Never install an npm package globally.

### Code Attribution and Inspiration

#### When Copying Code
When copying liberally-licensed code (typically under 1000 SLOC), we use a two-part attribution system:

**1. Add entry to `ATTRIBUTIONS.md` at repository root:**
```markdown
## [Package/Project Name]
- **Source**: [URL to original code]
- **License**: [License Name] ([License URL])
- **Used In**: `packages/rpc/src/file.ts` (lines X-Y)
- **Purpose**: [Brief description of what the code does]
- **Date Added**: [YYYY-MM-DD]
```

**2. Add comment above copied code in source file:**
```typescript
// Adapted from [Project Name] by [Author]
// Source: [URL to specific file/code]
// License: [License Name]
```

All copied code must be attributed in both places before merging.

#### When Inspired by Code
If implementing a capability inspired by external code (similar API but not copied):
- Add inline comments identifying the source and nature of inspiration
- Example: "This implements an API similar to PartyKit's routePartyRequest but with adaptations for Cloudflare's routing model"
- No `ATTRIBUTIONS.md` entry needed for inspiration (only for copied code)

## Cloudflare Durable Objects - Critical Rules

> **See CLOUDFLARE_DO_GUIDE.md** for detailed explanations of how Durable Objects work.

### Storage APIs
- ✅ **ALWAYS use synchronous storage**: `ctx.storage.kv.*` or `ctx.storage.sql.*`
- ❌ **NEVER use legacy async API**: `ctx.storage.put()`, `ctx.storage.get()`, etc.

### Synchronous Methods (CRITICAL)
**Keep all DO methods synchronous** (no `async`/`await`) to maintain consistency guarantees.

**Exceptions** (these MUST be async):
- `fetch()` - HTTP request handler
- `webSocketMessage()`, `webSocketClose()`, `webSocketError()` - WebSocket handlers
- `alarm()` - Scheduled tasks
- Code wrapped in `ctx.waitUntil()` - Background work

**Why**: `async` breaks Cloudflare's input/output gate mechanism → race conditions and data corruption

**Also forbidden** (outside `ctx.waitUntil()`):
- `setTimeout` - breaks input/output gates
- `setInterval` - breaks input/output gates

### Instance Lifecycle
DOs can be evicted from memory at any time. Design accordingly:
- **Fetch from storage** at start of each request/message handler
- **Persist changes** before returning from handler
- **Don't rely on in-memory state** persisting between requests

### Instance Variable Rule (CRITICAL)

**Never use instance variables for mutable application state** — always store that in `ctx.storage`.

Instance variables are only safe for:
- **Statically initialized utilities**: `#log = debug('MyDO')` ✅
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
