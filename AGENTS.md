# Lumenize Project Context

## Overview
Lumenize is a collection of liberally licensed (MIT) and more restrictively licensed (BSI-1.1) open-source packages targeting Cloudflare's Durable Objects, which are part of Cloudflare's Workers edge computing platform. There are two complementary but distinct goals:
1. Provide a *de*light*ful*suite of packages that any developer can use to build scalable, high-quality, and maintainable products (MIT licensed).
2. Build the ultimate framework for vibe coding enterprise or B2B SaaS software products in a rapid and secure manner. It will be BSI-1.1 licensed, available to enterprises via commercial licenses, and offered as a platform as a service (PaaS) with generous free tier.

## Guiding Principles
- **Quality**: Highest code and documentation quality achieved with high test coverage and doc testing, which assures that the examples in the documentation always work.
- **Opinionated where it matters. Flexible where it counts**: For example, the LumenizeBase class is minimal but opinionated about best practices while also providing a flexible plugin system to extend functionality along with batteries-included plugins for common use cases.
- **No foot-guns**: Vibe coders are experts in their field, but not necessarily coding or operations. Lumenize makes it easy for both the product creator AND the LLM they are using to follow best practices. For example, Durable Objects were designed to make parallel programming safer if you follow certain patterns, but will happily allow you to violate those patterns without warning. Even when Lumenize allows you to break the rules, you are loudly warned of the risks.
- **Security**: Authentication and access control are built-in and on by default. You have to jump through hoops to avoid them. At the same time, they are flexible and can be adapted to any context.

## Development Workflow Instructions

We use WIP.md (WIP stands for Work in Progress) to create multi-step plans and track progress on them. The contents are broken down into phases and steps or for smaller efforts, just steps.

### General Development Rules
- When we change our minds on the plan from learning of earlier steps, propose updates to the plan in WIP.md.
- Provide clear summaries of what was implemented after each step.
- Explain design decisions and trade-offs.
- After each step/phase, ask for code review before proceeding. Ask "Ready to proceed with [next step/phase]?" after completing each step or phase.
- We are often refactoring the API of a package before the package has ever been published. When this is the case, do not worry about backward compatibility.
- When we change the API of a package, mark one test as .only and get the new calling pattern working rather than edit all tests every time we make a change to the API like this. Once that one test passes, we can refactor the other tests.

## How we do things around here

### Tools
- Use `npm`. Never `pnpm` or `yarn`.
- If the library is installed never use `npx` because it requires me to approve it.
- Use `run_in_terminal` tool instead of terminal commands that require user approval (zsh, etc.).

### Coding style
- Never use Typescript keyword `private`. Rather use JavaScript equivalent of starting the identifier with "#".

### Rule of Wire Separation for Types:
- Use TypeScript types for transient in-memory constructs.
- Use TypeBox schemas for any structure that can cross a process, network, or persistence boundary.

### No build except on publish
All code is written in TypeScript, but no build step is used during development. Intra-package dependencies are managed using npm workspaces. This means that we can run and debug code directly from the source without needing to build first. The only time a build is done is when publishing using Lerna. This happens only after all builds, code tests, and doc tests pass.

### Imports
- If the item you are importing is exported from the source package's index.ts, use `import { something } from '@lumenize/some-other-package'`
- Only when importing an item that's from the same npm package.json workspace, and it is not an export from the package's index.ts file, should we use `import { something } from './some-other-file.ts'`

### Package Structure Standards

#### Package.json patterns
Every package should follow these patterns:
- `"type": "module"` - Always use ES modules
- `"main": "src/index.ts"` and `"types": "src/index.ts"` - Point to source files, not dist
- `exports` field should point to `"./src/index.ts"` for both import and types
- No build scripts in package.json (build only happens on publish via Lerna)
- **Always include** `"types": "wrangler types"` script in package.json for generating worker-configuration.d.ts
- Intra-monorepo dependencies use `"*"` as the version (e.g., `"@lumenize/utils": "*"`)
- peerDependencies for test tooling: `@cloudflare/vitest-pool-workers` and `vitest`
- `"license": "MIT"` for all open-source packages
- `files` array should include `["src/**/*"]` to publish source files

