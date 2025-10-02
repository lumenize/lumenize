# Work In Progress (WIP): Documentation & Build Automation

**Goals:**
1. **Testable Documentation**: Write text-heavy getting started guides and blog posts in .md/.mdx with embedded code examples that are automatically extracted and run as tests (using vitest with Cloudflare Workers pool). Failed assertions should fail the build.
2. **API Documentation**: Extract JSDoc from source code to generate API reference docs (call signatures, types, etc.).
3. **Automated Release Process**: Top-level build orchestration that runs all tests, ensures clean git state, builds all packages, uses Lerna to version/tag/publish packages to npm, and publishes docs to Cloudflare.

## Implementation Phases

### Phase 1: Research & Tool Selection

#### 1.1: Testable Documentation Tools
- [ ] Research existing solutions for extracting code from markdown:
  - [ ] Docusaurus plugins for runnable code examples
  - [ ] Standalone tools (e.g., markdown-it plugins, remark/rehype plugins)
  - [ ] TypeDoc with live-code examples
  - [ ] mdx-test or similar testing frameworks
  - [ ] Look at how others do this (React docs, Storybook, etc.)
- [ ] Evaluate requirements:
  - [ ] Must support Docusaurus frontmatter and .mdx syntax
  - [ ] Must extract code blocks (with imports) for testing
  - [ ] Must integrate with vitest + @cloudflare/vitest-pool-workers
  - [ ] Must fail Docusaurus build on test failure
  - [ ] Should support rapid iteration on single document
  - [ ] Decide: imports in comments vs. actual code blocks
- [ ] **Checkpoint**: Review findings and select tooling approach

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

#### 2.1: Create Proof-of-Concept
- [ ] Choose one @lumenize/rpc guide to prototype (e.g., "Getting Started")
- [ ] Set up directory structure in lumenize/website/docs/
- [ ] Write sample .mdx file with:
  - [ ] Frontmatter
  - [ ] Narrative text (headings, paragraphs, lists)
  - [ ] Code blocks with imports and assertions
- [ ] Create extraction script/plugin:
  - [ ] Extract code from markdown
  - [ ] Generate vitest test file(s)
  - [ ] Configure vitest with cloudflare workers pool
- [ ] Verify extracted tests run successfully
- [ ] **Checkpoint**: Review proof-of-concept approach

#### 2.2: Integrate with Docusaurus Build
- [ ] Create Docusaurus plugin or build hook:
  - [ ] Run extracted tests during docusaurus build
  - [ ] Fail build if tests fail
  - [ ] Report which document/assertion failed
- [ ] Set up watch mode for rapid iteration on single doc
- [ ] Document workflow for writing testable docs
- [ ] **Checkpoint**: Verify integration works end-to-end

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
