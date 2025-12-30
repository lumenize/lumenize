# Release Workflow

Execute the Lumenize release process using existing automation scripts.

## Usage

`/release-workflow <dry-run|publish>`

---

## Overview

Lumenize uses a synchronized versioning system where all packages are published together in a single batch with the same version number. This prevents version drift and enables breaking changes across multiple packages in a single commit.

---

## Release Process

All release automation lives in `/scripts/` directory:
- `build-packages.sh` - Compiles TypeScript to dist/
- `prepare-for-publish.sh` - Modifies package.json files for publish
- `release.sh` - Publishes via Lerna
- `restore-dev-mode.sh` - Reverts package.json back to src/
- `release-dry-run.sh` - Test the release process

---

## Steps

### Dry Run (Always Do This First)

1. Run `./scripts/release-dry-run.sh` from repo root
2. Script executes full release process without publishing
3. Script outputs what would be published
4. Review dry run output for any issues
5. Confirm ready for actual release or identify issues

### Actual Release

1. Ensure clean git state (no uncommitted changes)
2. Run `./scripts/release.sh` from repo root
3. Script executes:
   - Builds packages (`build-packages.sh`)
   - Prepares for publish (`prepare-for-publish.sh`)
   - Publishes to npm via Lerna
   - Restores dev mode (`restore-dev-mode.sh`)
4. Confirm publish succeeded
5. Verify packages on npm
6. Test installation in clean environment

---

## Development vs. Production Builds

### During Development
- No build step - source runs directly
- `package.json` points to `src/index.ts`
- Fast iteration, no build cache issues

### During Publish
1. `build-packages.sh` compiles TypeScript to `dist/`
2. `prepare-for-publish.sh` modifies package.json:
   - `"main": "src/index.ts"` → `"main": "dist/index.js"`
   - `"types": "src/index.ts"` → `"types": "dist/index.d.ts"`
   - `"files": ["src/**/*"]` → `"files": ["dist/**/*"]`
3. Lerna publishes
4. `restore-dev-mode.sh` reverts package.json (preserving version bumps)

---

## Breaking Changes

### Before Release

**If breaking changes exist:**
1. Identify breaking changes in recent commits
2. Flag for human review
3. Confirm major version increment is needed
4. Update changelog or release notes

### Rules

**Always:**
- Favor breaking changes over technical debt
- Increment major semver for breaking changes
- Document breaking changes in release notes

**Never:**
- Don't create backward-compatible shims to avoid breaking changes
- Don't hide breaking changes in minor version bumps

---

## Intra-Package Dependencies

All packages share the same version number:
- Prevents version drift
- Simplifies dependency management
- Enables coordinated breaking changes

Package dependencies use `"*"` during development:
```json
{
  "dependencies": {
    "@lumenize/core": "*"
  }
}
```

Lerna resolves these to actual versions during publish.

---

## Checklist

### Always:
- Run dry run before actual release
- Ensure clean git state
- Test in clean environment after publish
- Flag breaking changes for major version increment

### Never:
- Don't publish with uncommitted changes
- Don't skip dry run
- Don't manually modify package.json for versioning (Lerna does this)