#### Standard package files
Every package should have:
- `package.json` - No build script, MIT license, follows patterns above
- `tsconfig.json` - Extends root (`../../tsconfig.json`), includes `"types": ["vitest/globals"]`
- `vitest.config.js` - Workers project config (see below)
- `wrangler.jsonc` - DO bindings and migrations for test DOs
- `worker-configuration.d.ts` - **NEVER hand-generate this file**. Always generate it by running `npm run types` (which calls `wrangler types`). This file should be regenerated whenever wrangler.jsonc changes.
- `src/index.ts` - Single export file that re-exports all public API
- `test/test-worker-and-dos.ts` - Test worker and test DOs wrapped with `lumenizeRpcDo`
- `README.md` - Brief package description with link to docs (see README.md pattern below)
- `LICENSE` - MIT license file (copy from another package)

#### README.md pattern
README.md files should follow this standard structure:
```markdown
# @lumenize/package-name

A *de*light*ful* [one-line description].

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

**Key principles:**
- Keep it minimal - just package name, tagline, link to docs, key features, and installation
- No detailed documentation - the website at https://lumenize.com is the single source of truth
- No API documentation, examples, or usage guides in README.md
- Use the *de*light*ful* branding in the description
- Link directly to the specific docs page for that package

#### Vitest configuration standards
All vitest.config.js files should:
- Use `defineWorkersProject` from `@cloudflare/vitest-pool-workers/config`
- Set `testTimeout: 2000` (2 second global timeout)
- Set `globals: true` for global test functions
- Configure `poolOptions.workers`:
  - `isolatedStorage: false` - Required for WebSocket support (add comment: "Must be false for now to use websockets. Have each test create a new DO instance to avoid state sharing.")
  - `wrangler: { configPath: './wrangler.jsonc' }`
- Coverage configuration:
  - `provider: "istanbul"`
  - `reporter: ['text', 'json', 'html']`
  - `include: ['**/src/**', '**/test/test-worker-and-dos.ts']` - Source and test worker
  - `exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.config.*', '**/scratch/**', '**/test/**/*.test.ts']`
  - `skipFull: false` and `all: false`

#### Wrangler configuration standards
All wrangler.jsonc files should:
- Use a descriptive `name` (e.g., `"lumenize-rpc"`, `"lumenize-testing"`)
- Set `main` to test worker: `"test/test-worker-and-dos.ts"`
- Use recent `compatibility_date` (YYYY-MM-DD format)
- Define test DOs in `durable_objects.bindings` with uppercase binding names
- Include `migrations` array with `new_sqlite_classes` for all test DOs
- Use incremental tags: `"v1"`, `"v2"`, etc.

### Testing
- Unit testing is only used for algorithmically tricky code and ui components that can be unit tested without extensive mocking.
- Integration testing is our primary way to get coverage of code that runs in a Worker or DO. Since @lumenize/testing is an integration test runner for DOs, we should dogfood that unless there is a good reason not to.
- We are shooting for close to 100% branch coverage and will never accept less than 80% branch coverage. Only branches that are unlikely exception conditions can be left uncovered.
- I'm just as likely to remove functionality after a refactor than I am to upgrade a test to cover less useful code with tests.
- You should not attempt to make the tests pass at all costs especially after a refactor. We do not want tests to be ossification of behavior we should deprecate.
- Never create an alias just so we don't have to modify a bunch of tests. Fixing the tests now is much better than living with that technical debt.

