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

### Phase 2: Documentation Content Creation

#### 2.1: Write @lumenize/rpc Documentation
- [ ] Getting Started guide with testable examples
- [ ] HTTP Transport usage guide
- [ ] WebSocket Transport usage guide
- [ ] Error handling guide
- [ ] Advanced topics (custom serialization, timeouts, etc.)
- [ ] Migration guide (if applicable)
- [ ] **Checkpoint**: Review documentation for completeness

#### 2.2: Generate and Review API Docs
- [ ] Generate API docs for all @lumenize packages
- [ ] Review for completeness and clarity
- [ ] Add cross-references between guides and API docs
- [ ] **Checkpoint**: Final documentation review

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

- [ ] Add cookie jar support to rpc or maybe consider keeping the @lumenize/testing package which adds things like cookie jar
- [ ] Deploy to Cloudflare button
- [ ] Refactor testing to be a matrix WebSocket vs HTTP, Self-instrumented w/ handlers vs lumenizeRpcDo, sub-classed vs not
- [ ] Also need test(s) that confirm we haven't messed up their own request and message handlers. Don't worry about crossing the streams of using HTTP for RPC but using WebSockets for message handling and vice-versa. Those are good tests.
- [ ] Add use cases to either quick-start or some other document for @lumenize/rpc. Testing is one, but...
