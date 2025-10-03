# Work In Progress (WIP): Documentation & Build Automation

**Goals:**
1. **Testable Documentation**: Write text-heavy getting started guides and blog posts in .md/.mdx with embedded code examples that are automatically extracted and run as tests (using vitest with Cloudflare Workers pool). Failed assertions should fail the build.
2. **API Documentation**: Extract JSDoc from source code to generate API reference docs (call signatures, types, etc.).
3. **Automated Release Process**: Top-level build orchestration that runs all tests, ensures clean git state, builds all packages, uses Lerna to version/tag/publish packages to npm, and publishes docs to Cloudflare.

## Implementation Phases

### Phase 1: Research & Tool Selection

#### 1.1: Testable Documentation Tools
- [x] Research existing solutions for extracting code from markdown:
  - [x] Docusaurus plugins for runnable code examples (React Live - not suitable)
  - [x] Standalone tools (e.g., markdown-it plugins, remark/rehype plugins)
  - [x] TypeDoc with live-code examples (for API docs only)
  - [x] mdx-test or similar testing frameworks (none found)
  - [x] Look at how others do this (React docs, Storybook, etc.)
- [x] Evaluate requirements:
  - [x] Must support Docusaurus frontmatter and .mdx syntax ✅
  - [x] Must extract code blocks (with imports) for testing ✅
  - [x] Must integrate with vitest + @cloudflare/vitest-pool-workers ✅
  - [x] Must fail Docusaurus build on test failure ✅
  - [x] Should support rapid iteration on single document ✅
  - [x] Decide: imports in comments vs. actual code blocks → **Visible imports**
- [x] **Research complete**: See `docs/research/testable-documentation-research.md`
- [x] **Architecture planned**: See `docs/research/doc-testing-tooling-architecture.md`
- [x] **Checkpoint**: Review findings and approve approach