### Documentation
- **All user-facing documentation goes directly into `/website/docs/`** - This is our Docusaurus-based documentation site at https://lumenize.com
- **Never create temporary documentation files** in package directories (like `IMPLEMENTATION.md`, `FEATURE_GUIDE.md`, etc.)
- When writing documentation:
  - Go straight to creating/updating `.mdx` files in `/website/docs/[package-name]/`
  - **Exclude content meant for internal communication** - Remove sections like "Testing", "Compatibility", "Future Enhancements", success reports, or anything that sounds like you're reporting progress to me
  - Focus on user-facing content: Overview, Basic Usage, API examples, Advanced Use Cases, Migration Guides, Type Definitions, and Security Considerations
  - Use proper Docusaurus frontmatter with `title` and `description`
  - Link between related documentation pages using relative links (e.g., `[CORS Support](/docs/utils/cors-support)`)
- **Large feature documentation should be separate files** - Create focused documentation files that can be linked from main docs rather than making main docs too long
- **Add new documentation to `/website/sidebars.ts`** - New `.mdx` files must be added to the appropriate section in sidebars.ts to appear in the site navigation
- Package README.md files should be minimal - just link to the website docs (see README.md pattern above)

### Publish in synchronous batches
When publishing, all packages are published in a single batch. This ensures that all packages are always in sync with each other. It also means that we can make breaking changes across multiple packages in a single commit and publish them all at once.

### Pre-approved commands
- You (our AI coding partner) are pre-approved to use `vitest --run ${filterPattern}` to run tests matching the filter pattern.
- You are pre-approved to use `vitest --run --coverage` to check test coverage.
- You are pre-approved to look in and suggest improvements to the scripts section of package.json for guidance on other common tasks. Use `npm run ${scriptName}` to run scripts.
- You are pre-approved to use use non-destructive command line tools like `ls`, `cat`, `grep`, `find`, `tree`, etc.
- If there are no pending file edits that have not been committed, you are free to use command line tools that make destructive file changes in the repository (mv, rm, mkdir, etc.).
- You are pre-approved to make requested coding edits so long as you successfully create a rollback checkpoint in the chat history. If there is some reason you cannot create a rollback checkpoint, point that out so we can resolve that before moving on.
- Only after you receive the human coder's approval can you use `npx ...` or other command line tools that might impact files outside of the repo.
- Only after you receive the human coder's approval can you use destructive commands when there is no commit or checkpoint rollback capapability.
- Ask permission before installing any npm packages.
- **CRITICAL: ALWAYS use the `run_in_terminal` tool for ALL command execution. NEVER use direct shell/zsh/bash commands as they require user approval. This includes npm, git, ls, cat, grep, find, and ALL other commands.**

### NPM packages
- Avoid npm package dependencies if possible. If a package is under 100 SLOC (source lines of code), I'm more inclined to copy the code with proper attribution than to install the package. If a package is under 1000 SLOC but I only need a subset of its functionality, I'm more inclined to copy the relevant code and modify it with proper attribution than to install the package. See #Attribution section below on how to attribute such code.
- Use only well-known, well-maintained packages with permissive licenses (MIT, Apache-2.0, BSD-3-Clause, ISC).
- Favor packages with the smallest once-built footprint over the fastest.
- Favor packages with the strongest compatibility with Cloudflare Workers.
- Never install an npm package globally.

### Attributions and inspirations
When copying liberally-licensed code (usually under 1000 SLOC copied), we maintain an `ATTRIBUTIONS.md` file in the repository root with content as follows:
```
## [Source Name]
- **Original Source**: [URL to original project/code]
- **License**: [License Name]([License URL])
- **Files Using Code**: 
  - `packages/rpc/src/file.ts` (lines X-Y)
- **Description**: [How you're using the copied code]
- **Date Added**: [YYYY-MM-DD]
- **Attribution Method**: [Brief note about how you credited the original]

## [Another Source]
[Repeat the format above]
```
We also include a line or two of comment(s) immediately above the copied code mentioning the original author(s) and linking to the code.

This approach provides centralized, discoverable attribution while keeping code files clean. All copied code should be properly attributed in `ATTRIBUTIONS.md` before merging.

