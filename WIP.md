# Work In Progress (WIP): Documentation & Build Automation

**Goals:**
1. **Testable Documentation**: Write text-heavy getting started guides and blog posts in .md/.mdx with embedded code examples that are automatically extracted and run as tests (using vitest with Cloudflare Workers pool). Failed assertions should fail the build. ✅ **COMPLETE**
2. **API Documentation**: Extract JSDoc from source code to generate API reference docs (call signatures, types, etc.). ✅ **COMPLETE**
3. **Automated Release Process**: Top-level build orchestration that runs all tests, ensures clean git state, builds all packages, uses Lerna to version/tag/publish packages to npm, and publishes docs to Cloudflare.

## Key Decisions - CONFIRMED ✅

1. **Versioning Strategy**: 
   - ✅ **Synchronized versioning** (all packages version together)
   - Initial version: **0.8.0** (to avoid conflict with legacy `Lumenize` package at 0.7.x)

2. **Build Strategy**:
   - ✅ **Build-on-publish** via centralized script (NOT in individual package.json)
   - Build scripts live in monorepo root or `scripts/` directory
   - Individual packages keep `"main": "src/index.ts"` for development (in git)
   - Build process temporarily updates package.json to point to `dist/` for publish
   - After publish, package.json reverts to `src/` for development (only `version` stays updated)

3. **Doc-Test Integration**:
   - ✅ Doc-tests live in `/doc-test/*/` folders
   - ✅ Docusaurus plugin converts doc-tests to `.mdx` files in `/website/`
   - ✅ Website build automatically runs doc-test extraction (already configured)

4. **Website Deployment**:
   - ✅ Uses Cloudflare Assets (via `wrangler deploy`)
   - ✅ `npm run deploy` in `/website/` handles build + deployment
   - ✅ Separate from npm package releases (can update docs independently)

5. **npm Registry**:
   - ✅ Publish to public npm registry (registry.npmjs.org)
   - ✅ Scoped under `@lumenize/*` organization

6. **Testing Requirements**:
   - ✅ All doc-tests must pass before publishing (blocking)
   - ✅ All package tests must pass before publishing (blocking)
   - 🎯 Personal goal: >80% branch coverage (not enforced)

## Critical Implementation Notes

### Build Strategy: Keeping AI Agents Happy

**Problem**: AI coding agents see build scripts in package.json and think they need to run builds after every change.

**Solution**: Centralized build scripts in `/scripts/` directory
- ✅ Individual package.json files have NO build scripts
- ✅ Build happens via centralized `scripts/build-packages.sh`
- ✅ Package.json manipulation happens in `scripts/prepare-for-publish.sh`
- ✅ Development mode restored via `scripts/restore-dev-mode.sh`