**Recommendation**: 
- Single remark plugin with multiple handlers for different file types
- Extract to per-document test workspaces: `website/test/generated/{doc-name}/`
- New `tooling/doc-testing/` directory for custom tooling
- Metadata conventions: ` ```typescript test`, ` ```jsonc wrangler`, ` ```typescript src/index.ts`

**✅ Approved - Proceeding to Phase 2.1**

#### 1.2: API Documentation Tools
- [ ] Research JSDoc extraction tools:
  - [ ] TypeDoc (TypeScript-first)
  - [ ] Docusaurus plugin-content-docs with TypeDoc integration
  - [ ] API Extractor (@microsoft/api-extractor)
  - [ ] typedoc-plugin-markdown for Docusaurus integration
- [ ] Evaluate requirements:
  - [ ] Extract JSDoc comments from TypeScript source
  - [ ] Generate Docusaurus-compatible markdown/mdx
  - [ ] Render call signatures, types, interfaces
  - [ ] Optionally: support runnable examples in JSDoc (or skip)
- [ ] **Checkpoint**: Review findings and select JSDoc tooling

#### 1.3: Monorepo Build & Release Automation
- [ ] Research Lerna alternatives and best practices (2025):
  - [ ] Lerna vs. Changesets vs. nx vs. Turborepo
  - [ ] npm workspaces + custom scripts
  - [ ] pnpm workspace features
- [ ] Design build orchestration requirements:
  - [ ] Run all package tests (including extracted doc tests)
  - [ ] Build all packages
  - [ ] Ensure git is clean (no uncommitted changes)
  - [ ] Version packages together (synchronized versions)
  - [ ] Create git tag
  - [ ] Publish to npm
  - [ ] Build and publish website to Cloudflare
  - [ ] Atomic: fail entire process if any step fails
- [ ] **Checkpoint**: Review findings and design build process

### Phase 2: Testable Documentation Prototype

#### 2.1: Create Proof-of-Concept ✅
- [x] Choose one @lumenize/rpc guide to prototype (e.g., "Getting Started")
- [x] Set up directory structure in `tooling/doc-testing/`
- [x] Write sample .mdx file with:
  - [x] Frontmatter
  - [x] Narrative text (headings, paragraphs, lists)
  - [x] Code blocks with imports and assertions
- [x] Create extraction script:
  - [x] Extract code from markdown (unified + remark)
  - [x] Support multiple file types (test, src, wrangler, package, vitest config)
  - [x] Generate vitest test file(s)
  - [x] Auto-generate package.json with detected dependencies  
  - [x] Auto-generate vitest.config.ts
- [x] Verify extracted workspace structure is correct
- [x] **Validate test code quality**:
  - [x] Extracted test runs successfully in main @lumenize/rpc package
  - [x] Found and fixed documentation bug (wrong RPC client API)
  - [x] Confirmed extraction logic produces correct, working code
- [x] **Checkpoint**: Review proof-of-concept approach

**Status**: ✅ **Phase 2.1 COMPLETE!** 

**Achievements:**
- ✅ Full extraction system for all file types
- ✅ Auto-generation of package.json with dependency detection
- ✅ Auto-generation of vitest.config.ts matching working patterns
- ✅ CLI tool with verbose mode and error handling
- ✅ **Test code validated: runs successfully in working environment**
- ✅ **Documentation quality: found and fixed RPC client API bug**
- ✅ Support for all planned file types

**Findings:**
- Test execution works in main package (validates code quality)
- Isolated workspace execution blocked by vitest/birpc issue
- Solution: Run tests from website workspace in Phase 2.3

**Next**: Phase 2.2 (Remark Plugin) - extraction is solid, test code is valid!

#### 2.2: Convert to Remark Plugin ✅
- [x] Create remark plugin in `tooling/doc-testing/src/remark-plugin.ts`
- [x] Export plugin from package
- [x] Add plugin to Docusaurus config (`website/docusaurus.config.ts`)
- [x] Configure plugin options (outputDir, verbose, skip)
- [x] Test plugin during Docusaurus build
- [x] Verify extraction happens automatically

**Status**: ✅ **Phase 2.2 COMPLETE!**

**Achievements:**
- ✅ Remark plugin integrated into Docusaurus build
- ✅ Automatic extraction during `npm run build`
- ✅ Extracted tests to `website/test/extracted/`
- ✅ Plugin respects configuration options
- ✅ Graceful error handling (doesn't break build)
- ✅ Created `docs/quick-start.mdx` as working example

**Next**: Phase 2.3 (Test Execution Integration)

#### 2.3: Run Extracted Tests ✅
- [x] Add vitest config to website (`vitest.config.ts`)
- [x] Configure vitest to use `@cloudflare/vitest-pool-workers`
- [x] Match vitest version with @lumenize/rpc (3.2.4)
- [x] Install test dependencies in website package
- [x] Add test scripts to `website/package.json`
- [x] Run extracted tests: `npm test`
- [x] Verify tests execute successfully
- [x] **Checkpoint**: Confirm test execution works

**Status**: ✅ **Phase 2.3 COMPLETE!**

**Test Results:**
```
✓ test/extracted/quick-start/test/extracted.test.ts (1 test) 10ms
  ✓ Counter RPC > should increment the counter 10ms

Test Files  1 passed (1)
     Tests  1 passed (1)
