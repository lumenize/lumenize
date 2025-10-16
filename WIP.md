# Work In Progress (WIP): Documentation & Build Automation

**Goals:**
1. **Testable Documentation**: Write text-heavy getting started guides and blog posts in .md/.mdx with embedded code examples that are automatically extracted and run as tests (using vitest with Cloudflare Workers pool). Failed assertions should fail the build. ✅ **COMPLETE**
2. **API Documentation**: Extract JSDoc from source code to generate API reference docs (call signatures, types, etc.). ✅ **COMPLETE**
3. **Automated Release Process**: Top-level build orchestration that runs all tests, ensures clean git state, builds all packages, uses Lerna to version/tag/publish packages to npm, and publishes docs to Cloudflare.

## Implementation Phases

### Phase 1: Monorepo Build & Release Automation

#### 1.1: Research Lerna alternatives and best practices (2025)
- [ ] Research build tools:
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

#### 1.2: Install & Configure Lerna (or alternative)
- [ ] Install Lerna in monorepo root (or selected alternative)
- [ ] Configure lerna.json or equivalent:
  - [ ] Synchronized versioning across packages
  - [ ] Package locations (packages/*, examples/*)
  - [ ] npm registry configuration
- [ ] Set up version bump commands
- [ ] Test dry-run of version bump
- [ ] **Checkpoint**: Verify Lerna configuration

#### 1.3: Create Build Orchestration Script
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

#### 1.4: CI/CD Integration (Optional)
- [ ] Consider GitHub Actions workflow for automated releases
- [ ] Set up secrets for npm and Cloudflare tokens
- [ ] Configure workflow to run on git tags or manual trigger
- [ ] **Checkpoint**: Decide if CI/CD is needed now or later

### Phase 2: Documentation Content & Review

#### 2.1: Write @lumenize/rpc Documentation ✅ **COMPLETE**
- [x] Getting Started guide with testable examples
- [x] HTTP Transport usage guide (covered in quick-start)
- [x] WebSocket Transport usage guide (testable)
- [x] Error handling guide (testable)
- [x] Manual Instrumentation guide (testable)
- [x] Introduction page
- [x] Limitations page

#### 2.2: Write @lumenize/utils Documentation ✅ **COMPLETE**
- [x] Route DO Request guide
- [x] Cookie Jar guide (testable)
- [x] WebSocket Shim guide

#### 2.3: Generate and Review API Docs ✅ **GENERATED** (needs manual review)
- [x] Generate API docs for all @lumenize packages
- [x] Configure TypeDoc integration with Docusaurus
- [x] Add cross-references between guides and API docs
- [ ] **Manual Review**: Review all generated API reference pages (~dozen+ pages)
- [ ] **Manual Review**: Review all guide pages for accuracy
- [ ] **Checkpoint**: Final documentation review complete

### Phase 3: Testing & Refinement

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

- [ ] Think about how we might recreate the inspect messages functionality we had in @lumenize/testing
- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube account over to the lumenize repo
- [ ] We need much more security info on the website. Maybe an entire .mdx. Here is the completely inadequate warning we had in the README before we thinned it down. 
  ⚠️ **IMPORTANT**: This package exposes your DO internals via RPC endpoints. Only use in development or secure the endpoints appropriately for production use.
- [ ] Possible additional testing for rpc
  - [ ] Add timeout testing to matrix
  - [ ] Add memory leak testing (WebSocket connections)
  - [ ] Test in production on Cloudflare (not just local with vitest)