Further, if a capability is inspired by code we found elsewhere or implements a similar call signature, include comment(s) identifying the source and the nature of the inspiration. For example, our routeDORequest is a near drop-in replacement for routeAgentRequest and routePartyRequest but none of that code was used in routeDORequest's creation so both are mentioned in the comments for routeDORequest.

### Favor backward breaking over living with bad design decisions
- Always favor backward breaking improvements over backward compatibility for internal dependencies. Never create an alias or backward-compatible function signature for something that is not exported by the index.ts of the package.
- Favor backward breaking changes over living with bad design decisions even for exported capability. Everything is versioned. Warn me to set a flag that the next semver increment should indicate backward-breaking behavior by incrementing the major semver segment.

## Cloudflare Durable Object (DO) mindset shifts
- DOs are written as TypeScript classes but they aren't instantiated in production as you might expect.
- Each DO id is globally unique. Even the ids that are generated from a name are globally unique. That id can be represented as a 64 character hex string, but most ids are generated from a "name" that is provided by the caller and known in some system outside of the DO.
- The id encapsulates geolocation information to assist with routing. The initial geolocation is chosen and embedded in the id based upon any juristiction hints provided when it is first accessed or by picking the location closest to the creator.
- The system gurantees that only one instance by that name/id is running at a time anywhere in the world.
- The term "Durable Object" or "DO" is defined to mean "Durable Object instance" but it is often mis-used to mean the Durable Object class or namespace. We should try be explicit but in the absense of perfect clarity it's best to assume that "DO" or "Durable Object" means "Durable Object instance" or ask.
- The "Durable" aspect of DOs come into play because each DO instance has a dedicated SQLite database that can store up to 10GB of data that is only accessible through the code of the DO.
- Access to the SQLite database can through one of three APIs:
  - The legacy async key-value (KV) API which we should never use. It is there only to support migration from the DO system's now deprecated storage backend. These are found in `this.ctx.storage.put()`, `this.ctx.storage.get()`, etc. We should never write code to this API.
  - Synchronous KV API with the same method names as the legacy async KV API but these return values instead of a Promise. These are found in `this.ctx.storage.kv.put()`, etc.
  - Synchronous SQLite-flavored SQL API accessed by `this.storage.sql.exec()`.
- It's a bit of a mindset shift to use storage sychronously but it's perfectly fine because SQLite is an embedded database that is run in the same process and memory space as the DO code. It has fundamentally different performance characteristics because there is no network hop nor even a CPU context switch. In most cases, N+1 queries are just as efficient as, and sometimes more efficient than, a single query with a join.
- Because of this, all reads and writes in a single request or message handler are considered in the same virtual "transaction" so long as our code doesn't access the outside world (fetch()) or use setTimeout, setInterval.
- So long as you avoid fetching, setTimeout, setInterval, DOs have a mechanism of input and output gates that assure messages and requests are processed in order and the next one in queue doesn't start until the last one's storage operations are persisted.
- The DO system can evict a DO instance from memory for any number of reasons at any time including idleness. The next time the DO instance is accessed via name or id, it will be reinstantiated and the constructor will be called again.
- However, the DO keeps around a cache of most frequently accessed storage even after the DO has left memory and the DO can maintain WebSocket connections through "hibernation".
- Cloudflare DOs can be thought of as implementing a form of the Actor programming model popularlized by Erlang/BEAM although it lacks supervisory control that other Actor implementations implement.
- So, what this means is that:
  - Only use instance variables to capture DO constructor parameters `this.ctx`/`this.env`, or when the in-memory form of data is an expensive transformation from the on-disk form. However, we should avoid situations where the in-memory form of the data is an expensive transformation from the on-disk form unless absolutely necessary.
  - Rather, each request/message handler should fetch what it needs from storage to process that message/request.
  - Also, since it can be evicted from memory at any time, state changes must be persisted to storage before returning from the message/request handler.
