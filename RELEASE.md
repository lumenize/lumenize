# Lumenize Release Process

This document describes how to release new versions of the Lumenize packages to npm.

## Prerequisites

- Clean git working directory (no uncommitted changes)
- npm authentication configured (`npm whoami` should work)
- On the `main` branch (recommended)

## Release Commands

### Dry Run (Safe Testing)

Before performing a real release, always test with a dry-run:

```bash
npm run release:dry-run
```

This will:
1. Run all package tests (rpc, testing, utils)
2. Run all doc-tests
3. Build all packages
4. Simulate version bump (shows what would happen)
5. Simulate npm publish (no actual publish)
6. Restore dev mode

### Full Release

To perform an actual release:

```bash
npm run release
```

This will:
1. ✅ Check for clean git state (fails if uncommitted changes)
2. 🧪 Run all package tests (blocks if any fail)
3. 📝 Run all doc-tests (blocks if any fail)
4. 🔨 Build all packages to `dist/`
5. 📦 Update package.json to point to `dist/` (temporary)
6. 🏷️  **Interactive**: Prompt for version bump type (patch/minor/major/custom)
7. 📤 Publish to npm via Lerna
8. 🔄 Restore package.json to point to `src/` (back to dev mode)
9. 💾 Commit restored package.json files
10. 🚀 Push changes to git

## Version Bump Types

When prompted, choose:
- **patch** (0.8.0 → 0.8.1): Bug fixes, small changes
- **minor** (0.8.0 → 0.9.0): New features, backward compatible
- **major** (0.8.0 → 1.0.0): Breaking changes
- **custom**: Specify exact version (e.g., 1.0.0-beta.1)

## What Gets Published

The following packages are published to npm:
- `@lumenize/rpc` - RPC framework for Durable Objects
- `@lumenize/testing` - Integration testing framework
- `@lumenize/routing` - Utility functions

**Not published** (private or excluded):
- `@lumenize/testing-outdated` - Deprecated package
- `@lumenize/doc-testing` - Internal tooling
- `@lumenize/check-examples` - Internal tooling
- `@lumenize/website` - Documentation website

## Package Contents

Each published package includes:
- `dist/` - Compiled JavaScript (.js) and TypeScript declarations (.d.ts)
- `src/` - Source TypeScript files (for reference/debugging)
- `package.json` - Temporarily modified to point to `dist/` during publish

**After publish**: The `package.json` in git automatically reverts to point to `src/` for development.

## Website Deployment (Separate)

The documentation website is deployed separately from package releases:

```bash
cd website
npm run deploy
```

This:
- Builds the Docusaurus site
- Extracts doc-tests into `.mdx` files
- Deploys to Cloudflare Assets via `wrangler deploy`

**Note**: Website updates are independent of npm package releases.

## Rollback

If something goes wrong during the release:

1. The scripts automatically restore dev mode on failure
2. If manual rollback needed:
   ```bash
   ./scripts/restore-dev-mode.sh
   git checkout packages/*/package.json
   ```

## Build Scripts

Individual build scripts (for manual use):

- `./scripts/build-packages.sh` - Compile TypeScript to JavaScript
- `./scripts/prepare-for-publish.sh` - Build + update package.json for publish
- `./scripts/restore-dev-mode.sh` - Revert package.json to dev mode

## Testing Individual Packages

To test a single package:

```bash
cd packages/rpc
npm run test
```

To test a single doc-test:

```bash
cd doc-test/rpc/quick-start
npm run test
```

## Troubleshooting

### "You have uncommitted changes"
- Commit or stash your changes before releasing
- The script checks for clean git state to avoid conflicts

### Tests fail during release
- Fix the failing tests before releasing
- Use `npm run release:dry-run` to identify issues without publishing

### Package.json not restored
- Manually run: `./scripts/restore-dev-mode.sh`
- This restores all package.json files to point to `src/`

### Need to inspect package contents
- Use `npm pack` in a package directory to create a tarball
- Extract and inspect: `tar -xzf lumenize-rpc-0.8.0.tgz`

## Architecture Notes

### No-Build-During-Development
- Packages point to `src/` during development
- No build scripts in individual package.json files
- Builds only happen during release via centralized scripts

### Synchronized Versioning
- All packages share the same version number
- Lerna manages version bumps across all packages
- Prevents version drift and dependency mismatches

### AI-Friendly Design
- AI coding agents see `"main": "src/index.ts"` in package.json
- They don't think they need to build after every change
- Build complexity is hidden in `/scripts/` directory