```

**Achievements:**
- ✅ Tests run from website workspace (not isolated)
- ✅ Vitest 3.2.4 (same as @lumenize/rpc)
- ✅ Compatibility date: 2025-09-01
- ✅ Full RPC workflow working (routeDORequest + lumenizeRpcDo)
- ✅ Dependencies properly linked (@lumenize/rpc, @lumenize/utils)
- ✅ Test validates documentation accuracy

**Solution:** Running tests from website workspace avoided the isolated workspace issues we encountered in Phase 2.1!

**Next**: Phase 3 (API Documentation)

### Phase 3: API Documentation Setup

#### 3.1: Configure TypeDoc/Tool
- [ ] Install and configure selected JSDoc extraction tool
- [ ] Set up output to generate Docusaurus-compatible markdown
- [ ] Configure to scan all packages in lumenize/packages/
- [ ] Generate initial API docs for @lumenize/rpc
- [ ] Review output quality and adjust configuration
- [ ] **Checkpoint**: Review generated API docs

#### 3.2: Integrate with Docusaurus
- [ ] Add generated API docs to Docusaurus site
- [ ] Configure sidebars for API reference section
- [ ] Set up automatic regeneration during build
- [ ] Ensure styling/formatting matches site theme
- [ ] **Checkpoint**: Verify API docs render correctly

### Phase 4: Build & Release Automation

#### 4.1: Install & Configure Lerna (or alternative)
- [ ] Install Lerna in monorepo root (or selected alternative)
- [ ] Configure lerna.json or equivalent:
  - [ ] Synchronized versioning across packages
  - [ ] Package locations (packages/*, examples/*)
  - [ ] npm registry configuration
- [ ] Set up version bump commands
- [ ] Test dry-run of version bump
- [ ] **Checkpoint**: Verify Lerna configuration

#### 4.2: Create Build Orchestration Script
- [ ] Create top-level build script (e.g., scripts/release.sh or npm script):
  - [ ] Step 1: Check git status (fail if uncommitted changes)
  - [ ] Step 2: Run all package tests (pnpm -r test)
  - [ ] Step 3: Run documentation tests (extracted from .mdx)
  - [ ] Step 4: Build all packages (pnpm -r build)
  - [ ] Step 5: Build website (docusaurus build)
  - [ ] Step 6: Version bump with Lerna (interactive or automatic)
  - [ ] Step 7: Create git tag
  - [ ] Step 8: Git push with tags
  - [ ] Step 9: Publish packages to npm (lerna publish or pnpm publish -r)
  - [ ] Step 10: Publish website to Cloudflare
- [ ] Add dry-run mode for testing
- [ ] **Checkpoint**: Test build orchestration end-to-end (dry-run)

#### 4.3: CI/CD Integration (Optional)
- [ ] Consider GitHub Actions workflow for automated releases
- [ ] Set up secrets for npm and Cloudflare tokens
- [ ] Configure workflow to run on git tags or manual trigger
- [ ] **Checkpoint**: Decide if CI/CD is needed now or later

### Phase 5: Documentation Content Creation

#### 5.1: Write @lumenize/rpc Documentation
- [ ] Getting Started guide with testable examples
- [ ] HTTP Transport usage guide
- [ ] WebSocket Transport usage guide
- [ ] Error handling guide
- [ ] Advanced topics (custom serialization, timeouts, etc.)
- [ ] Migration guide (if applicable)
- [ ] **Checkpoint**: Review documentation for completeness

#### 5.2: Generate and Review API Docs
- [ ] Generate API docs for all @lumenize packages
- [ ] Review for completeness and clarity
- [ ] Add cross-references between guides and API docs
- [ ] **Checkpoint**: Final documentation review

### Phase 6: Testing & Refinement

- [ ] Run full build process from clean state
- [ ] Test failure scenarios (failing test in docs, dirty git, build errors)
- [ ] Verify all documentation examples execute correctly
- [ ] Verify API docs are accurate and complete
- [ ] Test publishing to npm (maybe using npm dry-run)
- [ ] Test publishing website to Cloudflare
- [ ] Document the release process for future reference
- [ ] **Checkpoint**: Ready for first real release

## Checkpoints
- After each step completion, ask for review. During review:
  - Developer will ask questions and make suggestions
  - AI Agent/Copilot/Kilo Code will implement suggestions, then prompt the developer for more questions/suggestions
  - Only after the developer confirms that the review is complete can you proceed to...
- Confirm that developer has committed code
- Ask for permission before proceeding to the next step

## Later and possibly unrelated

- [ ] Consider refactoring doc-testing to be pure javascript. We seem to run into significant build cache issues.
- [ ] Refactor testing to be a matrix WebSocket vs HTTP, Self-instrumented w/ handlers vs lumenizeRpcDo, sub-classed vs not
- [ ] Also need test(s) that confirm we haven't messed up their own request and message handlers. Don't worry about crossing the streams of using HTTP for RPC but using WebSockets for message handling and vice-versa. Those are good tests.
- [ ] Add use cases to either quick-start or some other document for @lumenize/rpc. Testing is one, but...