**Development Mode** (committed to git, what AI agents see):
```json
{
  "version": "0.8.0",         // Updated by Lerna, committed
  "main": "src/index.ts",     // Points to source for development
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

**Publish Mode** (temporary, during npm publish only):
```json
{
  "version": "0.8.0",         // Same version
  "main": "dist/index.js",    // Temporarily points to built files
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src"]
}
```

**After Publish** (reverted, back in git):
```json
{
  "version": "0.8.0",         // Version stays updated ✅
  "main": "src/index.ts",     // Back to source ✅
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

**Key Point**: Only the `version` field persists in git. Entry points (`main`, `types`, `exports`) temporarily change during publish, then revert back to `src/` for development.

### Doc-Test Integration

**How it works**:
1. Doc-tests live in `/doc-test/*/` as standalone vitest projects
2. **Release script** runs vitest in each doc-test folder to ensure they pass
3. **Docusaurus plugin** extracts code and creates `.mdx` files in `/website/` (during website build only)
4. Website build includes extracted doc-test content

**Key distinction**: 
- Release script = Runs the tests (vitest)
- Docusaurus = Extracts and formats for docs (no test execution)

## Implementation Phases

### Phase 1: Monorepo Build & Release Automation

#### 1.1: Design Build Orchestration ✅ **DECISIONS CONFIRMED**

**Architecture**:
- ✅ Tool: Lerna (already installed) with npm workspaces
- ✅ Versioning: Synchronized at **0.8.0** (avoiding legacy package conflict)
- ✅ Build: Centralized in `scripts/` (NOT in individual package.json files)
- ✅ Doc-tests: Docusaurus plugin converts doc-tests to .mdx automatically
- ✅ Website: Separate deployment via `wrangler deploy`

**Build Orchestration Flow**:
1. Pre-flight checks:
   - Ensure git is clean (no uncommitted changes, no untracked files)
   - Ensure on `main` branch
   - Verify npm authentication (`npm whoami`)
2. Testing phase:
   - Run all package tests (`npm test --workspaces --if-present`)
   - Run all doc-tests (from `doc-test/**/`)
   - Fail if any test fails
3. Build phase:
   - Run centralized TypeScript build script for all packages
   - Generate dist/ directories (not committed to git)
   - Temporarily update package.json entry points to point to dist/
4. Version & Publish phase:
   - Version bump with Lerna (synchronized, interactive prompt)
   - Create git commit with version changes (only `version` field)
   - Create git tag (e.g., `v0.8.0`)
   - Publish packages to npm (lerna publish from-package)
   - Git push with tags
5. Cleanup phase:
   - Restore package.json entry points to src/ for development
   - Remove dist/ directories (or leave for next build, as they're .gitignore'd)
6. Atomic failure: Rollback uncommitted changes if any step fails

#### 1.2: Configure Lerna for Synchronized Versioning ✅ **COMPLETE**
- [x] Update `lerna.json`:
  - [x] Set version to `"0.8.0"` (starting point, avoiding legacy package conflict)
  - [x] Configure for synchronized/fixed versioning mode
  - [x] Set package locations (`packages/*`)
  - [x] Configure npm registry and access
- [x] Update all package.json versions:
  - [x] Set `@lumenize/rpc` to `0.8.0`
  - [x] Set `@lumenize/testing` to `0.8.0`
  - [x] Set `@lumenize/utils` to `0.8.0`
- [x] Verify Lerna can detect packages:
  - [x] Run `npx lerna list` to confirm all packages found (3 packages detected)
  - [x] Mark `testing-outdated` as private (excluded from publish)
- [x] Test version bump (dry-run):
  - [x] Verified Lerna versioning works correctly
- [x] **Checkpoint**: Lerna configuration complete and verified

#### 1.3: Create Centralized Build Script ✅ **COMPLETE**
- [x] Create `scripts/build-packages.sh`:
  - [x] For each package in `packages/*`:
    - [x] Run TypeScript compiler (`tsc`) with package-specific tsconfig.build.json
    - [x] Generate `dist/` directory with .js and .d.ts files
    - [x] Validate build output (compilation errors cause exit)
  - [x] Script is idempotent (can run multiple times safely)
  - [x] Error handling added (exit on first failure with `set -e`)
- [x] Create `scripts/prepare-for-publish.sh`:
  - [x] Run `scripts/build-packages.sh`
  - [x] For each package, temporarily update package.json:
    - [x] Change `"main"` from `"src/index.ts"` to `"dist/index.js"`
    - [x] Change `"types"` from `"src/index.ts"` to `"dist/index.d.ts"`
    - [x] Update `"exports"` to point to dist/
  - [x] Uses Node.js to safely manipulate JSON
- [x] Create `scripts/restore-dev-mode.sh`:
  - [x] Restore package.json entry points to src/ for development
  - [x] Preserve version numbers (as designed)
  - [x] dist/ directories remain (are .gitignore'd)
- [x] Created `tsconfig.build.json` for each package:
  - [x] Uses @cloudflare/workers-types and @types/node
  - [x] Outputs .js, .d.ts, .d.ts.map, .js.map files
- [x] Test build script on all packages
- [x] **Checkpoint**: All three build scripts tested and working perfectly

#### 1.4: Create Release Orchestration Script ✅ **COMPLETE**
- [x] Create `scripts/release.sh` with comprehensive error handling:
  - [x] Step 1: Pre-flight checks
    - [x] Check git status (fail if uncommitted/untracked files)
  - [x] Step 2: Run all tests
    - [x] Run package tests (`npm test --workspaces`)
    - [x] Auto-discover and run doc-tests (hardcoded list of doc-test directories)
    - [x] Fail if any test fails
  - [x] Step 3: Build packages
    - [x] Run `scripts/prepare-for-publish.sh`
    - [x] Verify all packages built successfully
  - [x] Step 4: Version & Tag
    - [x] Interactive: Run `lerna version` (prompts for patch/minor/major/custom)
    - [x] Lerna creates commit and git tag automatically
  - [x] Step 5: Publish to npm
    - [x] Run `lerna publish from-package` (publishes current versions)
  - [x] Step 6: Cleanup
    - [x] Run `scripts/restore-dev-mode.sh`
    - [x] Commit restored package.json files
    - [x] Push changes
- [x] Create `scripts/release-dry-run.sh`:
  - [x] Runs all tests and builds
  - [x] Shows what would be versioned (simulated)
  - [x] Does NOT publish or create git tags
  - [x] Restores dev mode at end
- [x] Add npm scripts to root package.json:
  - [x] `"release:dry-run": "./scripts/release-dry-run.sh"`
  - [x] `"release": "./scripts/release.sh"`
- [x] Scripts syntax validated
- [ ] **Checkpoint**: Test dry-run end-to-end (manual testing needed)

#### 1.5: Website Publishing (Separate from npm releases) ✅ **COMPLETE**
- [x] Document website deployment process:
  - [x] Website already has `npm run deploy` which:
    - [x] Runs Docusaurus build (includes doc-test extraction plugin)
    - [x] Runs `wrangler deploy` to Cloudflare Assets
  - [x] Website can be updated independently of package releases
  - [x] Note: Website deployment is separate from npm package releases
- [x] **Checkpoint**: Website deployment confirmed working (via `npm run deploy` in /website/)

#### 1.6: CI/CD Integration (Future - Not Priority)
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
- [x] **Manual Review**: Review all generated API reference pages (~dozen+ pages)
- [x] **Manual Review**: Review all guide pages for accuracy
- [x] **Checkpoint**: Final documentation review complete

### Phase 3: Testing & Refinement

- [x] Run full dry-run from clean state: ✅ **PASSED**
  - [x] All 3 publishable packages tested (270 tests total)
  - [x] All 3 doc-test suites tested (8 tests total)
  - [x] All packages built successfully
  - [x] Package.json manipulation works (dev → publish → dev)
  - [x] Dev mode properly restored
- [ ] Test failure scenarios (optional - can test during actual use):
  - [ ] Failing unit test blocks release
  - [ ] Failing doc-test blocks release
  - [ ] Dirty git state blocks release
- [ ] Test actual npm publish workflow:
  - [ ] Review Lerna configuration one more time
  - [ ] Consider using `npm pack` to inspect package contents
  - [ ] Decide: Test publish to npm or go straight to production release?
- [ ] Create release documentation (optional):
  - [ ] Document the release process for future reference
  - [ ] Add troubleshooting guide
  - [ ] Document rollback procedures
- [ ] **Checkpoint**: Ready for first real release to npm?

## Quick Reference: Release Commands

Once Phase 1 is complete, releases will work like this:

```bash
# Test everything without publishing
npm run release:dry-run

# Actual release (interactive - will prompt for version bump)
npm run release

# Deploy website separately (can be done anytime)
cd website && npm run deploy
```

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
