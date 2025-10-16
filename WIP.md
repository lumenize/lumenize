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

#### 1.2: Configure Lerna for Synchronized Versioning
- [ ] Update `lerna.json`:
  - [ ] Set version to `"0.8.0"` (starting point, avoiding legacy package conflict)
  - [ ] Configure for synchronized/fixed versioning mode
  - [ ] Set package locations (`packages/*`)
  - [ ] Configure npm registry and access
- [ ] Update all package.json versions:
  - [ ] Set `@lumenize/rpc` to `0.8.0`
  - [ ] Set `@lumenize/testing` to `0.8.0`
  - [ ] Set `@lumenize/utils` to `0.8.0`
- [ ] Verify Lerna can detect packages:
  - [ ] Run `npx lerna list` to confirm all packages found
- [ ] Test version bump (dry-run):
  - [ ] Run `npx lerna version --no-git-tag-version --no-push` to simulate
- [ ] **Checkpoint**: Verify Lerna configuration and package detection

#### 1.3: Create Centralized Build Script
- [ ] Create `scripts/build-packages.sh`:
  - [ ] For each package in `packages/*`:
    - [ ] Run TypeScript compiler (`tsc`) with package-specific tsconfig
    - [ ] Generate `dist/` directory with .js and .d.ts files
    - [ ] Validate build output (check for compilation errors)
  - [ ] Script should be idempotent (can run multiple times safely)
  - [ ] Add error handling (exit on first failure)
- [ ] Create `scripts/prepare-for-publish.sh`:
  - [ ] Run `scripts/build-packages.sh`
  - [ ] For each package, temporarily update package.json:
    - [ ] Change `"main"` from `"src/index.ts"` to `"dist/index.js"`
    - [ ] Change `"types"` from `"src/index.ts"` to `"dist/index.d.ts"`
    - [ ] Update `"exports"` to point to dist/
  - [ ] Add `"files": ["dist", "src"]` if not already present
  - [ ] Store original package.json for restoration
- [ ] Create `scripts/restore-dev-mode.sh`:
  - [ ] Restore package.json entry points to src/ for development
  - [ ] Remove dist/ directories (optional, as they're .gitignore'd)
- [ ] Test build script on all packages
- [ ] **Checkpoint**: Verify build script works and packages build successfully

#### 1.4: Create Release Orchestration Script
- [ ] Create `scripts/release.sh` with comprehensive error handling:
  - [ ] Step 1: Pre-flight checks
    - [ ] Verify on `main` branch
    - [ ] Check git status (fail if uncommitted/untracked files)
    - [ ] Verify npm credentials (`npm whoami`)
  - [ ] Step 2: Run all tests
    - [ ] Run package tests (`npm test --workspaces --if-present`)
    - [ ] Auto-discover and run doc-tests (`doc-test/**/vitest.config.js`)
    - [ ] Fail if any test fails
  - [ ] Step 3: Build packages
    - [ ] Run `scripts/prepare-for-publish.sh`
    - [ ] Verify all packages built successfully
  - [ ] Step 4: Version & Tag
    - [ ] Interactive: Run `lerna version` (prompts for version bump type)
    - [ ] Lerna creates commit and git tag automatically
    - [ ] Lerna pushes tags (if configured)
  - [ ] Step 5: Publish to npm
    - [ ] Run `lerna publish from-package` (publishes current versions)
    - [ ] Automatically pushes to npm registry
  - [ ] Step 6: Cleanup
    - [ ] Run `scripts/restore-dev-mode.sh`
    - [ ] Success: Report published versions and git tag
    - [ ] Failure: Rollback uncommitted changes, restore package.json
- [ ] Create `scripts/release-dry-run.sh`:
  - [ ] Runs all tests and builds
  - [ ] Simulates version bump (shows what would change)
  - [ ] Does NOT publish or create git tags
  - [ ] Restores dev mode at end
- [ ] Add npm scripts to root package.json:
  - [ ] `"release:dry-run": "./scripts/release-dry-run.sh"`
  - [ ] `"release": "./scripts/release.sh"`
- [ ] **Checkpoint**: Test dry-run end-to-end multiple times

#### 1.5: Website Publishing (Separate from npm releases)
- [ ] Document website deployment process:
  - [ ] Website already has `npm run deploy` which:
    - [ ] Runs Docusaurus build (includes doc-test extraction plugin)
    - [ ] Runs `wrangler deploy` to Cloudflare Assets
  - [ ] Website can be updated independently of package releases
  - [ ] Add note in release docs about optional website update after npm publish
- [ ] Verify `npm run deploy` works from `/website/` directory
- [ ] **Checkpoint**: Confirm website deployment works

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

- [ ] Run full dry-run from clean state multiple times
- [ ] Test failure scenarios:
  - [ ] Failing unit test blocks release
  - [ ] Failing doc-test blocks release
  - [ ] Dirty git state blocks release
  - [ ] Not on main branch blocks release
- [ ] Verify package.json manipulation:
  - [ ] Dev mode → Publish mode → Dev mode works correctly
  - [ ] No unintended changes to package.json
- [ ] Test actual npm publish (maybe using `npm pack` first):
  - [ ] Verify published package contains dist/ folder
  - [ ] Verify published package has correct entry points
  - [ ] Verify types work for consumers
- [ ] Create release documentation:
  - [ ] Document the release process for future reference
  - [ ] Add troubleshooting guide
  - [ ] Document rollback procedures
- [ ] **Checkpoint**: Ready for first real release to npm

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
